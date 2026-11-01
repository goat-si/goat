// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - a maintainer CLI that shells out to git and gh.
// Upload PR screenshots to the orphan pr-assets branch and link them by commit
// SHA, so they render on GitHub web and mobile. See AGENTS.md "Pull requests".
//
//   node scripts/pr-assets.ts upload <pr> <files...> [--patch-body]
//   node scripts/pr-assets.ts fix-body <pr> [--dry-run]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

export const ASSETS_BRANCH = "pr-assets";
const DEFAULT_REPO = "goat-si/goat";
const PUSH_ATTEMPTS = 5;

interface ImageEmbed {
  readonly kind: "markdown" | "html" | "reference";
  readonly url: string;
  readonly start: number;
  readonly end: number;
}

interface GithubContentUrl {
  readonly owner: string;
  readonly repo: string;
  readonly view: "raw" | "blob";
  readonly ref: string;
  readonly path: string;
}

type ImageCheck =
  | { readonly status: "ok" }
  | { readonly status: "broken" | "unverified"; readonly reason: string };

// The gate owns what counts as a working embed; reuse it so the helper fixes
// exactly what the gate rejects.
const gate = NodeModule.createRequire(import.meta.url)(
  "../.github/scripts/pr-screenshot-gate.cjs",
) as {
  extractImageEmbeds(body: string): ReadonlyArray<ImageEmbed>;
  renderedImages(html: string): ReadonlyArray<{ readonly url: string }>;
  staticEmbedProblem(url: string): string | null;
  parseGithubContentUrl(url: string): GithubContentUrl | null;
  verifyImageUrl(url: string): Promise<ImageCheck>;
};

export function rawAssetUrl(repo: string, sha: string, path: string): string {
  // encodeURIComponent keeps !'()*, and a bare ")" would end a markdown image early.
  const encode = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (char) => "%" + char.charCodeAt(0).toString(16).toUpperCase(),
    );
  const encoded = path.split("/").map(encode).join("/");
  return "https://raw.githubusercontent.com/" + repo + "/" + sha + "/" + encoded;
}

export function assetPath(pr: number, file: string): string {
  return pr + "/" + NodePath.basename(file);
}

export function markdownFor(repo: string, sha: string, paths: ReadonlyArray<string>): string {
  return paths
    .map((path) => {
      const alt = NodePath.basename(path).replace(/\.[^.]+$/, "");
      return "![" + alt + "](" + rawAssetUrl(repo, sha, path) + ")";
    })
    .join("\n");
}

