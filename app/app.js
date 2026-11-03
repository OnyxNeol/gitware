/**
 * Gitware web: a static app over GitHub's API.
 *
 * No server, no build step. The data path is deliberately short:
 *   tree API  -> which manifests the repository has
 *   raw API   -> the artefacts `gitware pages build` wrote
 *   commits   -> the Gitgram diff for the newest change
 *
 * A token is optional. It raises GitHub's anonymous rate limit and opens
 * private repositories; it is kept in localStorage and sent to api.github.com
 * only, never anywhere else.
 */

import {
  baseDirOf,
  commitUrl,
  commitsUrl,
  describeGitgramSummary,
  diffLines,
  parseRepoInput,
  rankManifests,
  rawUrl,
  repoLabel,
  repoUrl,
  summariseGitgramDiff,
  treeUrl,
} from "./api.js";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "gitware.token";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  context: null,
  ref: "",
  projects: [],
  selected: "",
  manifest: null,
  manifestPath: "",
  tab: "pcb",
  cache: new Map(),
};

// --- plumbing --------------------------------------------------------------

function setStatus(text, kind = "") {
  const node = $("gw-status");
  node.textContent = text;
  node.className = `gw-status${kind ? ` ${kind}` : ""}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

async function getJson(url) {
  if (state.cache.has(url)) return state.cache.get(url);
  const headers = { Accept: "application/vnd.github+json" };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const response = await fetch(url, { headers });
  if (response.status === 403 || response.status === 429) {
    const limited = response.headers.get("x-ratelimit-remaining") === "0";
    const error = new Error(
      limited
        ? "GitHub's anonymous rate limit is used up. Sign in with a token to continue."
        : "GitHub refused the request. A token with read access may be needed.",
    );
    error.kind = "limit";
    throw error;
  }
  if (response.status === 404) {
    const error = new Error("Not found. Check the name, or sign in if the repository is private.");
    error.kind = "missing";
    throw error;
  }
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  const body = await response.json();
  state.cache.set(url, body);
  return body;
}

async function getText(url) {
  if (state.cache.has(url)) return state.cache.get(url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not read ${url} (${response.status}).`);
  const text = await response.text();
  state.cache.set(url, text);
  return text;
}

// --- rendering helpers -----------------------------------------------------

function note(title, body, kind = "") {
  return `<div class="gw-note${kind ? ` ${kind}` : ""}"><b>${escapeHtml(title)}</b>${body}</div>`;
}

function chip(label, { color = "", pressed = false, title = "", onToggle } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gw-chip";
  button.setAttribute("aria-pressed", String(pressed));
  if (title) button.title = title;
  button.innerHTML = `${color ? `<span class="gw-dot" style="background:${escapeHtml(color)}"></span>` : ""}${escapeHtml(label)}`;
  if (onToggle) button.addEventListener("click", () => onToggle(button));
  return button;
}

function groupColor(group) {
  const shape = group.querySelector("[fill]");
  return shape?.getAttribute("fill") || "";
}

/** Inline an SVG so the page can act on its layers and nets. */
function mountSvg(svgText) {
  const holder = document.createElement("div");
  holder.className = "gw-canvas";
  holder.innerHTML = svgText;
  const svg = holder.querySelector("svg");
  if (!svg) throw new Error("That SVG did not parse.");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.setAttribute("role", "img");
  return holder;
}

function layerChips(canvas) {
  const host = document.createElement("div");
  host.className = "gw-chips";
  const groups = [...canvas.querySelectorAll("[data-layer]")];
  for (const group of groups) {
    const name = group.dataset.layer;
    host.append(
      chip(name, {
        color: groupColor(group),
        pressed: true,
        title: group.dataset.kind ? `${name} (${group.dataset.kind})` : name,
        onToggle: (button) => {
          const visible = button.getAttribute("aria-pressed") === "true";
          button.setAttribute("aria-pressed", String(!visible));
          group.hidden = visible;
        },
      }),
    );
  }
  return groups.length ? host : null;
}

