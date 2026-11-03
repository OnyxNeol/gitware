/**
 * Live integration check: drives the viewer's own modules against a running
 * Gitea, using exactly the requests the browser makes.
 *
 *   GITEA_BASE=http://127.0.0.1:3000 node test/live-viewer.mjs <owner> <repo> [ref]
 *
 * It is deliberately not a unit test: it proves the Gitea routes, the raw-file
 * endpoint, the tree API and the manifest layout all agree with what the page
 * asks for. Nothing here touches the DOM.
 */

import {
  formatBytes,
  parseAppSubUrl,
  parseRepoContext,
  rankManifests,
  rawFileUrl,
  treeApiUrl,
  viewerHref,
} from "../custom/public/assets/gitware/gitware-context.js";

const base = (process.env.GITEA_BASE || "http://127.0.0.1:3000").replace(/\/+$/, "");
const [owner = "onyx", repo = "hw", ref = "main"] = process.argv.slice(2);

const pageUrl = new URL(viewerHref({ appSubUrl: "", owner, repo, ref }), base);
const appSubUrl = parseAppSubUrl(pageUrl.href);
const context = parseRepoContext({
  search: pageUrl.search,
  pathname: pageUrl.pathname,
  appSubUrl,
});

let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

check("viewer page resolves", pageUrl.pathname.endsWith("/assets/gitware/gitware.html"), pageUrl.pathname);
check("context is complete", context.complete, JSON.stringify(context));

const page = await fetch(pageUrl);
check("viewer page served", page.status === 200, `HTTP ${page.status}`);
const html = await page.text();
check("page loads the viewer module", html.includes('src="gitware-view.js"'));
check("page links Gitea's own stylesheet", html.includes('href="../../assets/css/index.css"'));

const stylesheet = await fetch(new URL("../../assets/css/index.css", pageUrl));
check("theme stylesheet reachable from the page", stylesheet.status === 200, `HTTP ${stylesheet.status}`);

// What manifestCandidates() does in the browser.
let candidates = [];
const tree = await fetch(new URL(treeApiUrl({ ...context, appSubUrl }), base), {
  headers: { Accept: "application/json" },
});
if (tree.ok) {
  const listing = await tree.json();
  candidates = rankManifests((listing.tree || []).map((entry) => entry.path));
  check("tree API lists the repository", candidates.length > 0, `${(listing.tree || []).length} entries`);
} else {
  candidates = rankManifests(["dist/manifest.json", "manifest.json"]);
  check("tree API answered", false, `HTTP ${tree.status}, falling back to static probes`);
}

let manifest = null;
let baseDir = "";
for (const path of candidates) {
  const url = new URL(rawFileUrl({ ...context, appSubUrl, path }), base);
  const response = await fetch(url);
  if (!response.ok) continue;
  const candidate = await response.json();
  if (!Array.isArray(candidate.files)) continue;
  manifest = candidate;
  baseDir = path.slice(0, path.lastIndexOf("/") + 1);
  console.log(`     manifest: ${path} (${manifest.project}, ${manifest.files.length} files)`);
  break;
}
check("a usable manifest was found", Boolean(manifest));
if (!manifest) process.exit(1);

const wanted = ["board.svg", "circuit.svg", "board.json", "circuit.json"];
for (const name of wanted) {
  const entry = manifest.files.find((file) => file.path === name);
  if (!entry) continue;
  const response = await fetch(new URL(rawFileUrl({ ...context, appSubUrl, path: baseDir + name }), base));
  // Bytes, not string length: an SVG with multi-byte glyphs would otherwise
  // look short by one per glyph.
  const bytes = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  check(`${name} served`, response.status === 200 && bytes.length === entry.bytes,
    `HTTP ${response.status}, ${bytes.length} B of ${formatBytes(entry.bytes)}`);
  if (name.endsWith(".svg")) check(`${name} is markup`, text.startsWith("<svg"));
}

if (manifest.url) {
  check("manifest points at a published site", /^https?:\/\//.test(manifest.url), manifest.url);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall viewer checks passed");
process.exit(failures ? 1 : 0);