/** Asset paths an embed may mean, most specific first. */
function candidatePaths(pr: number, url: string): ReadonlyArray<string> {
  const github = gate.parseGithubContentUrl(url);
  const local = url.replace(/[?#].*$/, "");
  let decoded = local;
  try {
    decoded = decodeURIComponent(local);
  } catch {}
  const path = github
    ? github.path
    : decoded.replace(/^(?:\.\/|\/)+/, "").replace(new RegExp("^" + ASSETS_BRANCH + "/"), "");
  const fallback = assetPath(pr, path);
  return path === fallback ? [path] : [path, fallback];
}

export interface BodyFix {
  readonly body: string;
  readonly replaced: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly missing: ReadonlyArray<{ readonly url: string; readonly reason: string }>;
}

/**
 * Point every embed the gate rejects by URL alone at the commit-SHA raw URL
 * of the same file on pr-assets. Only the URL text changes; every other byte
 * of the body is kept. An embed whose file is not on pr-assets is reported,
 * never guessed.
 */
/** GitHub percent-encodes spaces and non-ASCII in rendered URLs; compare both sides in that form. */
function normalizeUrl(url: string): string {
  let decoded = url;
  try {
    decoded = decodeURI(url);
  } catch {}
  return encodeURI(decoded);
}

export function planBodyFix(
  body: string,
  options: {
    readonly pr: number;
    readonly repo: string;
    readonly sha: string;
    readonly assets: ReadonlySet<string>;
    /** URLs of the images GitHub renders; an embed outside it is example text, not an image. */
    readonly rendered?: ReadonlySet<string>;
  },
): BodyFix {
  const replaced: Array<{ from: string; to: string; start: number; end: number }> = [];
  const missing: Array<{ url: string; reason: string }> = [];
  const rendered = options.rendered ? new Set([...options.rendered].map(normalizeUrl)) : null;
  const located = new Set<string>();
  for (const embed of gate.extractImageEmbeds(body)) {
    const key = normalizeUrl(embed.url);
    if (rendered && !rendered.has(key)) continue;
    located.add(key);
    const problem = gate.staticEmbedProblem(embed.url);
    if (!problem) continue;
    const github = gate.parseGithubContentUrl(embed.url);
    // A SHA-pinned blob page only needs the raw form of the same file.
    const to =
      github && /^[0-9a-f]{40}$/i.test(github.ref)
        ? rawAssetUrl(github.owner + "/" + github.repo, github.ref, github.path)
        : (() => {
            const path = candidatePaths(options.pr, embed.url).find((p) => options.assets.has(p));
            return path ? rawAssetUrl(options.repo, options.sha, path) : null;
          })();
    if (to === null) {
      missing.push({ url: embed.url, reason: problem + "; no matching file on " + ASSETS_BRANCH });
      continue;
    }
    replaced.push({
      from: body.slice(embed.start, embed.end),
      to,
      start: embed.start,
      end: embed.end,
    });
  }
  // A broken image GitHub renders but the source scan did not find must not pass as fixed.
  for (const url of options.rendered ?? []) {
    const problem = gate.staticEmbedProblem(url);
    if (problem && !located.has(normalizeUrl(url))) {
      missing.push({ url, reason: problem + "; could not locate it in the description source" });
    }
  }
  let next = body;
  for (const edit of [...replaced].sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.to + next.slice(edit.end);
  }
  return { body: next, replaced: replaced.map(({ from, to }) => ({ from, to })), missing };
}

interface GitOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}

function git(args: ReadonlyArray<string>, { cwd, env }: GitOptions): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Current pr-assets tip on the remote, fetched into the object store, or null when absent. */
export function fetchAssetsTip(cwd: string, remote: string): string | null {
  const listed = git(["ls-remote", "--heads", remote, ASSETS_BRANCH], { cwd });
  if (!listed) return null;
  // A private ref keeps the fetched commit addressable without touching
  // branches, FETCH_HEAD, or the worktree.
  const ref = "refs/pr-assets-helper/" + process.pid + "-" + Date.now();
  try {
    git(
      [
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        remote,
        "+refs/heads/" + ASSETS_BRANCH + ":" + ref,
      ],
      { cwd },
    );
    return git(["rev-parse", ref], { cwd });
  } finally {
    // Cleanup must not hide a fetch failure.
    try {
      git(["update-ref", "-d", ref], { cwd });
    } catch {}
  }
}

export function listAssets(cwd: string, sha: string, pr: number): ReadonlySet<string> {
  // -z: without it git quotes and escapes non-ASCII names.
  const out = git(["ls-tree", "-r", "-z", "--name-only", sha, "--", pr + "/"], { cwd });
  return new Set(out.split("\0").filter(Boolean));
}

/**
 * Commit files on top of parent (or as a root commit) through a throwaway
 * index, leaving HEAD, the real index, and the worktree alone. Returns parent
 * unchanged when every file already matches.
 */
export function buildAssetsCommit(
  cwd: string,
  parent: string | null,
  files: ReadonlyArray<{ readonly path: string; readonly file: string }>,
  message: string,
): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pr-assets-index-"));
  const env = { GIT_INDEX_FILE: NodePath.join(dir, "index") };
  try {
    git(parent ? ["read-tree", parent] : ["read-tree", "--empty"], { cwd, env });
    for (const { path, file } of files) {
      const blob = git(["hash-object", "-w", "--", NodePath.resolve(file)], { cwd });
      git(["update-index", "--add", "--cacheinfo", "100644," + blob + "," + path], { cwd, env });
    }
    const tree = git(["write-tree"], { cwd, env });
    if (parent && tree === git(["rev-parse", parent + "^{tree}"], { cwd })) return parent;
    return git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message], { cwd });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}

class PushRejectedError extends Error {}

/** Fast-forward pr-assets to sha. Never forces; a moved branch is a PushRejectedError. */
function pushAssets(cwd: string, remote: string, sha: string): void {
  try {
    git(["push", "--quiet", remote, sha + ":refs/heads/" + ASSETS_BRANCH], { cwd });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    if (/rejected|non-fast-forward|fetch first|stale info|cannot lock ref/i.test(stderr)) {
      throw new PushRejectedError(stderr.trim());
    }
    throw new Error("git push failed: " + stderr.trim(), { cause: error });
  }
}