function netChips(canvas, names) {
  if (!names.length) return null;
  const host = document.createElement("div");
  host.className = "gw-chips";
  let active = "";
  const clear = () => {
    delete canvas.dataset.highlight;
    canvas.querySelectorAll(".gw-hit").forEach((node) => node.classList.remove("gw-hit"));
    host.querySelectorAll(".gw-chip").forEach((node) => node.setAttribute("aria-pressed", "false"));
    active = "";
  };
  const all = chip("All nets", { pressed: true, onToggle: clear });
  host.append(all);
  for (const name of names) {
    host.append(
      chip(name, {
        pressed: false,
        onToggle: (button) => {
          if (active === name) return clear();
          clear();
          active = name;
          canvas.dataset.highlight = name;
          button.setAttribute("aria-pressed", "true");
          canvas.querySelectorAll(`[data-net="${cssEscape(name)}"]`).forEach((node) => node.classList.add("gw-hit"));
        },
      }),
    );
  }
  return host;
}

function cssEscape(value) {
  return window.CSS?.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

function panel(title, right = "") {
  const section = document.createElement("section");
  section.className = "gw-panel";
  section.innerHTML = `<header><span>${escapeHtml(title)}</span><span class="gw-spacer"></span><span>${right}</span></header>`;
  return section;
}

// --- data ------------------------------------------------------------------

async function openRepository(input) {
  const parsed = parseRepoInput(input);
  if (!parsed) {
    setStatus("Need owner/repo", "bad");
    return;
  }
  state.context = parsed;
  state.ref = parsed.ref;
  state.projects = [];
  state.manifest = null;
  state.manifestPath = "";
  state.cache.clear();

  const url = new URL(location.href);
  url.searchParams.set("repo", repoLabel(parsed));
  if (parsed.ref) url.searchParams.set("ref", parsed.ref);
  history.replaceState(null, "", url);

  setStatus("Reading repository...", "busy");
  $("gw-tabs").hidden = true;
  $("gw-view").innerHTML = "";

  try {
    const meta = await getJson(repoUrl(parsed));
    if (!state.ref) state.ref = meta.default_branch || "main";
    renderRail(meta);

    const tree = await getJson(treeUrl({ ...state.context, ref: state.ref }));
    const paths = (tree.tree || []).map((entry) => entry.path);
    state.projects = rankManifests(paths);
    state.gitgramFiles = paths.filter((path) => /\.gitgram(\.txt)?$/i.test(path));

    renderProjects();

    if (!state.projects.length) {
      $("gw-view").innerHTML = note(
        "No Gitware build in this repository",
        `<div>Build one and commit the output, then this page picks it up:</div>
         <pre class="mono" style="margin:8px 0 0;white-space:pre-wrap">gitware pages build hardware.gitgram --board layout.kicad_pcb --cname dist --out dist
git add dist &amp;&amp; git commit -m "hardware: build pages"</pre>`,
      );
      setStatus("No build found", "bad");
      return;
    }

    await selectProject(state.projects[0]);
    setStatus(`${repoLabel(parsed)} · ${state.ref}`);
  } catch (error) {
    setStatus(error.kind === "limit" ? "Rate limited" : "Failed", "bad");
    $("gw-view").innerHTML = note(
      error.kind === "limit" ? "GitHub rate limit reached" : "Could not read that repository",
      `<div>${escapeHtml(error.message)}</div>${error.kind === "limit" ? `<div style="margin-top:8px">The token stays in this browser and is only sent to api.github.com. A read-only token is enough.</div>` : ""}`,
      "bad",
    );
    if (error.kind === "limit") openTokenForm(true);
  }
}

async function selectProject(path) {
  state.selected = path;
  state.manifestPath = path;
  const base = baseDirOf(path);
  document.querySelectorAll("#gw-projects button.project").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.path === path));
  });

  setStatus("Loading build...", "busy");
  const manifest = JSON.parse(await getText(rawUrl({ ...state.context, ref: state.ref, path })));
  if (!Array.isArray(manifest.files)) throw new Error("That manifest has no file list.");
  state.manifest = manifest;
  state.base = base;
  $("gw-tabs").hidden = false;
  await renderTab(state.tab);
  setStatus(`${manifest.project || path} · ${manifest.files.length} files`);
}

function fileUrl(name) {
  return rawUrl({ ...state.context, ref: state.ref, path: `${state.base}${name}` });
}

function manifestFile(name) {
  return (state.manifest?.files || []).find((file) => file.path === name) || null;
}

// --- rail ------------------------------------------------------------------

