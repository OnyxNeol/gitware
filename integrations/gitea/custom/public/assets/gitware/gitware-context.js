/**
 * Gitea-side plumbing, kept free of DOM access so it can be unit tested.
 *
 * Everything here follows Gitea's own conventions rather than inventing new
 * ones: the app sub-URL that Gitea exposes as `window.config.appSubUrl`, the
 * repository coordinates encoded in Gitea's `/src/branch/<ref>/<path>` routes,
 * and Gitea's own raw-file endpoint (`/<owner>/<repo>/raw/branch/<ref>/<path>`)
 * so a private repository works with the session cookie the browser already
 * has, without asking the user for a token.
 */

/**
 * Gitea may live at `/` or under a sub-path (`/gitea/`). Assets served from
 * `custom/public/` are reached at `<subUrl>/gitware/<file>`, so the marker is
 * how a static page recovers the base it should prefix Gitea routes with.
 */
export function parseAppSubUrl(href, marker = "/assets/gitware/") {
  let path;
  try {
    path = new URL(href, "http://gitea.invalid").pathname;
  } catch {
    return "";
  }
  const index = path.indexOf(marker);
  if (index === -1) {
    const trimmed = path.replace(/\/+$/, "");
    return trimmed.endsWith("/assets/gitware")
      ? trimmed.slice(0, -"/assets/gitware".length)
      : "";
  }
  return path.slice(0, index).replace(/\/+$/, "");
}

/**
 * Repository coordinates for the viewer. The tab link passes them explicitly in
 * the query string (Gitea's branch names may contain slashes, which a path
 * parser cannot separate), and the path form is the fallback for a bookmarked
 * or shared URL.
 */
export function parseRepoContext({ search = "", pathname = "", appSubUrl = "" } = {}) {
  const params = new URLSearchParams(search);
  let owner = params.get("owner") ?? "";
  let repo = params.get("repo") ?? "";
  let ref = params.get("ref") ?? params.get("branch") ?? "";

  let parts = [];
  if (pathname) {
    const relativePath =
      appSubUrl && pathname.startsWith(appSubUrl) ? pathname.slice(appSubUrl.length) : pathname;
    parts = relativePath.split("/").filter(Boolean);
  }

  if ((!owner || !repo) && parts.length >= 2) {
    owner = owner || parts[0];
    repo = repo || parts[1];
  }

  if (!ref && parts.length) {
    const marker = parts.indexOf("src");
    if (marker !== -1 && parts[marker + 2]) {
      const kind = parts[marker + 1];
      if (kind === "branch" || kind === "commit" || kind === "tag") {
        ref = parts[marker + 2];
      }
    }
  }

  return {
    owner,
    repo,
    ref: ref || "main",
    complete: Boolean(owner && repo),
  };
}

/**
 * Gitea's raw endpoint for a file at a ref. Segments are escaped individually
 * so a path with spaces or a `#` still resolves, while the slashes that make it
 * a path survive.
 */
