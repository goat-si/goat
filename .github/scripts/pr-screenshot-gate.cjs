"use strict";

// PR screenshot gate. Runs as the goat-screenshot-gate task of goat-ci.yml and
// reads the live pull request, so re-running the job after editing the
// description or adding the waiver label re-evaluates the current state.
// Ported from lidge-jun/opencodex .github/scripts/pr-quality.cjs (screenshot
// evidence only); goat arms the gate on changed paths, not on title words.

const fs = require("node:fs");
const { setTimeout: sleep } = require("node:timers/promises");

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
/**
 * Inline markdown image, as GitHub writes for a dropped attachment. The URL may
 * be <wrapped>, titled, or hold one level of balanced parentheses.
 */
const MARKDOWN_IMAGE_RE =
  /!\[[^\]]*\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^\s()]*\))+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/dg;
/** Reference-style markdown image (full or collapsed). */
const MARKDOWN_REFERENCE_IMAGE_RE = /!\[([^\]]*)\]\[([^\]]*)\]/g;
/** Link definitions that reference-style images depend on; the URL may start on the next line. */
const MARKDOWN_REFERENCE_DEF_RE = /^[ \t]*\[([^\]]+)\]:[ \t]*(?:\n[ \t]*)?(?:<([^>\n]+)>|(\S+))/dgm;
/** Inline code spans: a backtick run closed by a run of the same length, within one paragraph. */
const INLINE_CODE_RE =
  /(?<!\x60)(\x60+)(?!\x60)(?:[^\r\n]|\r?\n(?![ \t]*\r?\n))*?(?<!\x60)\1(?!\x60)/g;
/** An <img> tag; a quoted attribute value may contain ">". */
const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
/** One attribute inside a tag, with its double-quoted, single-quoted, or bare value. */
const ATTRIBUTE_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/dg;
/**
 * HTML comments and inline code in one left-to-right pass: whichever opens
 * first hides the other, as in GitHub's renderer, so a backtick inside a
 * comment never pairs with one outside it, and "<!--" inside code opens nothing.
 */
const HIDDEN_INLINE_RE = new RegExp(HTML_COMMENT_RE.source + "|" + INLINE_CODE_RE.source, "g");

const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const IMAGE_CHECK_TIMEOUT_MS = 5000;
/** Embeds fetched per run, a few at a time; any beyond the cap stay unverified. */
const MAX_FETCHED_EMBEDS = 100;
const FETCH_CONCURRENCY = 8;
const UPLOAD_HINT = "node scripts/pr-assets.ts upload <pr> <files...> --patch-body";

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
 * Blank out the regions GitHub does not render, keeping every offset so an
 * embed found in the result can be rewritten in the original body. Fenced
 * code goes first and inline code second (a literal "<!--" inside code must
 * not open a comment and swallow the rest), then HTML comments. The PR
 * template's instructions live in comments, so an untouched template never
 * counts as a screenshot. Indented code blocks are left alone: telling them
 * from list continuation lines needs a full markdown parser.
 */
function maskNonRenderedRegions(body) {
  const blank = (region) => region.replace(/[^\n]/g, " ");
  return body.replace(FENCED_CODE_RE, blank).replace(HIDDEN_INLINE_RE, blank);
}

/**
 * Attributes of one tag by lowercase name, the first occurrence winning as in
 * HTML, each with its value and the value's offset within the tag.
 */
function tagAttributes(tag) {
  const attributes = new Map();
  const inner = tag.slice(4, -1);
  for (const match of inner.matchAll(ATTRIBUTE_RE)) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) continue;
    const value = capture(match, [2, 3, 4]);
    attributes.set(
      name,
      value
        ? { text: value.text, start: value.start + 4, end: value.end + 4 }
        : { text: "", start: -1, end: -1 },
    );
  }
  return attributes;
}

/** GitHub decodes &amp; in every image URL before the browser requests it. */
function decodeAmpersands(url) {
  return url.replace(/&amp;/g, "&");
}