function renderRail(meta) {
  const list = $("gw-links");
  list.innerHTML = "";
  const items = [
    ["Repository", `https://github.com/${state.context.owner}/${state.context.repo}`],
    ["Branch", `https://github.com/${state.context.owner}/${state.context.repo}/tree/${state.ref}`],
    ["Commits", `https://github.com/${state.context.owner}/${state.context.repo}/commits/${state.ref}`],
  ];
  if (meta.homepage) items.push(["Homepage", meta.homepage]);
  for (const [label, href] of items) {
    const li = document.createElement("li");
    li.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`;
    list.append(li);
  }
}

function renderProjects() {
  const list = $("gw-projects");
  list.innerHTML = "";
  if (!state.projects.length) {
    list.innerHTML = `<li class="mono" style="color:var(--muted)">no manifest</li>`;
    return;
  }
  for (const path of state.projects) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "project";
    button.dataset.path = path;
    button.innerHTML = `${escapeHtml(path.replace(/\/(manifest|gitware)\.json$/i, "") || "repository root")}<span class="path">${escapeHtml(path)}</span>`;
    button.addEventListener("click", () => selectProject(path));
    li.append(button);
    list.append(li);
  }
}

// --- tabs ------------------------------------------------------------------

function renderTabs() {
  for (const button of document.querySelectorAll("#gw-tabs button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
    button.onclick = () => {
      state.tab = button.dataset.tab;
      renderTabs();
      renderTab(state.tab);
    };
  }
}

async function renderTab(tab) {
  const view = $("gw-view");
  view.innerHTML = "";
  renderTabs();
  try {
    if (tab === "pcb") await renderBoard(view);
    else if (tab === "schematic") await renderCircuit(view);
    else if (tab === "files") renderFiles(view);
    else await renderGitgram(view);
  } catch (error) {
    view.innerHTML = note("Could not render this view", `<div>${escapeHtml(error.message)}</div>`, "bad");
  }
}

function summaryPanel() {
  const manifest = state.manifest;
  const section = panel("Design summary");
  const body = document.createElement("div");
  body.className = "gw-stats";
  const stats = [
    [manifest.project || "project", "name"],
    [state.manifestPath, "manifest"],
    [formatBytes(manifest.files.reduce((total, file) => total + (Number(file.bytes) || 0), 0)), "build size"],
    [String(manifest.files.length), "files"],
  ];
  if (manifest.built_at) stats.push([String(manifest.built_at).slice(0, 10), "built"]);
  body.innerHTML = stats.map(([value, label]) => `<div><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`).join("");
  section.append(body);

  if (manifest.url) {
    const link = document.createElement("div");
    link.style.padding = "0 12px 12px";
    link.innerHTML = `<a href="${escapeHtml(manifest.url)}" target="_blank" rel="noopener">Open the published site</a>`;
    section.append(link);
  }
  return section;
}

async function renderBoard(view) {
  if (!manifestFile("board.svg")) {
    view.innerHTML = note("This build has no PCB render", "Run <code>gitware pages build</code> with <code>--board</code> to include one.");
    return;
  }
  const canvas = mountSvg(await getText(fileUrl("board.svg")));
  const section = panel("PCB", escapeHtml(manifestFile("board.svg").bytes ? formatBytes(manifestFile("board.svg").bytes) : ""));
  section.append(canvas);
  const layers = layerChips(canvas);
  if (layers) section.append(layers);

  if (manifestFile("board.json")) {
    try {
      const board = await getJson(fileUrl("board.json"));
      const names = [...new Set((board.primitives || []).map((item) => item.net).filter(Boolean))].sort();
      const nets = netChips(canvas, names);
      if (nets) section.append(nets);
    } catch {
      // A missing board.json only costs the net highlight, not the render.
    }
  }
  view.append(section, summaryPanel());
}

async function renderCircuit(view) {
  if (!manifestFile("circuit.svg")) {
    view.innerHTML = note("This build has no schematic render", "The schematic comes from the project's <code>.gitgram</code> source.");
    return;
  }
  const canvas = mountSvg(await getText(fileUrl("circuit.svg")));
  const section = panel("Schematic");
  section.append(canvas);
  if (manifestFile("circuit.json")) {
    try {
      const circuit = await getJson(fileUrl("circuit.json"));
      const names = [...new Set((circuit.parts || []).map((part) => part.net).filter(Boolean))].sort();
      const nets = netChips(canvas, names);
      if (nets) section.append(nets);
    } catch {
      // Same trade-off as the PCB: highlighting is a bonus.
    }
  }
  view.append(section);
}

function renderFiles(view) {
  const section = panel("Files in this build");
  const rows = state.manifest.files
    .map(
      (file) => `<tr>
        <td><a href="${escapeHtml(fileUrl(file.path))}" target="_blank" rel="noopener">${escapeHtml(file.path)}</a></td>
        <td class="num">${escapeHtml(formatBytes(file.bytes))}</td>
      </tr>`,
    )
    .join("");
  section.insertAdjacentHTML(
    "beforeend",
    `<table><thead><tr><th>File</th><th style="text-align:right">Size</th></tr></thead><tbody>${rows}</tbody></table>`,
  );
  view.append(section, summaryPanel());
}

async function renderGitgram(view) {
  const files = state.gitgramFiles || [];
  if (!files.length) {
    view.innerHTML = note("No Gitgram sources", "A <code>.gitgram</code> file is the text-first circuit description Gitware diffs.");
    return;
  }

  const target = files[0];
  const commits = await getJson(commitsUrl({ ...state.context, ref: state.ref, path: target, perPage: 6 }));
  if (!commits.length) {
    view.innerHTML = note("No commits touch this circuit yet", escapeHtml(target));
    return;
  }

  const newest = commits[0];
  const section = panel(`Gitgram · ${target}`, `<span class="sha mono">${escapeHtml(newest.sha.slice(0, 7))}</span>`);

  const before = newest.parents?.length
    ? await getText(rawUrl({ ...state.context, ref: newest.parents[0].sha, path: target })).catch(() => "")
    : "";
  const after = await getText(rawUrl({ ...state.context, ref: newest.sha, path: target })).catch(() => "");

  const rows = diffLines(before, after).filter((row) => row.kind !== " ");
  const summary = summariseGitgramDiff(rows.map((row) => `${row.kind}${row.text}`).join("\n"));
  const description = describeGitgramSummary(summary);

  const badge = document.createElement("div");
  badge.style.padding = "10px 12px";
  badge.innerHTML = `<span class="gw-badge">${escapeHtml(description || "no structural change")}</span>
    <span class="mono" style="margin-left:10px;color:var(--muted)">${escapeHtml(newest.commit.message.split("\n")[0])}</span>`;
  section.append(badge);

  const pre = document.createElement("pre");
  pre.className = "diff mono";
  if (!rows.length) {
    pre.innerHTML = `<span class="ctx">no line changes in this commit</span>`;
  } else {
    pre.innerHTML = rows
      .map((row) => `<span class="${row.kind === "+" ? "add" : "del"}">${escapeHtml(row.text)}</span>`)
      .join("");
  }
  section.append(pre);

  const list = document.createElement("ul");
  list.className = "gw-commits";
  for (const commit of commits) {
    const li = document.createElement("li");
    li.innerHTML = `<a class="sha" href="${escapeHtml(commitUrl({ ...state.context, sha: commit.sha }))}" target="_blank" rel="noopener">${escapeHtml(commit.sha.slice(0, 7))}</a>
      <span class="msg">${escapeHtml(commit.commit.message.split("\n")[0])}</span>
      <span class="sha">${escapeHtml(new Date(commit.commit.author?.date || Date.now()).toISOString().slice(0, 10))}</span>`;
    list.append(li);
  }
  const history = panel(`Commits touching ${target}`);
  history.append(list);
  view.append(section, history);
}

// --- token -----------------------------------------------------------------

function openTokenForm(open) {
  $("gw-token-form").hidden = !open;
  $("gw-token").value = "";
  if (open) $("gw-token").focus();
}

function applyToken(token) {
  state.token = token.trim();
  if (state.token) localStorage.setItem(TOKEN_KEY, state.token);
  else localStorage.removeItem(TOKEN_KEY);
  state.cache.clear();
  $("gw-token-toggle").textContent = state.token ? "Sign out" : "Sign in";
  openTokenForm(false);
  if (state.context) openRepository(repoLabel(state.context));
}

// --- boot ------------------------------------------------------------------

function boot() {
  $("gw-form").addEventListener("submit", (event) => {
    event.preventDefault();
    openRepository($("gw-repo").value);
  });

  $("gw-token-toggle").addEventListener("click", () => {
    if (state.token) applyToken("");
    else openTokenForm($("gw-token-form").hidden);
  });

  $("gw-token-form").addEventListener("submit", (event) => {
    event.preventDefault();
    applyToken($("gw-token").value);
  });

  if (state.token) $("gw-token-toggle").textContent = "Sign out";

  renderTabs();

  const params = new URLSearchParams(location.search);
  const requested = params.get("repo") || "OnyxNeol/gitware";
  const ref = params.get("ref") || "";
  $("gw-repo").value = requested;
  openRepository(ref ? `${requested}${requested.includes("/tree/") ? "" : `/tree/${ref}`}` : requested);
}

boot();
