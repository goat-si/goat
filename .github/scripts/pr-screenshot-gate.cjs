"use strict";

// PR screenshot gate. Runs as the goat-screenshot-gate task of goat-ci.yml and
// reads the live pull request, so re-running the job after editing the
// description or adding the waiver label re-evaluates the current state.
// Ported from lidge-jun/opencodex .github/scripts/pr-quality.cjs (screenshot
// evidence only); goat arms the gate on changed paths, not on title words.

const fs = require("node:fs");

const WAIVER_LABEL = "gui-screenshot-waived";
const MODES = new Set(["off", "warn", "enforce"]);
const DEFAULT_MODE = "warn";

/** Directories whose changes are user-visible UI. */
const UI_PATH_PREFIXES = ["apps/web/", "apps/desktop/", "apps/mobile/", "apps/marketing/"];
/** Files inside a UI directory that do not change what a user sees. */
const NON_UI_FILE_RE =
  /(?:^|\/)(?:__tests__|tests?|integration)\/|\.(?:test|spec|browser|integration)\.[^/]+$|\.md$/i;

/** HTML comments, which GitHub never renders. An unclosed comment runs through EOF. */
const HTML_COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;
/** Fenced code blocks (backtick or tilde fences) whose content GitHub does not render. */
const FENCED_CODE_RE = /(?:^|\n)[ \t]*(\x60{3,}|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*(?=\n|$)/gm;
/** Inline markdown image, as GitHub writes for a dropped attachment. */
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]+\)/;
/** Reference-style markdown image (full or collapsed). */
const MARKDOWN_REFERENCE_IMAGE_RE = /!\[([^\]]*)\]\[([^\]]*)\]/g;
/** Link definitions that reference-style images depend on. */
const MARKDOWN_REFERENCE_DEF_RE = /^\s*\[([^\]]+)\]:\s*\S+/gm;
/** HTML image with a non-empty src. */
const HTML_IMAGE_RE = /<img\b[^>]*\bsrc\s*=\s*(?:"[^"]+"|'[^']+'|[^\s>"']+)[^>]*>/i;

function resolveMode(raw) {
  const mode = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return MODES.has(mode) ? mode : DEFAULT_MODE;
}

function isUiPath(file) {
  return (
    typeof file === "string" &&
    UI_PATH_PREFIXES.some((prefix) => file.startsWith(prefix)) &&
    !NON_UI_FILE_RE.test(file)
  );
}

/**
 * True when the paginated file list cannot be trusted to be complete: GitHub
 * lists at most 3000 files, and a count that does not match fails closed.
 */
function isChangedFileListTruncated(changedFilesCount, listedLength) {
  if (!Number.isInteger(changedFilesCount) || changedFilesCount < 0) return true;
  return changedFilesCount > listedLength;
}

/**
 * Drop the regions GitHub does not render: fenced code first (a literal
 * "<!--" inside a fence must not open a comment and swallow the rest), then
 * HTML comments. Image syntax in either region is text, not evidence. The PR
 * template's instructions live in comments, so an untouched template never
 * counts as a screenshot.
 */
function stripNonRenderedRegions(body) {
  return body.replace(FENCED_CODE_RE, "").replace(HTML_COMMENT_RE, "");
}

function hasRenderableReferenceImage(visible) {
  const definitions = new Set();
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_DEF_RE)) {
    definitions.add(match[1].trim().toLowerCase());
  }
  if (definitions.size === 0) return false;
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_IMAGE_RE)) {
    const id = (match[2] || match[1]).trim().toLowerCase();
    if (id && definitions.has(id)) return true;
  }
  return false;
}

/**
 * True when the rendered description embeds an image: an inline markdown
 * image, a defined reference image, or an <img> with a src. A plain link to an
 * image is not visual evidence.
 */
function hasScreenshotEvidence(body) {
  if (typeof body !== "string") return false;
  const visible = stripNonRenderedRegions(body);
  if (MARKDOWN_IMAGE_RE.test(visible)) return true;
  if (HTML_IMAGE_RE.test(visible)) return true;
  return hasRenderableReferenceImage(visible);
}

/** Admin or maintain role on the repository, the only roles that may waive. */
function isMaintainerPermission(permission) {
  if (!permission || typeof permission !== "object") return false;
  return (
    permission.role_name === "admin" ||
    permission.role_name === "maintain" ||
    permission.permission === "admin"
  );
}

/** Login of whoever last applied the label, or null when it was removed or never applied. */
function latestLabelActor(events, label = WAIVER_LABEL) {
  const relevant = (events ?? []).filter(
    (event) =>
      (event?.event === "labeled" || event?.event === "unlabeled") && event?.label?.name === label,
  );
  const latest = relevant.at(-1);
  return latest?.event === "labeled" ? (latest.actor?.login ?? null) : null;
}

/**
 * Decide the gate from facts already fetched. Outcomes: "skip" (not
 * applicable), "pass", or "missing" (UI changed, no screenshot, not waived).
 * The caller maps "missing" to a warning or a failure by mode.
 */