/** First participating capture group and its [start, end) span. */
function capture(match, groups) {
  for (const group of groups) {
    if (match[group] !== undefined) {
      const [start, end] = match.indices[group];
      return { text: match[group], start, end };
    }
  }
  return null;
}

/**
 * Every image the rendered description embeds, in body order: inline markdown
 * images, <img> tags with a src, and reference images whose definition
 * exists. start/end locate the URL text in the original body. A reference
 * definition shared by several images is listed once.
 */
function extractImageEmbeds(body) {
  if (typeof body !== "string") return [];
  const visible = maskNonRenderedRegions(body);
  const embeds = [];
  for (const match of visible.matchAll(MARKDOWN_IMAGE_RE)) {
    const url = capture(match, [1, 2]);
    embeds.push({
      kind: "markdown",
      source: match[0],
      url: decodeAmpersands(url.text),
      start: url.start,
      end: url.end,
    });
  }
  for (const match of visible.matchAll(IMG_TAG_RE)) {
    const url = tagAttributes(match[0]).get("src");
    if (!url?.text) continue;
    embeds.push({
      kind: "html",
      source: match[0],
      url: decodeAmpersands(url.text),
      start: match.index + url.start,
      end: match.index + url.end,
    });
  }
  const definitions = new Map();
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_DEF_RE)) {
    const id = match[1].trim().toLowerCase();
    if (!definitions.has(id)) definitions.set(id, capture(match, [2, 3]));
  }
  const usedDefinitions = new Set();
  for (const match of visible.matchAll(MARKDOWN_REFERENCE_IMAGE_RE)) {
    const id = (match[2] || match[1]).trim().toLowerCase();
    const url = id ? definitions.get(id) : undefined;
    if (!url || usedDefinitions.has(id)) continue;
    usedDefinitions.add(id);
    embeds.push({
      kind: "reference",
      source: match[0],
      url: decodeAmpersands(url.text),
      start: url.start,
      end: url.end,
    });
  }
  return embeds.sort((a, b) => a.start - b.start);
}

/**
 * Images in GitHub's rendering of the description (the API's body_html), the
 * authority on what a reader sees: code blocks, comments, and markdown edge
 * cases are already resolved. url is the URL as written (data-canonical-src
 * when GitHub proxies it through camo); fetchUrl is what the browser loads.
 */
function renderedImages(html) {
  if (typeof html !== "string") return [];
  const images = [];
  for (const [tag] of html.matchAll(IMG_TAG_RE)) {
    const attributes = tagAttributes(tag);
    const src = decodeAmpersands(attributes.get("src")?.text ?? "");
    if (!src) continue;
    images.push({
      kind: "rendered",
      url: decodeAmpersands(attributes.get("data-canonical-src")?.text ?? "") || src,
      fetchUrl: src,
    });
  }
  return images;
}

/**
 * Owner, repo, ref, and file path of a link into GitHub repository contents
 * (raw.githubusercontent.com, or github.com raw/blob pages), or null.
 */
function parseGithubContentUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  let view;
  let rest;
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 4) {
    view = "raw";
    rest = parts.slice(2);
  } else if (
    url.hostname === "github.com" &&
    parts.length >= 5 &&
    (parts[2] === "raw" || parts[2] === "blob")
  ) {
    view = parts[2];
    rest = parts.slice(3);
  } else {
    return null;
  }
  const refLength = rest[0] === "refs" && rest[1] === "heads" ? 3 : 1;
  return {
    owner: parts[0],
    repo: parts[1],
    view,
    ref: rest.slice(0, refLength).join("/"),
    path: rest.slice(refLength).join("/"),
    rawQuery: url.searchParams.get("raw") === "true",
  };
}

/**
 * Problems visible from the URL alone, or null when only a fetch can tell.
 * A relative path resolves against the PR page and never loads. A branch name
 * moves or disappears, so a GitHub link must pin a full commit SHA. A blob link
 * without ?raw=true serves the HTML file viewer.
 */
