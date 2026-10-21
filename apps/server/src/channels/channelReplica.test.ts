// @effect-diagnostics nodeBuiltinImport:off - runs the replica scripts with a real sh and git in temp repositories.
import * as NodeBuffer from "node:buffer";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { hostCanStoreFileName } from "@goat/shared/testing/fileNames";

import {
  applyReplicaScript,
  captureReplicaScript,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_UNTRACKED_FILE_BYTES,
  parseApplyOutput,
  parseReplicaOutput,
  replicaRefFor,
  resumeBranchFor,
} from "./channelReplica.ts";

const HEAD = "a".repeat(40);
const COMMIT = "b".repeat(40);
const REF = replicaRefFor("test", 1);
const TARGET = `refs/heads/${resumeBranchFor("test", 1)}`;
const payload = NodeBuffer.Buffer.from("bundle fixture");
const output = (excluded: string[] = []) =>
  [
    "GOAT_REPLICA_OK",
    `HEAD ${HEAD}`,
    `COMMIT ${COMMIT}`,
    `BYTES ${payload.length}`,
    `EXCLUDED ${NodeBuffer.Buffer.from(excluded.length === 0 ? "" : `${excluded.join("\0")}\0`).toString("base64")}`,
    "GOAT_REPLICA_BUNDLE_BEGIN",
    payload.toString("base64"),
    "GOAT_REPLICA_BUNDLE_END",
    "",
  ].join("\n");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});

/** Windows cannot store a newline in a path, so it keeps the quote and space around it. */
const storableName = (name: string) =>
  hostCanStoreFileName(name) ? name : name.replaceAll("\n", "");

// Remote hosts run these scripts under a POSIX sh; on Windows one exists only via Git Bash.
const posixShellAvailable = NodeChildProcess.spawnSync("sh", ["-c", "exit 0"]).status === 0;

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-channel-replica-"));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const temp = NodePath.join(root, "temp");
  NodeFS.mkdirSync(home);
  NodeFS.mkdirSync(temp);
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(home, "no-config"),
    GIT_CONFIG_COUNT: "0",
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_LITERAL_PATHSPECS: undefined,
    GIT_AUTHOR_NAME: "Replica Test",
    GIT_AUTHOR_EMAIL: "replica-test@example.invalid",
    GIT_COMMITTER_NAME: "Replica Test",
    GIT_COMMITTER_EMAIL: "replica-test@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd, env, encoding: "utf8" });
  const init = (name: string) => {
    const cwd = NodePath.join(root, name);
    git(root, "init", "--quiet", "--initial-branch=main", cwd);
    return cwd;
  };
  const repo = init(storableName("source's repo\n"));
  NodeFS.writeFileSync(NodePath.join(repo, "tracked.txt"), "original\n");
  NodeFS.writeFileSync(NodePath.join(repo, "staged.txt"), "original staged\n");
  NodeFS.writeFileSync(NodePath.join(repo, "deleted.txt"), "delete me\n");
  NodeFS.writeFileSync(NodePath.join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "base");
  const head = git(repo, "rev-parse", "HEAD").trim();
  const shell = (script: string) => {
    const result = NodeChildProcess.spawnSync("sh", ["-s"], {
      cwd: root,
      env,
      input: script,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(
      NodeFS.readdirSync(temp),
      [],
      "script temporary files must be cleaned up",
    );
    return result.stdout;
  };
  const capture = (overrides: Partial<Parameters<typeof captureReplicaScript>[0]> = {}) =>
    parseReplicaOutput(
      shell(
        captureReplicaScript({
          cwd: repo,
          branch: "main",
          replicaRef: REF,
          maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
          maxUntrackedFileBytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
          ...overrides,
        }),
      ),
    );
  const clone = (remote: string, name = "target") => {
    const cwd = NodePath.join(root, name);
    git(root, "clone", "--quiet", remote, cwd);
    return cwd;
  };
  const origin = () => {
    const bare = NodePath.join(root, "origin.git");
    git(root, "init", "--quiet", "--bare", "--initial-branch=main", bare);
    git(repo, "remote", "add", "origin", bare);
    git(repo, "push", "--quiet", "-u", "origin", "main");
    return bare;
  };
  return { root, repo, head, git, shell, init, capture, clone, origin };
}

describe("replica names and script inputs", () => {
  it("produces safe refs and uses the requested size defaults", () => {
    assert.strictEqual(DEFAULT_MAX_BUNDLE_BYTES, 8 * 1024 * 1024);
    assert.strictEqual(DEFAULT_MAX_UNTRACKED_FILE_BYTES, 2 * 1024 * 1024);
    assert.strictEqual(replicaRefFor("task-17", 2), "refs/goat/replicas/task-17/2");
    assert.strictEqual(resumeBranchFor("task-17", 2), "goat/replica/task-17-2");
    const { repo, git } = fixture();
    for (const id of ["", "../x.lock", "a@{b}\\c", "한 글\n'", "-", "..."]) {
      git(repo, "check-ref-format", replicaRefFor(id, 0));
      git(repo, "check-ref-format", `refs/heads/${resumeBranchFor(id, 0)}`);
    }
    for (const generation of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => replicaRefFor("task", generation), RangeError);
      assert.throws(() => resumeBranchFor("task", generation), RangeError);
    }
  });

  it("rejects NUL, invalid byte limits and injectable bundle text before producing shell", () => {
    const input = {
      cwd: "/repo",
      replicaRef: REF,
      maxBundleBytes: 1,
      maxUntrackedFileBytes: 1,
    };
    assert.throws(() => captureReplicaScript({ ...input, cwd: "bad\0path" }), TypeError);
    assert.throws(() => captureReplicaScript({ ...input, maxBundleBytes: -1 }), RangeError);
    assert.throws(() => captureReplicaScript({ ...input, maxUntrackedFileBytes: 0.1 }), RangeError);
    for (const bundleBase64 of ["", "YQ==\nGOAT_REPLICA_DATA\ntouch /tmp/no", "Y!==", "YR=="]) {
      assert.throws(
        () =>
          applyReplicaScript({ cwd: "/repo", replicaRef: REF, targetRef: TARGET, bundleBase64 }),
        TypeError,
      );
    }
  });
});

