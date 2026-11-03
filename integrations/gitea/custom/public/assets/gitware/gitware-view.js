/**
 * The Hardware view inside Gitea.
 *
 * Design notes, all of them deliberate:
 *  * data comes from Gitea's own raw-file route, so private repositories work
 *    with the session the browser already has (no token prompt, no CORS);
 *  * nothing is re-rendered client-side that Gitware already rendered at build
 *    time — the board and schematic SVGs come from `gitware pages build`, so
 *    the repository stays the single source of truth;
 *  * failures are reported the way Gitea reports them (a bordered message with
 *    the command that fixes it), never as a blank panel.
 */

import {
  candidateManifests,
  formatBytes,
  parseAppSubUrl,
  parseRepoContext,
  rankManifests,
  rawFileUrl,
  treeApiUrl,
} from "./gitware-context.js";

const $ = (id) => document.getElementById(id);

async function fetchText(url) {
  const response = await fetch(url, { credentials: "same-origin", headers: { Accept: "*/*" } });
  if (!response.ok) {
    const error = new Error(`${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

/**
 * Every build location worth trying, best first.
 *
 * Gitea's tree API lists the whole repository when the reader may see it, which
 * is how a Pages layout (`p/<slug>/manifest.json`) is discovered. When the API
 * says no, the static candidates still cover the layouts a single project uses,
 * and they are answered from the same raw route the rest of the page uses.
 */
async function manifestCandidates(context) {
  const known = manifestPaths();
  try {
    const response = await fetch(treeApiUrl(context), {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (response.ok) {
      const tree = await response.json();
      const listed = (tree.tree || []).map((entry) => entry.path);
      const ranked = rankManifests(listed);
      if (ranked.length) return ranked;
    }
  } catch {
    // A private repository or a proxy that blocks the API: probe instead.
  }
  return known;
}

/** Try each build location; Gitea answers 404 for the ones that are absent. */
async function locateManifest(context) {
  for (const path of await manifestCandidates(context)) {
    const url = rawFileUrl({ ...context, path });
    try {
      const manifest = await fetchJson(url);
      if (manifest && Array.isArray(manifest.files)) {
        return { path, url, manifest, base: path.slice(0, path.lastIndexOf("/") + 1) };
      }
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return null;
}

/**
 * A repository that has never been built still has its sources, so the empty
 * state can name them instead of saying "nothing here".
 */
function manifestPaths() {
  return candidateManifests([
    "dist/pages/manifest.json",
    "dist/manifest.json",
    "pages/manifest.json",
    "gitware/manifest.json",
    "manifest.json",
  ]);
}

function fileEntry(manifest, name) {
  return manifest.files.find((file) => file.path === name) || null;
}

function showEmpty(html) {
  const box = $("gw-empty");
  box.innerHTML = html;
  box.hidden = false;
}

function showError(message, detail) {
  const box = $("gw-empty");
  box.className = "gw-empty gw-error";
  box.innerHTML = `<b>${escapeHtml(message)}</b>${detail ? `<div>${escapeHtml(detail)}</div>` : ""}`;
  box.hidden = false;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stat(label, value) {
  return `<div class="gw-stat"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
}

/** Inline an SVG so page CSS (theme, highlight, layer toggles) can act on it. */
async function mountSvg(containerId, url) {
  const text = await fetchText(url);
  const holder = $(containerId);
  holder.innerHTML = text;
  const svg = holder.querySelector("svg");
  if (svg) {
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("role", "img");
  }
  return holder;
}

function chip(label, { color, pressed = true, onToggle, title } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "gw-chip";
  button.setAttribute("aria-pressed", String(pressed));
  if (title) button.title = title;
  button.innerHTML = `${color ? `<span class="gw-dot" style="background:${escapeHtml(color)}"></span>` : ""}${escapeHtml(label)}`;
  if (onToggle) button.addEventListener("click", () => onToggle(button));
  return button;
}

/** Layer toggles: Gitea users expect the chips to look like repo filter chips. */
function mountLayerChips(containerId, canvas) {
  const host = $(containerId);
  host.textContent = "";
  const groups = [...canvas.querySelectorAll("[data-layer]")];
  for (const group of groups) {
    const name = group.dataset.layer;
    const kind = group.dataset.kind || "";
    const button = chip(name, {
      color: groupKindColor(group),
      title: kind ? `${name} (${kind})` : name,
      onToggle: (element) => {
        const visible = element.getAttribute("aria-pressed") === "true";
        element.setAttribute("aria-pressed", String(!visible));
        group.hidden = visible;
      },
    });
    host.append(button);
  }
  return groups.length;
}

function groupKindColor(group) {
  const shape = group.querySelector("[fill]");
  return shape?.getAttribute("fill") || "";
}

/** Net highlight: click a net, everything else fades, like an EDA net browser. */
function mountNetChips(containerId, canvas) {
  const host = $(containerId);
  host.textContent = "";
  const names = [...new Set([...canvas.querySelectorAll("[data-net]")].map((n) => n.dataset.net))]
    .filter(Boolean)
    .sort();
  if (!names.length) {
    host.hidden = true;
    return 0;
  }
  host.hidden = false;
  let active = null;
  const clear = () => {
    delete canvas.dataset.highlight;
    canvas.querySelectorAll(".gw-hit").forEach((n) => n.classList.remove("gw-hit"));
    host.querySelectorAll(".gw-chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
    active = null;
  };
  const all = chip("All nets", {
    pressed: true,
    onToggle: () => clear(),
  });
  all.setAttribute("aria-pressed", "true");
  host.append(all);
  for (const name of names) {
    host.append(
      chip(name, {
        pressed: false,
        onToggle: (element) => {
          if (active === name) {
            clear();
            return;
          }
          clear();
          active = name;
          canvas.dataset.highlight = name;
          element.setAttribute("aria-pressed", "true");
          canvas
            .querySelectorAll(`[data-net="${cssEscape(name)}"]`)
            .forEach((node) => node.classList.add("gw-hit"));
        },
      }),
    );
  }
  return names.length;
}

function cssEscape(value) {
  return window.CSS && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
}

async function main() {
  const appSubUrl = parseAppSubUrl(location.href);
  const context = parseRepoContext({
    search: location.search,
    pathname: location.pathname,
    appSubUrl,
  });

  if (!context.complete) {
    showError(
      "Open this page from a repository",
      "Use the Hardware tab on any repository, or pass ?owner=<user>&repo=<name>&ref=<branch>.",
    );
    return;
  }

  const repoName = `${context.owner}/${context.repo}`;
  $("gw-repo").textContent = repoName;
  $("gw-ref").textContent = context.ref;
  $("gw-ref").hidden = false;
  const repoLink = $("gw-open-source");
  repoLink.href = `${appSubUrl}/${encodeURIComponent(context.owner)}/${encodeURIComponent(context.repo)}`;

  let located;
  try {
    located = await locateManifest({ ...context, appSubUrl });
  } catch (error) {
    showError("Could not read this repository", `${error.message}. Check that you are signed in and have read access.`);
    return;
  }

  if (!located) {
    showEmpty(
      `<b>No Gitware build in this repository</b>
       <div style="margin-top:8px">Build one and commit it:</div>
       <div style="margin-top:6px"><code>gitware pages build hardware.gitgram --board layout.kicad_pcb --cname dist --out dist</code></div>
       <div style="margin-top:6px">then <code>git add dist &amp;&amp; git commit</code>. The Hardware tab picks it up on the next push.</div>`,
    );
    return;
  }

  const { manifest, base } = located;
  const fileUrl = (path) => rawFileUrl({ ...context, appSubUrl, path: `${base}${path}` });

  if (manifest.url && /^https?:\/\//.test(manifest.url)) {
    const pages = $("gw-open-pages");
    pages.href = manifest.url;
    pages.hidden = false;
  }

  const panels = $("gw-panels");

  // --- PCB -----------------------------------------------------------------
  const boardFile = fileEntry(manifest, "board.svg");
  if (boardFile) {
    try {
      const canvas = await mountSvg("gw-board", fileUrl("board.svg"));
      mountLayerChips("gw-board-layers", canvas);
      const boardJson = fileEntry(manifest, "board.json");
      if (boardJson) {
        const board = await fetchJson(fileUrl("board.json"));
        const netNames = [...new Set((board.primitives || []).map((p) => p.net).filter(Boolean))];
        const host = $("gw-board-nets");
        host.textContent = "";
        for (const name of netNames.sort()) {
          host.append(
            chip(name, {
              pressed: false,
              onToggle: (element) => {
                const active = canvas.dataset.highlight === name;
                delete canvas.dataset.highlight;
                canvas.querySelectorAll(".gw-hit").forEach((n) => n.classList.remove("gw-hit"));
                host.querySelectorAll(".gw-chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
                if (!active) {
                  canvas.dataset.highlight = name;
                  element.setAttribute("aria-pressed", "true");
                  canvas.querySelectorAll(`[data-net="${cssEscape(name)}"]`).forEach((n) => n.classList.add("gw-hit"));
                }
              },
            }),
          );
        }
        if (board.bounds) {
          $("gw-board-dims").textContent =
            `${board.bounds.width.toFixed(1)} × ${board.bounds.height.toFixed(1)} mm`;
        }
      }
      $("gw-board-panel").hidden = false;
      panels.hidden = false;
    } catch (error) {
      showError("The PCB render could not be loaded", error.message);
    }
  }

  // --- Schematic -----------------------------------------------------------
  const circuitFile = fileEntry(manifest, "circuit.svg");
  if (circuitFile) {
    try {
      const canvas = await mountSvg("gw-circuit", fileUrl("circuit.svg"));
      const nets = mountNetChips("gw-circuit-nets", canvas);
      $("gw-circuit-dims").textContent = nets ? `${nets} net${nets === 1 ? "" : "s"}` : "";
      $("gw-circuit-panel").hidden = false;
      panels.hidden = false;
    } catch (error) {
      showError("The schematic render could not be loaded", error.message);
    }
  }

  // --- Summary -------------------------------------------------------------
  const stats = [];
  if (manifest.circuit) {
    stats.push(stat("parts", manifest.circuit.parts));
    stats.push(stat("pins", manifest.circuit.pins));
    stats.push(stat("nets", manifest.circuit.nets));
    stats.push(stat("connections", manifest.circuit.connections));
  }
  if (manifest.board) {
    stats.push(stat("layers", manifest.board.layers));
    stats.push(stat("tracks", manifest.board.tracks));
    stats.push(stat("pads", manifest.board.pads));
    stats.push(stat("holes", manifest.board.holes));
  }
  if (!stats.length && manifest.files.length) {
    stats.push(stat("files", manifest.files.length));
  }
  if (stats.length) {
    $("gw-stats").innerHTML = stats.join("");
    const size = manifest.files.reduce((total, file) => total + (Number(file.bytes) || 0), 0);
    const note = document.createElement("p");
    note.className = "gw-note";
    note.textContent = `Built by ${manifest.generator || "gitware"} ${manifest.version || ""}`.trim() +
      ` · ${manifest.files.length} files · ${formatBytes(size)}`;
    $("gw-stats").after(note);
    $("gw-summary-panel").hidden = false;
  }
  if (manifest.firmware && manifest.firmware.machine) {
    const firmware = $("gw-firmware");
    firmware.textContent = `Firmware: ${manifest.firmware.name || "firmware"} for ${manifest.firmware.machine}` +
      (manifest.firmware.frequency_hz ? ` at ${(manifest.firmware.frequency_hz / 1e6).toFixed(1)} MHz` : "") +
      " · the simulator runs in the published site and in the desktop app.";
    firmware.hidden = false;
  }
}

main().catch((error) => {
  console.error("[gitware]", error);
  showError("The Hardware view failed to start", error.message);
});