function staticEmbedProblem(raw) {
  if (!/^https?:\/\//i.test(raw)) return "relative path; GitHub resolves it against the PR page";
  const github = parseGithubContentUrl(raw);
  if (!github) return null;
  if (!FULL_SHA_RE.test(github.ref)) {
    return "links the branch name '" + github.ref + "' instead of a commit SHA";
  }
  if (github.view === "blob" && !github.rawQuery)
    return "links the file viewer page, not the image";
  return null;
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status < 600);
}

/** One request; resolves to { status, contentType } or rejects on transport failure. */
async function probeImage(url, method) {
  const response = await fetch(url, {
    method,
    redirect: "follow",
    signal: AbortSignal.timeout(IMAGE_CHECK_TIMEOUT_MS),
  });
  // Only the headers matter; release the connection without reading the image.
  await response.body?.cancel?.().catch(() => {});
  return { status: response.status, contentType: response.headers?.get?.("content-type") ?? "" };
}

/**
 * Whether an absolute image URL loads for an anonymous viewer, as the GitHub
 * web and mobile clients fetch it: "ok", "broken" with a reason, or
 * "unverified" when network errors, timeouts, or 408/429/5xx persist. HEAD is
 * tried first; a host that rejects or mislabels HEAD gets a GET.
 */
async function verifyImageUrl(url, { attempts = 3, sleep: wait = sleep } = {}) {
  let lastFailure = "no response";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) await wait(250 * (attempt - 1));
    let result;
    try {
      result = await probeImage(url, "HEAD");
      if (result.status !== 200 || !/^image\//i.test(result.contentType)) {
        result = await probeImage(url, "GET");
      }
    } catch (error) {
      lastFailure =
        error?.name === "TimeoutError" ? "timed out" : (error?.message ?? String(error));
      continue;
    }
    if (result.status === 200) {
      return /^image\//i.test(result.contentType)
        ? { status: "ok" }
        : {
            status: "broken",
            reason: "serves " + (result.contentType || "no content type") + ", not an image",
          };
    }
    if (!isTransientStatus(result.status)) {
      return { status: "broken", reason: "returns HTTP " + result.status };
    }
    lastFailure = "HTTP " + result.status;
  }
  return { status: "unverified", reason: lastFailure };
}

/**
 * Check each embed: URL rules first, then a fetch for the rest. Returns the
 * embeds annotated with status "ok", "broken", or "unverified".
 */
