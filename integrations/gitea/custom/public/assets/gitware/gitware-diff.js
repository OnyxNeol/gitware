/**
 * Gitgram-aware diff badges for Gitea's commit and pull-request views.
 *
 * Gitea renders diffs server-side and swaps them in asynchronously, so this
 * module only ever *annotates* what Gitea produced: it never rewrites the diff,
 * never hides a line, and silently does nothing for files it does not
 * understand. A reviewer who ignores it still sees the plain text diff.
 */

import { summariseGitgramDiff } from "./gitware-context.js";

const FILE_BOXES = ".diff-file-box, .file-diff, .diff-file";
const MAX_PASSES = 6;

function filePathOf(box) {
  const named = box.querySelector("[data-file-path]");
  if (named) return named.dataset.filePath;
  const title = box.querySelector(".file-title-name, .file-title a, .file-title");
  const text = (title?.textContent || "").trim();
  // Gitea prints "name.ext" or "old → new" for renames.
  const match = /([^\s→]+\.(?:gitgram|gitgram\.txt))\b/.exec(text);
  return match ? match[1] : "";
}

function diffTextOf(box) {
  const codeCells = box.querySelectorAll(".lines-code, .line-code, td.code");
  if (codeCells.length) {
    return [...codeCells].map((cell) => cell.textContent.replace(/\n+$/, "")).join("\n");
  }
  return box.querySelector(".file-body")?.textContent || "";
}

function describe(summary) {
  const parts = [];
  const netParts = [];
  for (const [label, key] of [
    ["added", "added"],
    ["removed", "removed"],
    ["changed", "changed"],
  ]) {
    if (summary.parts[key]) {
      parts.push(`<span class="${key === "removed" ? "gw-remove" : "gw-add"}">${summary.parts[key]} part${summary.parts[key] === 1 ? "" : "s"} ${label}</span>`);
    }
    if (summary.nets[key]) {
      netParts.push(`<span class="${key === "removed" ? "gw-remove" : "gw-add"}">${summary.nets[key]} net${summary.nets[key] === 1 ? "" : "s"} ${label}</span>`);
    }
  }
  return [...parts, ...netParts].join(" · ");
}

function annotate() {
  let touched = 0;
  for (const box of document.querySelectorAll(FILE_BOXES)) {
    if (box.dataset.gitwareAnnotated) continue;
    const path = filePathOf(box);
    if (!path.endsWith(".gitgram")) continue;

    const summary = summariseGitgramDiff(diffTextOf(box));
    const total =
      summary.parts.added + summary.parts.removed + summary.parts.changed +
      summary.nets.added + summary.nets.removed + summary.nets.changed;

    box.dataset.gitwareAnnotated = "1";
    if (!total) continue;

    const badge = document.createElement("span");
    badge.className = "gw-diff-badge";
    badge.title = "Circuit changes parsed from the Gitgram diff";
    badge.innerHTML = describe(summary);
    const header = box.querySelector(".file-header .file-title, .file-header");
    if (header) {
      header.append(badge);
      touched += 1;
    }
  }
  return touched;
}

function boot() {
  let passes = 0;
  const tick = () => {
    passes += 1;
    annotate();
    if (passes < MAX_PASSES) setTimeout(tick, 400 * passes);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", tick, { once: true });
  } else {
    tick();
  }
  // Gitea loads further diffs when a reviewer expands a file.
  const observer = new MutationObserver(() => annotate());
  observer.observe(document.body, { childList: true, subtree: true });
}

boot();