describe("parseReplicaOutput", () => {
  it("parses success, multiline base64, CRLF and names with whitespace and quotes", () => {
    const excluded = [".env", "a b\n'private.key", "tail\n"];
    const encoded = payload.toString("base64");
    const stdout = output(excluded).replace(encoded, `${encoded.slice(0, 4)}\n${encoded.slice(4)}`);
    assert.deepStrictEqual(parseReplicaOutput(stdout.replaceAll("\n", "\r\n")), {
      type: "ok",
      headOid: HEAD,
      commitOid: COMMIT,
      bytes: payload.length,
      excluded,
      bundleBase64: encoded,
    });
    assert.strictEqual(
      parseReplicaOutput(
        output().replaceAll(HEAD, "a".repeat(64)).replaceAll(COMMIT, "b".repeat(64)),
      ).type,
      "ok",
    );
  });

  it("parses no-worktree and size-limit responses", () => {
    assert.deepStrictEqual(parseReplicaOutput("GOAT_REPLICA_NO_WORKTREE\n"), {
      type: "no_worktree",
    });
    assert.deepStrictEqual(parseReplicaOutput("GOAT_REPLICA_TOO_LARGE 123\n"), {
      type: "too_large",
      bytes: 123,
    });
  });

  it("rejects malformed, truncated and contradictory responses", () => {
    const valid = output();
    for (const stdout of [
      "",
      "noise\n" + valid,
      valid + "extra\n",
      "GOAT_REPLICA_NO_WORKTREE\nGOAT_REPLICA_TOO_LARGE 1\n",
      "GOAT_REPLICA_TOO_LARGE -1",
      "GOAT_REPLICA_TOO_LARGE 01",
      "GOAT_REPLICA_TOO_LARGE 9007199254740992",
      valid.replace(HEAD, "a".repeat(39)),
      valid.replace(COMMIT, "b".repeat(64)),
      valid.replace(COMMIT, "B".repeat(40)),
      valid.replace(`BYTES ${payload.length}`, "BYTES 0"),
      valid.replace(`BYTES ${payload.length}`, "BYTES 1"),
      valid.replace(`BYTES ${payload.length}`, "BYTES NaN"),
      valid.replace("EXCLUDED ", "EXCLUDED YQ=="), // Missing NUL terminator.
      valid.replace("EXCLUDED ", "EXCLUDED AA=="), // Empty filename.
      valid.replace("EXCLUDED ", "EXCLUDED /wA="), // Invalid UTF-8 filename.
      valid.replace(payload.toString("base64"), "Y!=="),
      valid.replace(payload.toString("base64"), "YR=="),
      valid.replace(payload.toString("base64"), "YQ="),
      valid.replace(payload.toString("base64"), "Y Q=="),
      valid.replace("GOAT_REPLICA_BUNDLE_END\n", ""),
      valid.replace("COMMIT ", "HEAD "),
    ]) {
      assert.deepStrictEqual(parseReplicaOutput(stdout), { type: "invalid" }, stdout);
    }
  });
});

