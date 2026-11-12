// @effect-diagnostics nodeBuiltinImport:off -- ownership and modes come from lstat and realpath.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

/** What the platform gate needs to know about one path; lstat never follows a symlink. */
export interface PathFacts {
  readonly uid: number;
  readonly mode: number;
  readonly kind: "file" | "directory" | "socket" | "symlink" | "other";
}
export interface PlatformProbe {
  readonly platform: NodeJS.Platform;
  readonly uid: number;
  readonly realpath: (path: string) => Promise<string>;
  readonly inspect: (path: string) => Promise<PathFacts>;
}

/** The file facts of this machine; the platform and owner come from HostProcess. */
const liveFacts = {
  realpath: (path: string) => NodeFSP.realpath(path),
  inspect: async (path: string): Promise<PathFacts> => {
    const stat = await NodeFSP.lstat(path);
    return {
      uid: stat.uid,
      mode: stat.mode,
      kind: stat.isSymbolicLink()
        ? "symlink"
        : stat.isFile()
          ? "file"
          : stat.isDirectory()
            ? "directory"
            : stat.isSocket()
              ? "socket"
              : "other",
    };
  },
};

export type PlatformVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const ancestorsOf = (path: string) => {
  const out: Array<string> = [];
  for (let current = NodePath.dirname(path); ; current = NodePath.dirname(current)) {
    out.push(current);
    if (current === NodePath.dirname(current)) return out;
  }
};

/**
 * The platform gate of mesh link design §7, run at confirmation, before every spawn and control
 * connection, and on every accepted Pen connection. Only macOS and Linux are checked; Windows is
 * refused until spike S3 passes. A check that cannot run disables Pen.
 */
export const checkPenPlatform = Effect.fn("PenPlatformGate.check")(function* (
  root: { readonly executablePath: string; readonly stateDir: string },
  injected?: PlatformProbe,
) {
  const probe: PlatformProbe = injected ?? {
    platform: yield* HostProcess.Platform,
    uid: (yield* HostProcess.UserId) ?? -1,
    ...liveFacts,
  };
  return yield* Effect.promise(async (): Promise<PlatformVerdict> => {
    if (probe.platform === "win32")
      return { ok: false, reason: "Pen is not supported on Windows yet." };
    if (probe.platform !== "darwin" && probe.platform !== "linux")
      return { ok: false, reason: `Pen is not supported on ${probe.platform}.` };
    if (probe.uid < 0) return { ok: false, reason: "The process owner cannot be read." };
    const ownerOk = (facts: PathFacts) => facts.uid === 0 || facts.uid === probe.uid;
    const notShared = (facts: PathFacts) => (facts.mode & 0o022) === 0;
    try {
      const exe = root.executablePath;
      const state = root.stateDir;
      const control = NodePath.join(state, "control.sock");
      for (const path of [exe, state]) {
        if (!NodePath.isAbsolute(path) || (await probe.realpath(path)) !== path)
          return { ok: false, reason: `${path} is not its own real path.` };
      }
      for (const ancestor of new Set([...ancestorsOf(exe), ...ancestorsOf(control)])) {
        const facts = await probe.inspect(ancestor);
        if (facts.kind !== "directory" || !ownerOk(facts) || !notShared(facts))
          return {
            ok: false,
            reason: `${ancestor} is writable by another user or not owned by this user or root.`,
          };
      }
      const exeFacts = await probe.inspect(exe);
      if (exeFacts.kind !== "file" || !ownerOk(exeFacts) || !notShared(exeFacts))
        return {
          ok: false,
          reason: `${exe} is not a regular file only this user or root can write.`,
        };
      const stateFacts = await probe.inspect(state);
      if (
        stateFacts.kind !== "directory" ||
        stateFacts.uid !== probe.uid ||
        (stateFacts.mode & 0o777) !== 0o700
      )
        return { ok: false, reason: `${state} must be this user's folder with mode 0700.` };
      const controlFacts = await probe.inspect(control);
      if (controlFacts.kind !== "socket" || controlFacts.uid !== probe.uid)
        return { ok: false, reason: `${control} is not this user's socket.` };
      return { ok: true };
    } catch {
      return { ok: false, reason: "The Pen paths could not be checked." };
    }
  });
});
