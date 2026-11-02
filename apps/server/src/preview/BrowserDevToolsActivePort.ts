// @effect-diagnostics nodeBuiltinImport:off - effect/FileSystem has no O_NOFOLLOW open or handle fstat, and joins here target another platform's paths.
// Profile locations follow browser-use's browser-harness-js (sdk/session.ts) and chrome.py.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

type BrowserChannel = "chrome" | "chrome-canary" | "brave" | "msedge" | "chromium";

const CHANNELS: ReadonlyArray<BrowserChannel> = [
  "chrome",
  "chrome-canary",
  "brave",
  "msedge",
  "chromium",
];

const PROFILE_SEGMENTS = {
  darwin: {
    chrome: ["Google", "Chrome"],
    "chrome-canary": ["Google", "Chrome Canary"],
    brave: ["BraveSoftware", "Brave-Browser"],
    msedge: ["Microsoft Edge"],
    chromium: ["Chromium"],
  },
  linux: {
    chrome: ["google-chrome"],
    "chrome-canary": ["google-chrome-unstable"],
    brave: ["BraveSoftware", "Brave-Browser"],
    msedge: ["microsoft-edge"],
    chromium: ["chromium"],
  },
  win32: {
    chrome: ["Google", "Chrome", "User Data"],
    "chrome-canary": ["Google", "Chrome SxS", "User Data"],
    brave: ["BraveSoftware", "Brave-Browser", "User Data"],
    msedge: ["Microsoft", "Edge", "User Data"],
    chromium: ["Chromium", "User Data"],
  },
} satisfies Record<string, Record<BrowserChannel, ReadonlyArray<string>>>;

/** Drive-qualified only: "\\x", "/x" and "C:x" depend on the current drive, and UNC is remote. */
const WIN32_LOCAL_ROOT = /^[A-Za-z]:[\\/]/;

const usableRoot = (platform: string, root: string | undefined): string | undefined => {
  if (root === undefined || root.includes("\0")) return undefined;
  const absolute = platform === "win32" ? WIN32_LOCAL_ROOT.test(root) : root.startsWith("/");
  return absolute ? root : undefined;
};

export const devToolsUserDataDirs = (input: {
  readonly platform: string;
  readonly homeDir: string;
  readonly env: {
    readonly XDG_CONFIG_HOME?: string | undefined;
    readonly LOCALAPPDATA?: string | undefined;
  };
  readonly channels?: ReadonlyArray<BrowserChannel>;
}): ReadonlyArray<{ readonly channel: BrowserChannel; readonly userDataDir: string }> => {
  const { platform } = input;
  if (platform !== "darwin" && platform !== "linux" && platform !== "win32") return [];
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const home = usableRoot(platform, input.homeDir);
  const fromHome = (...segments: ReadonlyArray<string>) =>
    home === undefined ? undefined : path.join(home, ...segments);
  const root =
    platform === "darwin"
      ? fromHome("Library", "Application Support")
      : platform === "linux"
        ? (usableRoot(platform, input.env.XDG_CONFIG_HOME) ?? fromHome(".config"))
        : (usableRoot(platform, input.env.LOCALAPPDATA) ?? fromHome("AppData", "Local"));
  if (root === undefined) return [];
  return (input.channels ?? CHANNELS).map((channel) => ({
    channel,
    userDataDir: path.join(root, ...PROFILE_SEGMENTS[platform][channel]),
  }));
};

type ParseRefusal = "empty_file" | "invalid_port" | "invalid_ws_path";

type DevToolsActivePort =
  | {
      readonly ok: true;
      readonly port: number;
      readonly wsPath: string;
      readonly webSocketDebuggerUrl: string;
    }
  | { readonly ok: false; readonly reason: ParseRefusal };

const PORT_LINE = /^[1-9][0-9]{0,4}$/;
const WS_PATH_LINE = /^\/devtools\/browser\/[A-Za-z0-9-]+$/;