describe("parseApplyOutput", () => {
  it("parses every apply result and both object formats", () => {
    for (const oid of [HEAD, "a".repeat(64)]) {
      assert.deepStrictEqual(parseApplyOutput(`GOAT_REPLICA_APPLIED ${oid}\r\n`), {
        type: "applied",
        oid,
      });
    }
    assert.deepStrictEqual(parseApplyOutput(`GOAT_REPLICA_BASE_MISSING\n${HEAD}\n${COMMIT}\n`), {
      type: "base_missing",
      missing: [HEAD, COMMIT],
    });
    assert.deepStrictEqual(parseApplyOutput("GOAT_REPLICA_BASE_MISSING\n"), {
      type: "base_missing",
      missing: [],
    });
    assert.deepStrictEqual(parseApplyOutput("GOAT_REPLICA_REF_CONFLICT\n"), {
      type: "ref_conflict",
    });
  });

  it("rejects noise, invalid OIDs, duplicate outcomes and truncated markers", () => {
    for (const stdout of [
      "",
      "GOAT_REPLICA_APPLIED",
      `GOAT_REPLICA_APPLIED ${"a".repeat(39)}`,
      `GOAT_REPLICA_APPLIED ${"A".repeat(40)}`,
      `noise\nGOAT_REPLICA_APPLIED ${HEAD}`,
      `GOAT_REPLICA_APPLIED ${HEAD}\nGOAT_REPLICA_REF_CONFLICT`,
      "GOAT_REPLICA_BASE_MISSING\nnot-an-oid",
      "GOAT_REPLICA_BASE_MISSING\n\n",
      "GOAT_REPLICA_REF_CONFLICT\nextra",
    ])
      assert.deepStrictEqual(parseApplyOutput(stdout), { type: "invalid" }, stdout);
  });
});

