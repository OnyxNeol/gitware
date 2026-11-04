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
  cloudCall,
  cloudText,
  commitUrl,
  commitsUrl,
  describeGitgramSummary,
  diffLines,
  newWriteToken,
  oauthAuthorizeUrl,
  parseRepoInput,
  proxyRequest,
  rankManifests,
  rawUrl,
  repoLabel,
  repoUrl,
  slugify,
  summariseGitgramDiff,
  treeUrl,
} from "./api.js?v=6";

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = "gitware.token";
const SESSION_KEY = "gitware.session";

const state = {
  token: localStorage.getItem(TOKEN_KEY) || "",
  session: localStorage.getItem(SESSION_KEY) || "",
  identity: null,
  oauth: null,
  context: null,
  ref: "",
  projects: [],
  selected: "",
  manifest: null,
  manifestPath: "",
  cloudSlug: "",
  tab: "pcb",
  cache: new Map(),
  files: null,
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

/**
 * Read a GitHub URL through the backend, as the signed-in user.
 *
 * Returns null when there is no OAuth session, or the URL is not one the proxy
 * understands, which sends the caller back to a direct fetch.
 */
async function sessionRead(url) {
  if (!state.session) return null;
  const mapped = proxyRequest(url);
  if (!mapped) return null;
  try {
    if (mapped.action === "file") {
      return { text: await cloudText("github", { ...mapped, session: state.session }) };
    }
    const result = await cloudCall("github", { ...mapped, session: state.session });
    if (!result.ok) return null;
    return { json: result.data };
  } catch {
    return null;
  }
}

async function getJson(url) {
  if (state.cache.has(url)) return state.cache.get(url);
  const proxied = await sessionRead(url);
  if (proxied) {
    const value = proxied.json !== undefined ? proxied.json : JSON.parse(proxied.text);
    state.cache.set(url, value);
    return value;
  }
  if (state.files?.has(url)) {
    const parsed = JSON.parse(state.files.get(url));
    state.cache.set(url, parsed);
    return parsed;
  }
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
  const proxied = await sessionRead(url);
  if (proxied) {
    const value = proxied.text !== undefined ? proxied.text : JSON.stringify(proxied.json);
    state.cache.set(url, value);
    return value;
  }
  if (state.files?.has(url)) return state.files.get(url);
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
  state.cloudSlug = "";
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
    state.gitgramFiles = paths.filter((path) => /\.gitgram(\.txt)?$/i.test(path));

    // A repository can contain manifests that are not builds (a simulator
    // descriptor, for instance). Fetch them once, keep the ones with a file
    // list, and reuse the parse when a project is opened.
    const usable = [];
    for (const path of rankManifests(paths)) {
      try {
        const candidate = JSON.parse(await getText(rawUrl({ ...state.context, ref: state.ref, path })));
        if (Array.isArray(candidate.files) && candidate.files.length) usable.push(path);
      } catch {
        // Unreadable manifest: leave it out rather than offering a dead link.
      }
    }
    state.projects = usable;

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

  const inProject = files.filter((path) => path.startsWith(state.base || "\u0000"));
  const target = (inProject.length ? inProject : files)[0];

  // A saved project is a snapshot: there are no earlier commits to diff
  // against, so show the current source and say so plainly.
  if (state.cloudSlug) {
    const source = await getText(fileUrl(target));
    const section = panel(`Gitgram · ${target}`, `<span class="mono">saved snapshot</span>`);
    const pre = document.createElement("pre");
    pre.className = "mono";
    pre.style.cssText = "margin:0;padding:12px;overflow:auto;max-height:58vh;white-space:pre-wrap;font-size:12px;line-height:1.5";
    pre.textContent = source;
    section.append(pre);
    view.append(section);
    view.insertAdjacentHTML(
      "beforeend",
      note("Diffs need the repository", "A saved copy holds the current source, not the history. Open the repository to see what each commit changed."),
    );
    return;
  }
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


// --- GitHub sign-in (device flow) ------------------------------------------
//
// Deliberately secretless: the device flow needs only the app's public client
// id, so there is no client_secret to store, and no redirect URI to keep in
// sync. The user reads a short code on screen and types it into GitHub; the
// browser polls until GitHub approves, and only a session id comes back.

const DEVICE = { device_code: "", interval: 5000, timer: 0, expires: 0 };

async function deviceConfig() {
  if (state.oauth) return state.oauth;
  try {
    state.oauth = await cloudCall("device", { op: "config" });
  } catch {
    state.oauth = { configured: false, client_id: "" };
  }
  return state.oauth;
}

function showSignIn(html) {
  $("gw-signin-body").innerHTML = html;
  $("gw-signin").hidden = false;
}

function closeSignIn() {
  clearTimeout(DEVICE.timer);
  DEVICE.timer = 0;
  DEVICE.device_code = "";
  $("gw-signin").hidden = true;
}

/** Open the panel: either the one-time client id step, or the code itself. */
async function openSignIn() {
  const config = await deviceConfig();
  if (!config.configured) {
    const here = location.origin + location.pathname;
    showSignIn(`
      <p>GitHub sign-in runs on the device flow, so no client secret exists anywhere. One public id is needed, once.</p>
      <ol class="gw-steps">
        <li>Open <a href="https://github.com/settings/applications/new" target="_blank" rel="noopener">New OAuth App</a></li>
        <li>Name: <b>Gitware</b>, homepage <code>${escapeHtml(here)}</code></li>
        <li>Tick <b>Enable Device Flow</b>, then <b>Create</b></li>
        <li>Paste the <b>Client ID</b> below (it is public, not a secret)</li>
      </ol>
      <form id="gw-client-form" class="gw-token-row">
        <input id="gw-client-id" placeholder="Iv1.0123456789abcdef" spellcheck="false" autocomplete="off" aria-label="GitHub client id">
        <button class="primary" type="submit">Save</button>
      </form>
      <p class="gw-bad" id="gw-client-error" hidden></p>`);

    $("gw-client-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const value = $("gw-client-id").value.trim();
      try {
        state.oauth = await cloudCall("device", { op: "save", client_id: value });
        await startDevice();
      } catch (error) {
        const box = $("gw-client-error");
        box.textContent = error.message;
        box.hidden = false;
      }
    });
    return;
  }
  await startDevice();
}

async function startDevice() {
  clearTimeout(DEVICE.timer);
  showSignIn(`<p>Asking GitHub for a code...</p>`);
  try {
    const result = await cloudCall("device", { op: "start" });
    if (!result.ok) throw new Error(result.error || "GitHub did not answer");
    DEVICE.device_code = result.device_code;
    DEVICE.interval = Math.max(5, Number(result.interval) || 5) * 1000;
    DEVICE.expires = Date.now() + (Number(result.expires_in) || 900) * 1000;
    showSignIn(`
      <p>Enter this code on GitHub to approve the sign-in:</p>
      <p class="gw-code">${escapeHtml(result.user_code)}</p>
      <p><a class="primary gw-button-link" href="${escapeHtml(result.verification_uri)}" target="_blank" rel="noopener">Open github.com/login/device</a></p>
      <p class="gw-muted" id="gw-device-status">Waiting for approval...</p>`);
    // The link stays available in the panel if a popup blocker ate the tab.
    window.open(result.verification_uri, "_blank", "noopener");
    pollDevice();
  } catch (error) {
    showSignIn(`<p class="gw-bad">${escapeHtml(error.message)}</p>
      <p class="gw-muted">If this says the device flow is unavailable, tick <b>Enable Device Flow</b> in the OAuth app settings.</p>`);
  }
}

async function pollDevice() {
  if (!DEVICE.device_code) return;
  if (Date.now() > DEVICE.expires) {
    showSignIn(`<p class="gw-bad">That code expired. Start again.</p>`);
    return;
  }
  DEVICE.timer = setTimeout(async () => {
    try {
      const result = await cloudCall("device", { op: "poll", device_code: DEVICE.device_code });
      if (result.pending) {
        pollDevice();
        return;
      }
      state.session = result.session;
      state.identity = result;
      localStorage.setItem(SESSION_KEY, result.session);
      state.cache.clear();
      renderIdentity();
      closeSignIn();
      setStatus(`Signed in as ${result.login}`, "ok");
      if (state.context && state.context.owner !== "cloud") openRepository(repoLabel(state.context));
      else if (state.cloudSlug) openCloud(state.cloudSlug);
    } catch (error) {
      showSignIn(`<p class="gw-bad">${escapeHtml(error.message)}</p>`);
    }
  }, DEVICE.interval);
}

async function signOut() {
  const session = state.session;
  state.session = "";
  state.identity = null;
  localStorage.removeItem(SESSION_KEY);
  state.cache.clear();
  renderIdentity();
  setStatus("Signed out");
  if (session) {
    try {
      await cloudCall("oauth", { op: "signout", session });
    } catch {
      // A failed sign-out still clears this browser; the session expires anyway.
    }
  }
  if (state.context && state.context.owner !== "cloud") openRepository(repoLabel(state.context));
  else if (state.cloudSlug) openCloud(state.cloudSlug);
}

function renderIdentity() {
  const button = $("gw-github");
  if (button) button.textContent = state.identity ? `@${state.identity.login}` : "Sign in with GitHub";
  const avatar = $("gw-avatar");
  if (avatar) {
    avatar.hidden = !state.identity?.avatar;
    if (state.identity?.avatar) {
      avatar.src = state.identity.avatar;
      avatar.alt = state.identity.login;
    }
  }
}

/** Confirm a stored session is still good, and show who it belongs to. */
async function refreshIdentity() {
  await deviceConfig();
  if (state.session) {
    try {
      state.identity = await cloudCall("oauth", { op: "whoami", session: state.session });
    } catch {
      state.session = "";
      state.identity = null;
      localStorage.removeItem(SESSION_KEY);
    }
  }
  renderIdentity();
}

// --- Gitware Cloud ---------------------------------------------------------

const CLOUD_TOKEN_KEY = "gitware.cloudtoken";

/** The write token for saved projects. Generated once, never leaves the browser except as a hash. */
function cloudToken() {
  let token = localStorage.getItem(CLOUD_TOKEN_KEY);
  if (!token) {
    token = newWriteToken();
    localStorage.setItem(CLOUD_TOKEN_KEY, token);
  }
  return token;
}

/**
 * Open a project that lives in the backend rather than in a repository.
 *
 * The payload is the same set of files a build produces, so everything below
 * this point renders it exactly like a checked-out project: the PCB, the
 * schematic, the Gitgram and the file table all read from the snapshot.
 */
async function openCloud(slug) {
  setStatus("Opening saved project...", "busy");
  state.cache.clear();
  state.files = new Map();
  $("gw-tabs").hidden = true;
  $("gw-view").innerHTML = "";

  try {
    const result = await cloudCall("projects", { op: "get", slug, token: cloudToken() });
    state.cloudSlug = slug;
    const project = result.project || {};
    const payload = project.payload || {};
    const names = Object.keys(payload);
    if (!names.length) throw new Error("That project was saved without file contents.");

    state.context = { owner: "cloud", repo: slug, ref: "" };
    state.ref = "";
    state.base = "";
    state.projects = ["manifest.json"];
    state.selected = "manifest.json";
    state.manifestPath = "manifest.json";

    // fileUrl() is the lookup key everywhere else, so store under the same key.
    for (const name of names) {
      const value = payload[name];
      state.files.set(fileUrl(name), typeof value === "string" ? value : JSON.stringify(value));
    }
    state.gitgramFiles = names.filter((name) => /\.gitgram(\.txt)?$/i.test(name));

    const manifestText = state.files.get(fileUrl("manifest.json"));
    if (!manifestText) throw new Error("That project has no manifest.json.");
    const manifest = JSON.parse(manifestText);
    if (!Array.isArray(manifest.files)) throw new Error("That manifest has no file list.");

    state.manifest = manifest;
    $("gw-projects").innerHTML = `<li><button type="button" class="project" aria-current="true">${escapeHtml(project.title || slug)}<span class="path">saved · ${escapeHtml(project.visibility || "public")}</span></button></li>`;
    $("gw-links").innerHTML = `<li><a href="?cloud=${encodeURIComponent(slug)}" target="_blank" rel="noopener">Permalink</a></li>
      <li class="mono" style="color:var(--muted)">updated ${escapeHtml(String(project.updated || "").slice(0, 16).replace("T", " "))}</li>`;

    const url = new URL(location.href);
    url.searchParams.set("cloud", slug);
    url.searchParams.delete("repo");
    history.replaceState(null, "", url);

    $("gw-tabs").hidden = false;
    await renderTab(state.tab);
    setStatus(`${project.title || slug} · saved copy`);
  } catch (error) {
    setStatus("Could not open that project", "bad");
    $("gw-view").innerHTML = note("Could not open that project", `<div>${escapeHtml(error.message)}</div>`, "bad");
  }
}

/** Copy the open build into the backend so it can be reopened without the repository. */
async function saveCloud() {
  if (!state.manifest) {
    setStatus("Nothing to save yet", "bad");
    return;
  }
  const title = state.manifest.project || state.context?.repo || "Untitled board";
  const slug = slugify(title) || "board";
  setStatus("Saving to the backend...", "busy");

  try {
    const payload = { "manifest.json": JSON.stringify(state.manifest) };
    for (const file of state.manifest.files || []) {
      try {
        const isJson = /\.json$/i.test(file.path);
        payload[file.path] = isJson ? JSON.stringify(await getJson(fileUrl(file.path))) : await getText(fileUrl(file.path));
      } catch {
        // A file that will not read is left out; the rest of the project still saves.
      }
    }

    const result = await cloudCall("projects", {
      op: "save",
      slug,
      title,
      description: state.manifest.description || "",
      visibility: "public",
      source: state.context?.owner === "cloud" ? "" : repoLabel(state.context || { owner: "", repo: "" }),
      ref: state.ref,
      token: cloudToken(),
      payload,
    });

    setStatus(`${result.created ? "Saved" : "Updated"} · ${slug}`, "ok");
    renderCloud();
  } catch (error) {
    setStatus("Could not save", "bad");
    $("gw-view").insertAdjacentHTML(
      "afterbegin",
      note("Could not save to the backend", `<div>${escapeHtml(error.message)}</div>`, "bad"),
    );
  }
}

/** The saved-project list, fetched from the backend rather than GitHub. */
async function renderCloud() {
  const list = $("gw-cloud");
  if (!list) return;
  try {
    const result = await cloudCall("projects", { op: "list" });
    const projects = result.projects || [];
    if (!projects.length) {
      list.innerHTML = `<li class="mono" style="color:var(--muted)">nothing saved yet</li>`;
      return;
    }
    list.innerHTML = "";
    for (const project of projects) {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "project";
      button.innerHTML = `${escapeHtml(project.title || project.slug)}<span class="path">${escapeHtml(project.slug)} · ${escapeHtml(formatBytes(project.size_bytes))}</span>`;
      button.addEventListener("click", () => openCloud(project.slug));
      li.append(button);
      list.append(li);
    }
  } catch {
    list.innerHTML = `<li class="mono" style="color:var(--muted)">backend unreachable</li>`;
  }
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
  $("gw-save")?.addEventListener("click", saveCloud);
  $("gw-github")?.addEventListener("click", () => {
    if (state.identity) signOut();
    else openSignIn();
  });
  $("gw-signin-close")?.addEventListener("click", closeSignIn);
  renderCloud();
  refreshIdentity();

  renderTabs();

  const params = new URLSearchParams(location.search);
  const requested = params.get("repo") || "OnyxNeol/gitware";
  const ref = params.get("ref") || "";
  $("gw-repo").value = requested;

  const cloudSlug = params.get("cloud");
  if (cloudSlug) {
    $("gw-repo").value = `saved:${cloudSlug}`;
    openCloud(cloudSlug);
    return;
  }

  openRepository(ref ? `${requested}${requested.includes("/tree/") ? "" : `/tree/${ref}`}` : requested);
}

boot();