export function rawFileUrl({ appSubUrl = "", owner, repo, ref = "main", path }) {
  const base = appSubUrl.replace(/\/+$/, "");
  const safePath = String(path)
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment).replace(/%2F/gi, "/"))
    .join("/");
  const safeRef = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/branch/${safeRef}/${safePath}`;
}

/** Where a Gitware build may live inside a repository, most specific first. */
export const MANIFEST_NAMES = [
  "dist/pages/manifest.json",
  "dist/manifest.json",
  "pages/manifest.json",
  "gitware/manifest.json",
  "manifest.json",
  "gitware.json",
];

const MANIFEST_BASENAMES = new Set(["manifest.json", "gitware.json"]);
const unknown = (rank) => rank === MANIFEST_NAMES.length;

/**
 * Order every manifest a repository actually contains.
 *
 * A repository can hold more than one hardware project: the Pages layout puts
 * each one under `p/<slug>/manifest.json`, while a single-board project keeps
 * `dist/manifest.json`. Known layouts win, then the shallowest path, so the
 * obvious project is shown first and the rest stay reachable.
 */
export function rankManifests(paths = []) {
  const seen = new Set();
  const ranked = [];
  for (const raw of paths) {
    if (typeof raw !== "string") continue;
    const path = raw.replace(/^\.?\/+/, "");
    if (!path) continue;
    const base = path.split("/").pop().toLowerCase();
    if (!MANIFEST_BASENAMES.has(base)) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ranked.push(path);
  }
  const depth = (path) => path.split("/").length - 1;
  // The published-site layout (`p/<slug>/manifest.json`) is the project's own
  // convention, so it outranks a manifest that merely happens to sit shallower.
  const pagesRank = (path) => (/^p\/[^/]+\/(manifest|gitware)\.json$/i.test(path) ? 0 : 1);
  return ranked.sort((a, b) => {
    const knownA = MANIFEST_NAMES.indexOf(a.toLowerCase());
    const knownB = MANIFEST_NAMES.indexOf(b.toLowerCase());
    const rankA = knownA === -1 ? MANIFEST_NAMES.length : knownA;
    const rankB = knownB === -1 ? MANIFEST_NAMES.length : knownB;
    if (rankA !== rankB) return rankA - rankB;
    if (unknown(rankA) && unknown(rankB) && pagesRank(a) !== pagesRank(b)) {
      return pagesRank(a) - pagesRank(b);
    }
    if (depth(a) !== depth(b)) return depth(a) - depth(b);
    return a.localeCompare(b);
  });
}

/** Pick the best manifest from a repository's file listing. */
export function candidateManifests(paths = []) {
  return rankManifests(paths);
}

/**
 * Classify one line of a Gitgram diff so the web view can colour it the way
 * Gitea colours added and removed lines, without re-parsing the circuit.
 *
 * Gitgrams render to lines such as `+ part C1`, `~ net LED: +U1.PA1 -U1.PA0`,
 * so the useful signal is the verb right after the marker.
 */
export function classifyGitgramLine(line) {
  const text = String(line).replace(/\r$/, "");
  const marker = text[0];
  if (marker !== "+" && marker !== "-" && marker !== "~" && marker !== " ") {
    return { change: " ", kind: text.trim() === "" ? "blank" : "meta" };
  }
  if (marker === " " && text.trim() === "") {
    return { change: " ", kind: "blank" };
  }
  const body = text.slice(1).trim();
  const verb = /^([A-Za-z_]+)/.exec(body)?.[1]?.toLowerCase() ?? "";
  if (verb === "part" || verb === "component") return { change: marker, kind: "part" };
  if (verb === "net" || verb === "signal" || verb === "power") return { change: marker, kind: "net" };
  if (verb === "gitgram" || verb === "name" || verb === "meta") return { change: marker, kind: "meta" };
  return { change: marker, kind: body === "" ? "blank" : "meta" };
}

/**
 * Roll a Gitgram diff up into counts for the badge Gitea shows next to the
 * file name. Only lines that describe parts or nets are counted; comments and
 * metadata stay out of the numbers.
 */
export function summariseGitgramDiff(text) {
  const summary = {
    parts: { added: 0, removed: 0, changed: 0 },
    nets: { added: 0, removed: 0, changed: 0 },
    other: 0,
  };
  for (const line of String(text).split("\n")) {
    const { change, kind } = classifyGitgramLine(line);
    if (kind !== "part" && kind !== "net") continue;
    const bucket = kind === "part" ? summary.parts : summary.nets;
    if (change === "+") bucket.added += 1;
    else if (change === "-") bucket.removed += 1;
    else if (change === "~") bucket.changed += 1;
    else summary.other += 1;
  }
  return summary;
}

/** Gitea's tree API path for the repository the viewer is looking at. */
export function treeApiUrl({ appSubUrl = "", owner, repo, ref = "main" }) {
  const base = appSubUrl.replace(/\/+$/, "");
  return `${base}/api/v1/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=true&per_page=1000`;
}

/** The tab link that carries the repository into the viewer page. */
export function viewerHref({ appSubUrl = "", owner, repo, ref = "main" }) {
  const base = appSubUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ owner, repo, ref });
  // Gitea serves `custom/public/assets/**` at `<subUrl>/assets/**` and never
  // serves a directory index, so the page is addressed by file name.
  return `${base}/assets/gitware/gitware.html?${params.toString()}`;
}

/** Human byte count, matching the units Gitea prints in file listings. */
export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KiB", "MiB", "GiB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}