describe.skipIf(!posixShellAvailable)("replica scripts with real Git repositories", () => {
  it("captures dirty and staged files, exclusions and hostile filenames while preserving HEAD and index", () => {
    const f = fixture();
    NodeFS.writeFileSync(NodePath.join(f.repo, "tracked.txt"), "unstaged\n");
    NodeFS.writeFileSync(NodePath.join(f.repo, "staged.txt"), "staged version\n");
    f.git(f.repo, "add", "staged.txt");
    NodeFS.writeFileSync(NodePath.join(f.repo, "staged.txt"), "staged plus unstaged\n");
    NodeFS.rmSync(NodePath.join(f.repo, "deleted.txt"));
    const names = [
      "a space.txt",
      "line\nbreak.txt",
      "quote'\".txt",
      ":(glob)*.txt",
      "-option.txt",
      "dollar$(literal)`literal`.txt",
      "tail\n",
    ].filter(hostCanStoreFileName);
    for (const name of names) NodeFS.writeFileSync(NodePath.join(f.repo, name), name);
    NodeFS.writeFileSync(NodePath.join(f.repo, "new-staged.txt"), "newly staged\n");
    f.git(f.repo, "add", "new-staged.txt");
    const excluded = [
      ".env",
      ".env.local",
      "private.pem",
      "private.key",
      "private.p12",
      "id_rsa.pub",
      "id_ed25519",
      "large.bin",
      "line\n'private.key",
    ].filter(hostCanStoreFileName);
    for (const name of excluded)
      NodeFS.writeFileSync(NodePath.join(f.repo, name), "x".repeat(name === "large.bin" ? 129 : 6));
    NodeFS.mkdirSync(NodePath.join(f.repo, "nested"));
    NodeFS.writeFileSync(NodePath.join(f.repo, "nested", ".env"), "secret");
    NodeFS.writeFileSync(NodePath.join(f.repo, "ignored.txt"), "ignored");
    const indexPath = f.git(f.repo, "rev-parse", "--git-path", "index").trim();
    const index = NodeFS.readFileSync(NodePath.join(f.repo, indexPath));
    const staged = f.git(f.repo, "diff", "--cached", "--binary");
    const result = f.capture({ maxUntrackedFileBytes: 128 });
    assert.strictEqual(result.type, "ok");
    if (result.type !== "ok") return;
    assert.strictEqual(result.headOid, f.head);
    assert.sameMembers(result.excluded, [...excluded, "nested/.env"]);
    assert.strictEqual(f.git(f.repo, "rev-parse", "HEAD").trim(), f.head);
    assert.strictEqual(f.git(f.repo, "symbolic-ref", "HEAD").trim(), "refs/heads/main");
    assert.deepStrictEqual(NodeFS.readFileSync(NodePath.join(f.repo, indexPath)), index);
    assert.strictEqual(f.git(f.repo, "diff", "--cached", "--binary"), staged);
    assert.strictEqual(f.git(f.repo, "show", `${result.commitOid}:tracked.txt`), "unstaged\n");
    assert.strictEqual(
      f.git(f.repo, "show", `${result.commitOid}:staged.txt`),
      "staged plus unstaged\n",
    );
    assert.strictEqual(
      f.git(f.repo, "show", `${result.commitOid}:new-staged.txt`),
      "newly staged\n",
    );
    for (const name of names)
      assert.strictEqual(f.git(f.repo, "show", `${result.commitOid}:${name}`), name);
    const paths = f.git(f.repo, "ls-tree", "-r", "--name-only", "-z", result.commitOid).split("\0");
    for (const name of [...excluded, "nested/.env", "ignored.txt", "deleted.txt"])
      assert.notInclude(paths, name);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(f.repo, "tracked.txt"), "utf8"),
      "unstaged\n",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(f.repo, "deleted.txt")));
  });

  it("leaves out new secret-looking and oversized files the worker staged itself", () => {
    const f = fixture();
    NodeFS.writeFileSync(NodePath.join(f.repo, "private.key"), "secret");
    NodeFS.writeFileSync(NodePath.join(f.repo, "staged-large.bin"), "x".repeat(129));
    NodeFS.writeFileSync(NodePath.join(f.repo, "staged-small.txt"), "small\n");
    f.git(f.repo, "add", "private.key", "staged-large.bin", "staged-small.txt");
    const staged = f.git(f.repo, "diff", "--cached", "--name-only");
    const result = f.capture({ maxUntrackedFileBytes: 128 });
    assert.strictEqual(result.type, "ok");
    if (result.type !== "ok") return;
    assert.sameMembers(result.excluded, ["private.key", "staged-large.bin"]);
    const paths = f.git(f.repo, "ls-tree", "-r", "--name-only", "-z", result.commitOid).split("\0");
    assert.include(paths, "staged-small.txt");
    assert.notInclude(paths, "private.key");
    assert.notInclude(paths, "staged-large.bin");
    // The worker's own index still has everything it staged.
    assert.strictEqual(f.git(f.repo, "diff", "--cached", "--name-only"), staged);
  });

  it("finds the worker worktree with a newline path and supports root strategy without branch", () => {
    const f = fixture();
    const worker = NodePath.join(f.root, storableName("worker ' space\n"));
    f.git(f.repo, "worktree", "add", "--quiet", "-b", "goat/channel/test", worker);
    NodeFS.writeFileSync(NodePath.join(worker, "tracked.txt"), "worker tree\n");
    const result = f.capture({ branch: "goat/channel/test" });
    assert.strictEqual(result.type, "ok");
    if (result.type !== "ok") return;
    assert.strictEqual(f.git(f.repo, "show", `${result.commitOid}:tracked.txt`), "worker tree\n");
    assert.strictEqual(f.git(f.repo, "rev-parse", "HEAD").trim(), f.head);
    assert.deepStrictEqual(f.capture({ branch: "missing" }), { type: "no_worktree" });
    f.git(f.repo, "checkout", "--quiet", "--detach");
    const root = parseReplicaOutput(
      f.shell(
        captureReplicaScript({
          cwd: f.repo,
          replicaRef: REF,
          maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
          maxUntrackedFileBytes: DEFAULT_MAX_UNTRACKED_FILE_BYTES,
        }),
      ),
    );
    assert.strictEqual(root.type, "ok");
    if (root.type === "ok") assert.strictEqual(root.headOid, f.head);
  });

  it("excludes remote history from the bundle and applies the exact snapshot tree idempotently", () => {
    const f = fixture();
    const bare = f.origin();
    const target = f.clone(bare);
    NodeFS.writeFileSync(NodePath.join(f.repo, "tracked.txt"), "replicated\n");
    NodeFS.writeFileSync(NodePath.join(f.repo, "extra.txt"), "new\n");
    const result = f.capture();
    assert.strictEqual(result.type, "ok");
    if (result.type !== "ok") return;
    const bundle = NodeBuffer.Buffer.from(result.bundleBase64, "base64");
    assert.include(bundle.subarray(0, bundle.indexOf("\n\n")).toString(), `-${f.head} `);
    const apply = () =>
      parseApplyOutput(
        f.shell(
          applyReplicaScript({
            cwd: target,
            bundleBase64: result.bundleBase64,
            replicaRef: REF,
            targetRef: TARGET,
          }),
        ),
      );
    assert.deepStrictEqual(apply(), { type: "applied", oid: result.commitOid });
    assert.strictEqual(
      f.git(target, "rev-parse", `${TARGET}^{tree}`).trim(),
      f.git(f.repo, "rev-parse", `${result.commitOid}^{tree}`).trim(),
    );
    assert.strictEqual(f.git(target, "rev-parse", "HEAD").trim(), f.head);
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(target, "tracked.txt"), "utf8"),
      "original\n",
    );
    assert.deepStrictEqual(apply(), { type: "applied", oid: result.commitOid });
    f.git(target, "update-ref", TARGET, f.head);
    assert.deepStrictEqual(apply(), { type: "ref_conflict" });
    assert.strictEqual(f.git(target, "rev-parse", TARGET).trim(), f.head);
  });

  it("reports the missing prerequisite in a target without the source history", () => {
    const f = fixture();
    f.origin();
    const result = f.capture();
    assert.strictEqual(result.type, "ok");
    if (result.type !== "ok") return;
    const target = f.init("empty");
    assert.deepStrictEqual(
      parseApplyOutput(
        f.shell(
          applyReplicaScript({
            cwd: target,
            bundleBase64: result.bundleBase64,
            replicaRef: REF,
            targetRef: TARGET,
          }),
        ),
      ),
      { type: "base_missing", missing: [f.head] },
    );
    assert.strictEqual(f.git(target, "for-each-ref"), "");
  });

  it("uses a full bundle without remote refs and falls back when the snapshot is already remote", () => {
    const f = fixture();
    const first = f.capture();
    assert.strictEqual(first.type, "ok");
    if (first.type !== "ok") return;
    const target = f.init("empty-target");
    assert.deepStrictEqual(
      parseApplyOutput(
        f.shell(
          applyReplicaScript({
            cwd: target,
            bundleBase64: first.bundleBase64,
            replicaRef: REF,
            targetRef: TARGET,
          }),
        ),
      ),
      { type: "applied", oid: first.commitOid },
    );
    f.origin();
    f.git(f.repo, "update-ref", "refs/remotes/origin/replica", first.commitOid);
    const retry = f.capture();
    assert.strictEqual(retry.type, "ok");
    if (retry.type !== "ok") return;
    assert.strictEqual(retry.commitOid, first.commitOid);
    const bundle = NodeBuffer.Buffer.from(retry.bundleBase64, "base64");
    assert.notInclude(bundle.subarray(0, bundle.indexOf("\n\n")).toString(), `-${f.head} `);
  });

  it("replaces a symbolic replica ref without following it to the user branch", () => {
    const f = fixture();
    f.git(f.repo, "symbolic-ref", REF, "refs/heads/main");
    NodeFS.writeFileSync(NodePath.join(f.repo, "tracked.txt"), "changed\n");
    const result = f.capture();
    assert.strictEqual(result.type, "ok");
    assert.strictEqual(f.git(f.repo, "rev-parse", "refs/heads/main").trim(), f.head);
    if (result.type === "ok")
      assert.strictEqual(f.git(f.repo, "rev-parse", REF).trim(), result.commitOid);
  });

  it("enforces bundle limits without changing HEAD or the index", () => {
    const f = fixture();
    const before = NodeFS.readFileSync(NodePath.join(f.repo, ".git", "index"));
    const result = f.capture({ maxBundleBytes: 1 });
    assert.strictEqual(result.type, "too_large");
    if (result.type === "too_large") assert.isAbove(result.bytes, 1);
    assert.deepStrictEqual(NodeFS.readFileSync(NodePath.join(f.repo, ".git", "index")), before);
    assert.strictEqual(f.git(f.repo, "rev-parse", "HEAD").trim(), f.head);
  });
});