/** Chrome writes "<port>\n/devtools/browser/<id>"; anything else is refused, never repaired. */
export const parseDevToolsActivePort = (content: string): DevToolsActivePort => {
  if (content.trim() === "") return { ok: false, reason: "empty_file" };
  const lines = content.replace(/\r?\n$/, "").split(/\r?\n/);
  const [portLine = "", wsPath] = lines;
  const port = Number(portLine);
  if (!PORT_LINE.test(portLine) || port > 65_535) return { ok: false, reason: "invalid_port" };
  if (lines.length !== 2 || wsPath === undefined || !WS_PATH_LINE.test(wsPath)) {
    return { ok: false, reason: "invalid_ws_path" };
  }
  // The host is never read from the file: a browser-wide endpoint is only trusted on loopback.
  return { ok: true, port, wsPath, webSocketDebuggerUrl: `ws://127.0.0.1:${port}${wsPath}` };
};

type ReadRefusal =
  | "not_found"
  | "symlink_refused"
  | "untrusted_owner"
  | "not_a_file"
  | "too_large"
  | "changed_during_read"
  | "unreadable";

const FILE_NAME = "DevToolsActivePort";
const MAX_FILE_BYTES = 4096;
// Windows lacks both flags; the lstat checks before opening and after reading still apply there.
const OPEN_FLAGS =
  NodeFSP.constants.O_RDONLY |
  (NodeFSP.constants.O_NOFOLLOW ?? 0) |
  (NodeFSP.constants.O_NONBLOCK ?? 0);

type Identity = { readonly dev: bigint; readonly ino: bigint; readonly ctimeNs: bigint };
const sameInode = (left: Identity, right: Identity) =>
  left.dev === right.dev && left.ino === right.ino;

type Ownership = { readonly uid: bigint; readonly mode: bigint };
/**
 * Node has no openat, so path checks cannot bind the file to its directory against repeated swaps.
 * Requiring the server's user or root as owner, and no write access for others unless the folder is
 * sticky, leaves those swaps to someone who could already write the file.
 */
const ownedBy = (stat: Ownership, uid: number) => stat.uid === 0n || stat.uid === BigInt(uid);
const othersCannotWrite = (stat: Ownership) => (stat.mode & 0o022n) === 0n;
const sticky = (stat: Ownership) => (stat.mode & 0o1000n) !== 0n;

const errorCode = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error ? error.code : undefined;

const attempt = <A>(run: () => Promise<A>, refusal: (code: unknown) => ReadRefusal) =>
  Effect.tryPromise({ try: run, catch: (error) => ({ reason: refusal(errorCode(error)) }) });

const refuse = (reason: ReadRefusal) => Effect.fail({ reason });

const lstatOrRefuse = (target: string, missing: ReadRefusal) =>
  attempt(
    () => NodeFSP.lstat(target, { bigint: true }),
    (code) => (code === "ENOENT" || code === "ENOTDIR" ? missing : "unreadable"),
  );

const readBounded = Effect.fn("BrowserDevToolsActivePort.readBounded")(function* (
  handle: NodeFSP.FileHandle,
) {
  const stat = yield* attempt(
    () => handle.stat({ bigint: true }),
    () => "unreadable",
  );
  if (!stat.isFile()) return yield* refuse("not_a_file");
  if (stat.size > MAX_FILE_BYTES) return yield* refuse("too_large");
  // The file can grow after fstat, so the read itself stops one byte past the limit.
  const buffer = new Uint8Array(MAX_FILE_BYTES + 1);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = yield* attempt(
      () => handle.read(buffer, length, buffer.length - length, length),
      () => "unreadable",
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > MAX_FILE_BYTES) return yield* refuse("too_large");
  const content = yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
    catch: () => ({ reason: "unreadable" as const }),
  });
  return { stat, content };
});

/**
 * Reads through one opened handle, then checks the directory and file names still lead to the
 * objects that were read.
 */