export interface UploadResult {
  readonly sha: string;
  readonly paths: ReadonlyArray<string>;
}

/**
 * Commit files to pr-assets as <pr>/<basename> and push. When another upload
 * moves the branch first, rebuild on the new tip and try again.
 */
export function uploadAssets(options: {
  readonly cwd: string;
  readonly remote: string;
  readonly pr: number;
  readonly files: ReadonlyArray<string>;
  /** Test seam: runs after the commit is built and before it is pushed. */
  readonly beforePush?: (attempt: number) => void;
}): UploadResult {
  const entries = options.files.map((file) => {
    if (!NodeFS.statSync(file).isFile()) throw new Error(file + " is not a file");
    return { path: assetPath(options.pr, file), file };
  });
  const duplicate = entries.find(
    (entry, index) => entries.findIndex((other) => other.path === entry.path) !== index,
  );
  if (duplicate) throw new Error("two files would both upload as " + duplicate.path);
  const paths = entries.map((entry) => entry.path);
  for (let attempt = 1; ; attempt += 1) {
    const parent = fetchAssetsTip(options.cwd, options.remote);
    const sha = buildAssetsCommit(
      options.cwd,
      parent,
      entries,
      ASSETS_BRANCH + ": #" + options.pr + " " + paths.map((p) => NodePath.basename(p)).join(", "),
    );
    if (sha === parent) return { sha, paths };
    options.beforePush?.(attempt);
    try {
      pushAssets(options.cwd, options.remote, sha);
      return { sha, paths };
    } catch (error) {
      if (!(error instanceof PushRejectedError) || attempt >= PUSH_ATTEMPTS) throw error;
    }
  }
}