function decideGate({ draft, files, filesTruncated, body, waived }) {
  if (draft) return { outcome: "skip", reason: "draft pull request", uiFiles: [] };
  const uiFiles = files.filter(isUiPath);
  if (uiFiles.length === 0 && !filesTruncated) {
    return { outcome: "skip", reason: "no UI paths changed", uiFiles };
  }
  if (hasScreenshotEvidence(body)) {
    return { outcome: "pass", reason: "description embeds a screenshot", uiFiles };
  }
  if (waived) {
    return { outcome: "pass", reason: "waived by the " + WAIVER_LABEL + " label", uiFiles };
  }
  const reason = filesTruncated
    ? "the changed-file list is incomplete and the description has no screenshot"
    : "UI paths changed and the description has no screenshot";
  return { outcome: "missing", reason, uiFiles };
}

async function api(path, { token, apiUrl }) {
  const response = await fetch(apiUrl + path, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error("GET " + path + " returned " + response.status);
  }
  return response.json();
}

async function paginate(path, options, maxPages = 30) {
  const all = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const items = await api(path + separator + "per_page=100&page=" + page, options);
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function labelWaiver({ repoPath, number, labels, options, log }) {
  if (!labels.includes(WAIVER_LABEL)) return false;
  try {
    const events = await paginate(repoPath + "/issues/" + number + "/events", options);
    const actor = latestLabelActor(events);
    if (!actor) return false;
    const permission = await api(
      repoPath + "/collaborators/" + encodeURIComponent(actor) + "/permission",
      options,
    );
    if (isMaintainerPermission(permission)) return true;
    log("ignoring " + WAIVER_LABEL + ": applied by " + actor + ", who is not a maintainer");
  } catch (error) {
    log("could not verify who applied " + WAIVER_LABEL + ": " + error.message);
  }
  return false;
}

function summaryMarkdown({ number, mode, decision }) {
  const lines = [
    "### PR screenshot gate",
    "",
    "PR #" + number + " (" + mode + " mode): " + decision.reason + ".",
  ];
  if (decision.outcome === "missing") {
    lines.push(
      "",
      "Embed a screenshot of the UI change in the PR description, then re-run the goat-screenshot-gate job.",
      "Drag the image into the description editor, or commit it to the pr-assets branch and link it by commit SHA:",
      "https://raw.githubusercontent.com/goat-si/goat/<sha>/<pr>/<name>.png",
      "A maintainer can waive the screenshot with the " + WAIVER_LABEL + " label.",
    );
  }
  if (decision.uiFiles.length > 0) {
    lines.push("", "UI files in this PR:", "");
    for (const file of decision.uiFiles.slice(0, 20)) lines.push("- " + file);
    if (decision.uiFiles.length > 20)
      lines.push("- and " + (decision.uiFiles.length - 20) + " more");
  }
  return lines.join("\n") + "\n";
}

async function main(env = process.env) {
  const log = (message) => console.log("pr-screenshot-gate: " + message);
  const mode = resolveMode(env.GOAT_SCREENSHOT_GATE);
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    log("not a pull request event; nothing to check");
    return 0;
  }
  if (mode === "off") {
    log("GOAT_SCREENSHOT_GATE is off");
    return 0;
  }
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request?.number ?? event.number;
  const repoPath = "/repos/" + env.GITHUB_REPOSITORY;
  const options = {
    token: env.GITHUB_TOKEN,
    apiUrl: env.GITHUB_API_URL || "https://api.github.com",
  };

  let decision;
  try {
    const pr = await api(repoPath + "/pulls/" + number, options);
    const files = pr.draft
      ? []
      : (await paginate(repoPath + "/pulls/" + number + "/files", options)).map(
          (file) => file.filename,
        );
    const labels = (pr.labels ?? []).map((label) => label.name);
    const preliminary = decideGate({
      draft: pr.draft,
      files,
      filesTruncated: !pr.draft && isChangedFileListTruncated(pr.changed_files, files.length),
      body: pr.body ?? "",
      waived: false,
    });
    decision =
      preliminary.outcome === "missing" &&
      (await labelWaiver({ repoPath, number, labels, options, log }))
        ? { ...preliminary, outcome: "pass", reason: "waived by the " + WAIVER_LABEL + " label" }
        : preliminary;
  } catch (error) {
    const message = "could not read PR #" + number + ": " + error.message;
    if (mode === "enforce") {
      console.log("::error title=PR screenshot gate::" + message);
      return 1;
    }
    console.log("::warning title=PR screenshot gate::" + message);
    return 0;
  }

  log(decision.outcome + ": " + decision.reason);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown({ number, mode, decision }));
  }
  if (decision.outcome !== "missing") return 0;
  const message =
    "UI paths changed but the PR description has no screenshot. Embed one, or ask a maintainer for the " +
    WAIVER_LABEL +
    " label, then re-run this job.";
  if (mode === "enforce") {
    console.log("::error title=PR screenshot gate::" + message);
    return 1;
  }
  console.log("::warning title=PR screenshot gate::" + message);
  return 0;
}

module.exports = {
  WAIVER_LABEL,
  resolveMode,
  isUiPath,
  isChangedFileListTruncated,
  stripNonRenderedRegions,
  hasScreenshotEvidence,
  isMaintainerPermission,
  latestLabelActor,
  decideGate,
  summaryMarkdown,
  main,
};

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      // An unexpected crash only fails the job once the gate is enforcing.
      const enforcing = resolveMode(process.env.GOAT_SCREENSHOT_GATE) === "enforce";
      const level = enforcing ? "error" : "warning";
      console.log("::" + level + " title=PR screenshot gate::" + (error?.stack ?? String(error)));
      process.exitCode = enforcing ? 1 : 0;
    },
  );
}