async function checkEmbeds(embeds, options = {}) {
  const problems = embeds.map((embed) => staticEmbedProblem(embed.url));
  const target = (embed) => embed.fetchUrl ?? embed.url;
  const urls = [...new Set(embeds.filter((_, index) => !problems[index]).map(target))];
  const fetched = urls.slice(0, MAX_FETCHED_EMBEDS);
  const results = new Map();
  let next = 0;
  const worker = async () => {
    while (next < fetched.length) {
      const url = fetched[next++];
      results.set(url, await verifyImageUrl(url, options));
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  return embeds.map((embed, index) => {
    if (problems[index]) return { ...embed, status: "broken", reason: problems[index] };
    return {
      ...embed,
      ...(results.get(target(embed)) ?? {
        status: "unverified",
        reason: "not fetched; the description has more than " + MAX_FETCHED_EMBEDS + " images",
      }),
    };
  });
}

/**
 * True when the rendered description embeds an image: an inline markdown
 * image, a defined reference image, or an <img> with a src. A plain link to an
 * image is not visual evidence. Whether the image loads is checkEmbeds' job.
 */
function hasScreenshotEvidence(body) {
  return extractImageEmbeds(body).length > 0;
}

function describeEmbed(embed) {
  const url = embed.url.length > 120 ? embed.url.slice(0, 117) + "..." : embed.url;
  return url + " (" + embed.reason + ")";
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
 * applicable), "pass", "missing" (UI changed, no screenshot that loads, not
 * waived), or "inconclusive" (an embed could not be fetched). The caller maps
 * "missing" to a warning or a failure by mode. embeds are checkEmbeds results;
 * without them only the URL rules apply.
 */
function decideGate({ draft, files, filesTruncated, body, waived, embeds }) {
  if (draft)
    return { outcome: "skip", reason: "draft pull request", uiFiles: [], brokenEmbeds: [] };
  const uiFiles = files.filter(isUiPath);
  if (uiFiles.length === 0 && !filesTruncated) {
    return { outcome: "skip", reason: "no UI paths changed", uiFiles, brokenEmbeds: [] };
  }
  const checked =
    embeds ??
    extractImageEmbeds(body).map((embed) => {
      const problem = staticEmbedProblem(embed.url);
      return problem ? { ...embed, status: "broken", reason: problem } : { ...embed, status: "ok" };
    });
  const brokenEmbeds = checked.filter((embed) => embed.status === "broken");
  const unverified = checked.filter((embed) => embed.status === "unverified");
  if (checked.length > 0 && brokenEmbeds.length === 0 && unverified.length === 0) {
    return { outcome: "pass", reason: "description embeds a screenshot", uiFiles, brokenEmbeds };
  }
  if (waived) {
    return {
      outcome: "pass",
      reason: "waived by the " + WAIVER_LABEL + " label",
      uiFiles,
      brokenEmbeds,
    };
  }
  // One broken image is enough to fail: reviewers open the PR and see a hole.
  if (brokenEmbeds.length > 0) {
    return {
      outcome: "missing",
      reason:
        brokenEmbeds.length +
        " of " +
        checked.length +
        " screenshot embeds in the description do not load: " +
        brokenEmbeds.map(describeEmbed).join("; "),
      uiFiles,
      brokenEmbeds,
    };
  }
  if (unverified.length > 0) {
    return {
      outcome: "inconclusive",
      reason:
        "could not confirm that the screenshot embeds load: " +
        unverified.map(describeEmbed).join("; "),
      uiFiles,
      brokenEmbeds,
    };
  }
  const reason = filesTruncated
    ? "the changed-file list is incomplete and the description has no screenshot"
    : "UI paths changed and the description has no screenshot";
  return { outcome: "missing", reason, uiFiles, brokenEmbeds };
}

async function api(
  path,
  {
    token,
    apiUrl,
    attempts = 1,
    sleep: wait = sleep,
    method = "GET",
    body,
    accept = "application/vnd.github+json",
  },
) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(apiUrl + path, {
        method,
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
        headers: {
          accept,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          authorization: "Bearer " + token,
          "x-github-api-version": "2022-11-28",
        },
      });
    } catch (error) {
      // Fetch rejection is a transport failure; JSON parsing below is not retried.
      if (attempt >= attempts) throw error;
      await wait(250 * attempt);
      continue;
    }
    if (response.ok) return response.json();
    if (response.status < 500 || response.status >= 600 || attempt >= attempts) {
      throw new Error(method + " " + path + " returned " + response.status);
    }
    await wait(250 * attempt);
  }
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
    throw new Error("could not verify who applied " + WAIVER_LABEL + ": " + error.message, {
      cause: error,
    });
  }
  return false;
}

async function syncInconclusiveCheck({ repoPath, headSha, decision, options }) {
  if (!headSha) throw new Error("event payload has no PR head SHA");
  const name = "goat-screenshot-gate: inconclusive";
  const checks = await api(
    repoPath +
      "/commits/" +
      headSha +
      "/check-runs?check_name=" +
      encodeURIComponent(name) +
      "&filter=latest",
    options,
  );
  const existing = checks.check_runs[0];
  const inconclusive = decision.outcome === "inconclusive";
  if (!inconclusive && !existing) return;
  await api(repoPath + "/check-runs" + (existing ? "/" + existing.id : ""), {
    ...options,
    method: existing ? "PATCH" : "POST",
    // A transport failure may have created the check; do not duplicate it by retrying.
    attempts: 1,
    body: {
      ...(existing ? {} : { name, head_sha: headSha }),
      status: "completed",
      conclusion: inconclusive ? "neutral" : "success",
      output: {
        title: inconclusive
          ? "Screenshot gate could not inspect this PR"
          : "Resolved: a later run inspected this PR",
        summary: inconclusive
          ? decision.reason + ". Please re-run the goat-screenshot-gate job."
          : decision.outcome +
            ": " +
            decision.reason +
            ". See the goat-screenshot-gate job for the gate result.",
      },
    },
  });
}

