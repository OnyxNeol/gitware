/**
 * GitHub plumbing for the static Gitware app.
 *
 * Everything here is pure and testable: URL builders, repository input
 * parsing, manifest ranking and Gitgram diff summarising. The DOM lives in
 * app.js, so this file can be exercised from Node without a browser.
 *
 * Why a token at all: GitHub's anonymous rate limit is 60 requests an hour,
 * which one project view can eat. A personal access token (read-only is
 * enough) is held in localStorage and sent only to api.github.com.
 */

export const API = "https://api.github.com";
export const RAW = "https://raw.githubusercontent.com";

/** Build locations, most specific first. */
export const MANIFEST_NAMES = [
  "dist/pages/manifest.json",
  "dist/manifest.json",
  "pages/manifest.json",
  "gitware/manifest.json",
  "manifest.json",
  "gitware.json",
];

const MANIFEST_BASENAMES = new Set(["manifest.json", "gitware.json"]);

/**
 * Accept what people actually paste: "owner/repo", a full GitHub URL, a URL
 * with /tree/<ref> in it, or a URL to a file inside the repository.
 */
export function parseRepoInput(input) {
  const text = String(input || "").trim();
  if (!text) return null;

  const withHost = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i.exec(text);
  const body = (withHost ? withHost[1] : text).replace(/^\/+|\/+$/g, "");
  const parts = body.split("/");

  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;

  let ref = "";
  if (parts[2] === "tree" && parts[3]) {
    // A branch may itself contain slashes, so take everything that follows.
    ref = parts.slice(3).join("/");
  }

  return { owner, repo, ref: ref || "" };
}

/** "owner/repo" for display and for the address bar. */
export function repoLabel({ owner, repo }) {
  return `${owner}/${repo}`;
}

export function treeUrl({ owner, repo, ref = "" }) {
  const suffix = ref ? `?recursive=1&ref=${encodeURIComponent(ref)}` : "?recursive=1";
  return `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref || "HEAD")}${suffix}`;
}

export function repoUrl({ owner, repo }) {
  return `${API}/repos/${owner}/${repo}`;
}

export function commitsUrl({ owner, repo, ref = "", path = "", perPage = 10 }) {
  const params = new URLSearchParams({ per_page: String(perPage) });
  if (ref) params.set("sha", ref);
  if (path) params.set("path", path);
  return `${API}/repos/${owner}/${repo}/commits?${params.toString()}`;
}

export function rawUrl({ owner, repo, ref, path }) {
  const cleanPath = String(path).replace(/^\/+/, "");
  const encoded = cleanPath.split("/").map(encodeURIComponent).join("/");
  return `${RAW}/${owner}/${repo}/${encodeURIComponent(ref)}/${encoded}`;
}

export function commitUrl({ owner, repo, sha }) {
  return `https://github.com/${owner}/${repo}/commit/${sha}`;
}

/**
 * Order every manifest in a repository.
 *
 * A repository can hold several hardware projects: the Pages layout puts each
 * one under p/<slug>/manifest.json, a single-board project keeps
 * dist/manifest.json. Known layouts win, then the Pages layout, then the
 * shallowest path, so the obvious project opens first and the rest stay listed.
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
  const pagesRank = (path) => (/^p\/[^/]+\/(manifest|gitware)\.json$/i.test(path) ? 0 : 1);
  return ranked.sort((a, b) => {
    const knownA = MANIFEST_NAMES.indexOf(a.toLowerCase());
    const knownB = MANIFEST_NAMES.indexOf(b.toLowerCase());
    const rankA = knownA === -1 ? MANIFEST_NAMES.length : knownA;
    const rankB = knownB === -1 ? MANIFEST_NAMES.length : knownB;
    if (rankA !== rankB) return rankA - rankB;
    const unknownA = rankA === MANIFEST_NAMES.length;
    if (unknownA && pagesRank(a) !== pagesRank(b)) return pagesRank(a) - pagesRank(b);
    if (depth(a) !== depth(b)) return depth(a) - depth(b);
    return a.localeCompare(b);
  });
}

/** The directory a manifest's siblings live in. */
export function baseDirOf(path) {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

// --- Gitgram diffing -------------------------------------------------------

// Gitgram is an S-expression format, so a part opens with "(part \"R1\"" and a
// net with "(net \"LED\"". The bare keyword forms are accepted too, because a
// hand-written or flattened file may use them.
const PART_LINE = /^\s*\(?\s*(part|symbol|component|module)\b/i;
const NET_LINE = /^\s*\(?\s*(net|signal)\b/i;

/** Classify one changed line of a .gitgram file. */
export function classifyGitgramLine(line) {
  const text = String(line || "");
  if (!text.trim() || text.trimStart().startsWith("#")) return "other";
  if (NET_LINE.test(text)) return "net";
  if (PART_LINE.test(text)) return "part";
  return "other";
}

/**
 * Count what a .gitgram diff changed, by kind. Line based on purpose: the
 * format is text-first, so a reviewer can always fall back to the raw diff.
 */
export function summariseGitgramDiff(diffText) {
  const summary = {
    parts: { added: 0, removed: 0, changed: 0 },
    nets: { added: 0, removed: 0, changed: 0 },
    other: 0,
    lines: 0,
  };
  const lines = String(diffText || "").split("\n");
  for (const line of lines) {
    if (!line || /^(\+\+\+|---|@@|diff |index )/.test(line)) continue;
    const marker = line[0];
    if (marker !== "+" && marker !== "-") continue;
    summary.lines += 1;
    const kind = classifyGitgramLine(line.slice(1));
    // Meta, pins and formatting still changed something, so they are counted
    // as "other" rather than quietly folded into parts.
    if (kind === "other") {
      summary.other += 1;
      continue;
    }
    const bucket = kind === "net" ? summary.nets : summary.parts;
    if (marker === "+") bucket.added += 1;
    else bucket.removed += 1;
  }
  return summary;
}

/** A one-line human summary, or "" when the diff touched nothing structural. */
export function describeGitgramSummary(summary) {
  const parts = [];
  const push = (count, label) => {
    if (count) parts.push(`${count} ${label}`);
  };
  push(summary.parts.added, "part(s) added");
  push(summary.parts.removed, "part(s) removed");
  push(summary.nets.added, "net(s) added");
  push(summary.nets.removed, "net(s) removed");
  if (summary.other) parts.push(`${summary.other} other change(s)`);
  return parts.join(" · ");
}

/** Line-level diff of two texts (LCS), used for the Gitgram view. */
export function diffLines(before = "", after = "") {
  const a = String(before).split("\n");
  const b = String(after).split("\n");
  const rows = [];
  const rowsB = [];
  const n = a.length;
  const m = b.length;
  // Guard: the LCS table is O(n*m), so cap very large files to a plain replace.
  if (n * m > 4_000_000) {
    for (const line of a) rows.push({ kind: "-", text: line });
    for (const line of b) rows.push({ kind: "+", text: line });
    return rows.concat(rowsB);
  }
  const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      rows.push({ kind: "-", text: a[i] });
      i += 1;
    } else {
      rows.push({ kind: "+", text: b[j] });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ kind: "-", text: a[i] });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: "+", text: b[j] });
    j += 1;
  }
  return rows;
}

