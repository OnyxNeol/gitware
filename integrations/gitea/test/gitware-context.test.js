import test from "node:test";
import assert from "node:assert/strict";

import {
  candidateManifests,
  classifyGitgramLine,
  formatBytes,
  parseAppSubUrl,
  parseRepoContext,
  rankManifests,
  rawFileUrl,
  summariseGitgramDiff,
  treeApiUrl,
  viewerHref,
} from "../custom/public/assets/gitware/gitware-context.js";

test("app sub-url recovery", () => {
  assert.equal(parseAppSubUrl("https://git.example.com/assets/gitware/gitware.html"), "");
  assert.equal(parseAppSubUrl("https://git.example.com/assets/gitware/gitware.html?owner=a&repo=b"), "");
  assert.equal(parseAppSubUrl("https://git.example.com/gitea/assets/gitware/gitware.html"), "/gitea");
  assert.equal(parseAppSubUrl("https://git.example.com/deep/gitea/assets/gitware/gitware.html"), "/deep/gitea");
  // A bookmarked page without the file name still resolves the base.
  assert.equal(parseAppSubUrl("https://git.example.com/gitea/assets/gitware"), "/gitea");
  assert.equal(parseAppSubUrl("not a url"), "");
});

test("repository coordinates prefer the explicit query", () => {
  const ctx = parseRepoContext({
    search: "?owner=OnyxNeol&repo=hw&ref=feature%2Fleds",
    pathname: "/OnyxNeol/other/src/branch/main/README.md",
    appSubUrl: "",
  });
  assert.equal(ctx.owner, "OnyxNeol");
  assert.equal(ctx.repo, "hw");
  // Slashes in branch names survive because the tab passes them as a parameter.
  assert.equal(ctx.ref, "feature/leds");
  assert.equal(ctx.complete, true);
});

test("repository coordinates fall back to Gitea's own routes", () => {
  const subPath = parseRepoContext({
    search: "",
    pathname: "/gitea/OnyxNeol/hw/src/branch/main/pcb/layout.kicad_pcb",
    appSubUrl: "/gitea",
  });
  assert.deepEqual(subPath, { owner: "OnyxNeol", repo: "hw", ref: "main", complete: true });

  const commit = parseRepoContext({ pathname: "/OnyxNeol/hw/src/commit/9f2ac1e" });
  assert.equal(commit.ref, "9f2ac1e");

  const tag = parseRepoContext({ pathname: "/OnyxNeol/hw/src/tag/v1.0.0" });
  assert.equal(tag.ref, "v1.0.0");

  const bare = parseRepoContext({ pathname: "/OnyxNeol/hw" });
  assert.equal(bare.ref, "main");
  assert.equal(bare.complete, true);

  const nothing = parseRepoContext({ pathname: "/" });
  assert.equal(nothing.complete, false);
});

test("raw file urls stay inside Gitea's routes", () => {
  assert.equal(
    rawFileUrl({ appSubUrl: "", owner: "OnyxNeol", repo: "hw", ref: "main", path: "dist/manifest.json" }),
    "/OnyxNeol/hw/raw/branch/main/dist/manifest.json",
  );
  assert.equal(
    rawFileUrl({
      appSubUrl: "/gitea",
      owner: "OnyxNeol",
      repo: "hw",
      ref: "feature/leds",
      path: "pcb/board revision 2.kicad_pcb",
    }),
    "/gitea/OnyxNeol/hw/raw/branch/feature/leds/pcb/board%20revision%202.kicad_pcb",
  );
  // A '#' in a file name must not be read as a URL fragment.
  assert.match(
    rawFileUrl({ owner: "o", repo: "r", path: "notes/pin#1.txt" }),
    /pin%231\.txt$/,
  );
});

test("manifest discovery is ordered and case tolerant", () => {
  assert.deepEqual(
    candidateManifests([
      "README.md",
      "MANIFEST.json",
      "dist/manifest.json",
      "src/main.c",
      "./pages/manifest.json",
      "dist/manifest.json",
    ]),
    ["dist/manifest.json", "pages/manifest.json", "MANIFEST.json"],
  );
  assert.deepEqual(candidateManifests(["src/main.c"]), []);
  assert.deepEqual(candidateManifests(undefined), []);
});