function summaryMarkdown({ number, mode, decision }) {
  const lines = [
    "### PR screenshot gate",
    "",
    "PR #" +
      number +
      " (" +
      mode +
      " mode): " +
      (decision.outcome === "inconclusive" ? "inconclusive: " : "") +
      decision.reason +
      ".",
  ];
  if (decision.outcome === "missing") {
    if (decision.brokenEmbeds?.length > 0) {
      lines.push("", "These embeds do not load for a reader of the PR:", "");
      for (const embed of decision.brokenEmbeds) lines.push("- `" + describeEmbed(embed) + "`");
    }
    lines.push(
      "",
      "Embed a screenshot of the UI change in the PR description, then re-run the goat-screenshot-gate job.",
      "Drag the image into the description editor, or upload it to the pr-assets branch and fix the description with:",
      "`" + UPLOAD_HINT + "`",
      "That links each image by commit SHA: https://raw.githubusercontent.com/goat-si/goat/<sha>/<pr>/<name>.png",
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

async function main(env = process.env, { sleep: wait = sleep } = {}) {
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
    attempts: 3,
    sleep: wait,
  };

  let decision;
  try {
    // full+json adds body_html, GitHub's own rendering of the description.
    const pr = await api(repoPath + "/pulls/" + number, {
      ...options,
      accept: "application/vnd.github.full+json",
    });
    const files = pr.draft
      ? []
      : (await paginate(repoPath + "/pulls/" + number + "/files", options)).map(
          (file) => file.filename,
        );
    const labels = (pr.labels ?? []).map((label) => label.name);
    const filesTruncated = !pr.draft && isChangedFileListTruncated(pr.changed_files, files.length);
    const body = pr.body ?? "";
    // Fetch images only when the gate applies; drafts and non-UI PRs skip anyway.
    const gated = !pr.draft && (filesTruncated || files.some(isUiPath));
    const embeds =
      typeof pr.body_html === "string" ? renderedImages(pr.body_html) : extractImageEmbeds(body);
    const preliminary = decideGate({
      draft: pr.draft,
      files,
      filesTruncated,
      body,
      waived: false,
      embeds: gated ? await checkEmbeds(embeds, { sleep: wait }) : undefined,
    });
    decision =
      (preliminary.outcome === "missing" || preliminary.outcome === "inconclusive") &&
      (await labelWaiver({ repoPath, number, labels, options, log }))
        ? { ...preliminary, outcome: "pass", reason: "waived by the " + WAIVER_LABEL + " label" }
        : preliminary;
  } catch (error) {
    decision = {
      outcome: "inconclusive",
      reason: "could not inspect PR #" + number + ": " + error.message,
      uiFiles: [],
      brokenEmbeds: [],
    };
  }

  log(decision.outcome + ": " + decision.reason);
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown({ number, mode, decision }));
  }
  try {
    await syncInconclusiveCheck({
      repoPath,
      headSha: event.pull_request?.head?.sha,
      decision,
      options,
    });
  } catch (error) {
    console.log(
      "::warning title=PR screenshot gate::could not synchronize inconclusive check: " +
        error.message,
    );
  }
  if (decision.outcome === "inconclusive") {
    const level = mode === "enforce" ? "error" : "warning";
    console.log("::" + level + " title=PR screenshot gate::inconclusive: " + decision.reason);
    return mode === "enforce" ? 1 : 0;
  }
  if (decision.outcome !== "missing") return 0;
  const message =
    (decision.brokenEmbeds.length > 0
      ? "Screenshots in the PR description do not load: " +
        decision.brokenEmbeds.map(describeEmbed).join("; ") +
        ". Re-upload them with " +
        UPLOAD_HINT +
        ", or ask a maintainer for the "
      : "UI paths changed but the PR description has no screenshot. Embed one, or ask a maintainer for the ") +
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
  hasScreenshotEvidence,
  extractImageEmbeds,
  renderedImages,
  parseGithubContentUrl,
  staticEmbedProblem,
  verifyImageUrl,
  checkEmbeds,
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