// --- Gitware Cloud ---------------------------------------------------------

/**
 * The server side, in one base URL.
 *
 * A static site cannot list projects, keep a private one private, or hold a
 * token out of the browser's reach. Both of those live behind these two
 * functions instead, so the app stays static and still has a backend.
 */
export const CLOUD = "https://superagent-d6c4a61b.base44.app/functions";

export const CLOUD_FUNCTIONS = {
  projects: `${CLOUD}/gitwareProjects`,
  github: `${CLOUD}/gitwareGithub`,
  oauth: `${CLOUD}/githubOauth`,
};

async function post(fn, body) {
  const url = CLOUD_FUNCTIONS[fn] || fn;
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

/** POST to a Gitware Cloud function, returning its parsed JSON body. */
export async function cloudCall(fn, body) {
  const response = await post(fn, body);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && payload?.error) {
    const error = new Error(payload.error);
    error.status = response.status;
    throw error;
  }
  if (!response.ok) throw new Error(`Cloud answered ${response.status}.`);
  return payload;
}

/** POST and read the body as text, for the proxy's file action. */
export async function cloudText(fn, body) {
  const response = await post(fn, body);
  if (!response.ok) throw new Error(`Cloud answered ${response.status}.`);
  return response.text();
}

/** A local, unguessable write token. Only its SHA-256 is stored server-side. */
export function newWriteToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** "Blinky Badge · rev C" -> "blinky-badge" */
export function slugify(title) {
  return String(title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}


// --- OAuth -----------------------------------------------------------------

/**
 * Where to send the browser for sign-in.
 *
 * The client id is public by design; the secret stays in the function. State is
 * compared on return so a redirect that was not started here is ignored.
 */
export function oauthAuthorizeUrl({ clientId, redirectUri, state, scope = "read:user repo" }) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("allow_signup", "true");
  return url.toString();
}

/**
 * Turn a GitHub REST or raw URL into a request for the proxy function.
 *
 * Returns null for anything unrecognised, which is the signal to fetch it
 * directly instead of routing it through the backend.
 */
export function proxyRequest(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (parsed.hostname === "api.github.com") {
    if (parts[0] !== "repos" || parts.length < 3) return null;
    const repo = `${parts[1]}/${parts[2]}`;
    if (parts[3] === "git" && parts[4] === "trees" && parts[5]) {
      return { action: "tree", repo, ref: parts.slice(5).join("/") };
    }
    if (parts[3] === "commits" && parts.length === 4) {
      const ref = parsed.searchParams.get("sha") || "";
      const limit = Number(parsed.searchParams.get("per_page") || 20);
      return { action: "commits", repo, ...(ref ? { ref } : {}), limit };
    }
    if (parts.length === 3) return { action: "repo", repo };
    return null;
  }

  if (parsed.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    // /owner/repo/ref/path... where ref may itself be encoded with slashes.
    return {
      action: "file",
      repo: `${parts[0]}/${parts[1]}`,
      ref: parts[2],
      path: parts.slice(3).join("/"),
    };
  }

  return null;
}