export const readDevToolsActivePort = Effect.fn("BrowserDevToolsActivePort.read")(
  function* (userDataDir: string) {
    // Windows reports no uid; its ACLs are not modelled here.
    const uid = yield* HostProcess.UserId;
    const file = NodePath.join(userDataDir, FILE_NAME);
    const parent = yield* lstatOrRefuse(NodePath.dirname(userDataDir), "not_found");
    const dir = yield* lstatOrRefuse(userDataDir, "not_found");
    if (dir.isSymbolicLink()) return yield* refuse("symlink_refused");
    if (!dir.isDirectory()) return yield* refuse("not_a_file");
    if (
      uid !== undefined &&
      !(
        ownedBy(parent, uid) &&
        (othersCannotWrite(parent) || sticky(parent)) &&
        ownedBy(dir, uid) &&
        othersCannotWrite(dir)
      )
    ) {
      return yield* refuse("untrusted_owner");
    }
    const entry = yield* lstatOrRefuse(file, "not_found");
    if (entry.isSymbolicLink()) return yield* refuse("symlink_refused");
    if (!entry.isFile()) return yield* refuse("not_a_file");
    const { stat, content } = yield* Effect.acquireUseRelease(
      attempt(
        () => NodeFSP.open(file, OPEN_FLAGS),
        (code) =>
          code === "ENOENT"
            ? "not_found"
            : code === "ELOOP" || code === "EMLINK"
              ? "symlink_refused"
              : "unreadable",
      ),
      readBounded,
      (handle) => Effect.ignore(Effect.tryPromise(() => handle.close())),
    );
    // Chrome keeps its profile at 0700, so a umask-widened file there is still out of others' reach.
    if (
      uid !== undefined &&
      !(ownedBy(stat, uid) && (othersCannotWrite(stat) || (dir.mode & 0o077n) === 0n))
    ) {
      return yield* refuse("untrusted_owner");
    }
    const dirAfter = yield* lstatOrRefuse(userDataDir, "changed_during_read");
    const fileAfter = yield* lstatOrRefuse(file, "changed_during_read");
    // Directory ctime moves whenever Chrome rewrites its other files, so only its inode counts.
    if (
      dirAfter.isSymbolicLink() ||
      fileAfter.isSymbolicLink() ||
      !sameInode(dir, dirAfter) ||
      !sameInode(stat, fileAfter) ||
      stat.ctimeNs !== fileAfter.ctimeNs
    ) {
      return yield* refuse("changed_during_read");
    }
    return parseDevToolsActivePort(content);
  },
  Effect.catch((refusal) => Effect.succeed({ ok: false, reason: refusal.reason } as const)),
);

type AttachedChildTarget = { readonly parentTargetId: string; readonly type: string };

type ExternalTargetVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "target_not_claimed"; readonly targetId: string };

const MAX_FRAME_DEPTH = 16;

/**
 * On a browser-wide connection, a target is usable only if the session claimed it or it is an
 * out-of-process iframe whose chain of iframe parents reaches a claimed target.
 * This decides target eligibility only; CDP params that name other targets need their own check.
 */
export const isExternalTargetAllowed = (input: {
  readonly targetId: string;
  readonly claimedTargetIds: ReadonlySet<string>;
  readonly attachedChildren: ReadonlyMap<string, AttachedChildTarget>;
}): ExternalTargetVerdict => {
  const refused = { ok: false, reason: "target_not_claimed", targetId: input.targetId } as const;
  const visited = new Set<string>();
  let current = input.targetId;
  for (let hop = 0; hop <= MAX_FRAME_DEPTH; hop += 1) {
    if (current === "" || visited.has(current)) return refused;
    if (input.claimedTargetIds.has(current)) return { ok: true };
    const child = input.attachedChildren.get(current);
    if (child?.type !== "iframe") return refused;
    visited.add(current);
    current = child.parentTargetId;
  }
  return refused;
};