test("gitgram diff lines are classified by verb", () => {
  assert.deepEqual(classifyGitgramLine("+ part C1"), { change: "+", kind: "part" });
  assert.deepEqual(classifyGitgramLine("- part D2"), { change: "-", kind: "part" });
  assert.deepEqual(classifyGitgramLine('~ part R1.value: "220" -> "330"'), {
    change: "~",
    kind: "part",
  });
  assert.deepEqual(classifyGitgramLine("+ net DECOUPLE [power]: C1.a, U1.VCC"), {
    change: "+",
    kind: "net",
  });
  assert.deepEqual(classifyGitgramLine("~ net LED: +U1.PA1 -U1.PA0"), {
    change: "~",
    kind: "net",
  });
  assert.deepEqual(classifyGitgramLine("; a comment"), { change: " ", kind: "meta" });
  assert.deepEqual(classifyGitgramLine(""), { change: " ", kind: "blank" });
  assert.deepEqual(classifyGitgramLine("+"), { change: "+", kind: "blank" });
  // CRLF diffs arrive from Windows clients.
  assert.deepEqual(classifyGitgramLine("+ net VCC [power]\r"), { change: "+", kind: "net" });
});

test("diff summary counts parts and nets only", () => {
  const diff = [
    "--- a/blinky.gitgram",
    "+++ b/blinky.gitgram",
    "+ part C1",
    "- part D2",
    '~ part R1.value: "220" -> "330"',
    "+ net DECOUPLE",
    "~ net LED: +U1.PA1 -U1.PA0",
    "; comment lines never count",
    "",
  ].join("\n");
  const summary = summariseGitgramDiff(diff);
  assert.deepEqual(summary.parts, { added: 1, removed: 1, changed: 1 });
  assert.deepEqual(summary.nets, { added: 1, removed: 0, changed: 1 });
  assert.equal(summary.other, 0);
});

test("urls for the viewer and its data source", () => {
  assert.equal(
    treeApiUrl({ appSubUrl: "/gitea", owner: "OnyxNeol", repo: "hw", ref: "main" }),
    "/gitea/api/v1/repos/OnyxNeol/hw/git/trees/main?recursive=true&per_page=1000",
  );
  assert.equal(
    viewerHref({ appSubUrl: "/gitea", owner: "OnyxNeol", repo: "hw", ref: "feature/leds" }),
    "/gitea/assets/gitware/gitware.html?owner=OnyxNeol&repo=hw&ref=feature%2Fleds",
  );
});

test("byte formatting matches Gitea's file listing", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1024), "1.0 KiB");
  assert.equal(formatBytes(1536), "1.5 KiB");
  assert.equal(formatBytes(10 * 1024), "10 KiB");
  assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MiB");
  assert.equal(formatBytes(undefined), "0 B");
});

test("a repository can hold several hardware projects", () => {
  // The Pages layout keeps one project per slug; the shallowest known layout
  // still wins so the tab opens the obvious one.
  const paths = [
    "p/blinky-badge/manifest.json",
    "p/blinky-badge/board.svg",
    "p/sensor-node/manifest.json",
    "dist/manifest.json",
    "README.md",
    "notes/manifest.json",
  ];
  assert.deepEqual(rankManifests(paths), [
    "dist/manifest.json",
    "p/blinky-badge/manifest.json",
    "p/sensor-node/manifest.json",
    "notes/manifest.json",
  ]);
  // Duplicates collapse: first wins, and case-insensitive so a probe is not
  // repeated for what is almost certainly the same file.
  assert.deepEqual(rankManifests(["./dist/manifest.json", "DIST/Manifest.json", "dist/manifest.json"]), [
    "dist/manifest.json",
  ]);
  // Non-Gitware files never become candidates, even if they mention a manifest.
  assert.deepEqual(rankManifests(["package.json", "docs/manifest.md"]), []);
  assert.deepEqual(rankManifests([]), []);
});