/** Poll until each URL serves an image; raw.githubusercontent.com can lag a fresh push briefly. */
export async function waitForImages(
  urls: ReadonlyArray<string>,
  {
    deadlineMs = 60_000,
    intervalMs = 2_000,
    verify = gate.verifyImageUrl,
  }: {
    readonly deadlineMs?: number;
    readonly intervalMs?: number;
    readonly verify?: (url: string) => Promise<ImageCheck>;
  } = {},
): Promise<ReadonlyArray<{ readonly url: string; readonly check: ImageCheck }>> {
  const deadline = Date.now() + deadlineMs;
  return Promise.all(
    urls.map(async (url) => {
      for (;;) {
        const check = await verify(url);
        if (check.status === "ok" || Date.now() + intervalMs > deadline) return { url, check };
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }),
  );
}

function gh(args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
}

export interface PrBodyStore {
  readonly read: () => { readonly body: string; readonly rendered: ReadonlySet<string> };
  readonly write: (bodyFile: string) => void;
}

function ghBodyStore(repo: string, pr: number): PrBodyStore {
  return {
    read: () => {
      const out = gh([
        "api",
        "-H",
        "Accept: application/vnd.github.full+json",
        "repos/" + repo + "/pulls/" + pr,
      ]);
      const { body, body_html } = JSON.parse(out) as { body: string | null; body_html?: string };
      return {
        body: body ?? "",
        rendered: new Set(gate.renderedImages(body_html ?? "").map((image) => image.url)),
      };
    },
    write: (bodyFile) => {
      gh(["pr", "edit", String(pr), "-R", repo, "--body-file", bodyFile]);
    },
  };
}

/**
 * Rewrite the PR description's broken embeds, keeping copies of the old and
 * new body, and confirm GitHub stored exactly the new body. GitHub has no
 * conditional update, so the body is read again just before the write and a
 * change made while images were being checked stops the rewrite.
 */
export async function patchPrBody(options: {
  readonly cwd: string;
  readonly repo: string;
  readonly pr: number;
  readonly sha: string;
  readonly dryRun: boolean;
  readonly backupDir: string;
  readonly store?: PrBodyStore;
  readonly verify?: (url: string) => Promise<ImageCheck>;
}): Promise<boolean> {
  const store = options.store ?? ghBodyStore(options.repo, options.pr);
  const { body: before, rendered } = store.read();
  const fix = planBodyFix(before, {
    rendered,
    pr: options.pr,
    repo: options.repo,
    sha: options.sha,
    assets: listAssets(options.cwd, options.sha, options.pr),
  });
  for (const { from, to } of fix.replaced) console.log("rewrite " + from + "\n     -> " + to);
  for (const { url, reason } of fix.missing) console.log("cannot fix " + url + ": " + reason);
  if (fix.replaced.length === 0) {
    console.log("PR #" + options.pr + ": no embed to rewrite");
    return fix.missing.length === 0;
  }
  const checks = await waitForImages(
    fix.replaced.map(({ to }) => to),
    options.verify ? { verify: options.verify } : {},
  );
  const failed = checks.filter(({ check }) => check.status !== "ok");
  for (const { url, check } of failed) {
    console.log(
      "not rewriting: " +
        url +
        " does not load (" +
        (check.status === "ok" ? "" : check.reason) +
        ")",
    );
  }
  if (failed.length > 0 || options.dryRun) {
    if (options.dryRun) console.log("dry run: PR #" + options.pr + " body left unchanged");
    return failed.length === 0 && fix.missing.length === 0;
  }
  if (store.read().body !== before) {
    throw new Error(
      "PR #" + options.pr + " description changed while images were checked; run the command again",
    );
  }
  NodeFS.mkdirSync(options.backupDir, { recursive: true });
  const beforeFile = NodePath.join(options.backupDir, "before.md");
  const afterFile = NodePath.join(options.backupDir, "after.md");
  NodeFS.writeFileSync(beforeFile, before);
  NodeFS.writeFileSync(afterFile, fix.body);
  store.write(afterFile);
  const stored = store.read().body;
  if (stored !== fix.body) {
    throw new Error("PR #" + options.pr + " body differs from " + afterFile + " after the edit");
  }
  console.log(
    "PR #" +
      options.pr +
      ": rewrote " +
      fix.replaced.length +
      " embeds; copies in " +
      options.backupDir,
  );
  return fix.missing.length === 0;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = NodeUtil.parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      repo: { type: "string", default: DEFAULT_REPO },
      remote: { type: "string", default: "origin" },
      "patch-body": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "backup-dir": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, prArg, ...files] = positionals;
  const pr = Number(prArg);
  if (values.help || !command || !Number.isInteger(pr) || pr <= 0) {
    console.log(
      [
        "usage: node scripts/pr-assets.ts upload <pr> <files...> [--patch-body] [--dry-run]",
        "       node scripts/pr-assets.ts fix-body <pr> [--dry-run]",
        "options: --repo owner/name (" +
          DEFAULT_REPO +
          "), --remote name (origin), --backup-dir dir",
      ].join("\n"),
    );
    return values.help ? 0 : 2;
  }
  const cwd = process.cwd();
  const backupDir =
    values["backup-dir"] ?? NodePath.join(NodeOS.tmpdir(), "goat-pr-body-fixes", String(pr));
  const bodyOptions = { cwd, repo: values.repo, pr, dryRun: values["dry-run"], backupDir };

  if (command === "fix-body") {
    const sha = fetchAssetsTip(cwd, values.remote);
    if (!sha)
      throw new Error("the " + ASSETS_BRANCH + " branch does not exist on " + values.remote);
    return (await patchPrBody({ ...bodyOptions, sha })) ? 0 : 1;
  }
  if (command !== "upload" || files.length === 0) {
    console.error("unknown command or no files; run with --help");
    return 2;
  }
  if (values["dry-run"]) {
    for (const file of files) console.log("would upload " + file + " as " + assetPath(pr, file));
    return 0;
  }
  const { sha, paths } = uploadAssets({ cwd, remote: values.remote, pr, files });
  const checks = await waitForImages(paths.map((path) => rawAssetUrl(values.repo, sha, path)));
  for (const { url, check } of checks) {
    console.error(
      (check.status === "ok" ? "200 " : check.status + " (" + check.reason + ") ") + url,
    );
  }
  console.log(markdownFor(values.repo, sha, paths));
  const loaded = checks.every(({ check }) => check.status === "ok");
  if (!values["patch-body"]) return loaded ? 0 : 1;
  return (await patchPrBody({ ...bodyOptions, sha })) && loaded ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
