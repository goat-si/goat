// @effect-diagnostics nodeBuiltinImport:off -- real symlinks and modes in a scratch folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkPenPlatform, type PathFacts, type PlatformProbe } from "./penPlatformGate.ts";

const UID = 501;
const root = { executablePath: "/opt/pen/bin/pen", stateDir: "/Users/a/.pen" };
const dir = (uid = 0, mode = 0o755): PathFacts => ({
  uid,
  mode: 0o040000 | mode,
  kind: "directory",
});
const facts: Record<string, PathFacts> = {
  "/": dir(),
  "/opt": dir(),
  "/opt/pen": dir(),
  "/opt/pen/bin": dir(),
  "/opt/pen/bin/pen": { uid: 0, mode: 0o100755, kind: "file" },
  "/Users": dir(),
  "/Users/a": dir(UID),
  "/Users/a/.pen": dir(UID, 0o700),
  "/Users/a/.pen/control.sock": { uid: UID, mode: 0o140600, kind: "socket" },
};
const probe = (
  overrides: Record<string, PathFacts> = {},
  options: { platform?: NodeJS.Platform; realpath?: Record<string, string> } = {},
): PlatformProbe => ({
  platform: options.platform ?? "darwin",
  uid: UID,
  realpath: async (path) => options.realpath?.[path] ?? path,
  inspect: async (path) => {
    const found = overrides[path] ?? facts[path];
    if (found === undefined) throw new Error(`ENOENT ${path}`);
    return found;
  },
});
const ok = (verdict: { readonly ok: boolean }) => verdict.ok;

it.effect("admits safe pinned paths and refuses each unsafe one (mesh link design §7)", () =>
  Effect.gen(function* () {
    expect(ok(yield* checkPenPlatform(root, probe()))).toBe(true);
    for (const unsafe of [
      probe({}, { platform: "win32" }),
      probe({}, { platform: "freebsd" }),
      probe({}, { realpath: { "/opt/pen/bin/pen": "/tmp/pen" } }),
      probe({ "/opt/pen": dir(0, 0o775) }),
      probe({ "/Users": dir(0, 0o1777) }),
      probe({ "/opt/pen/bin": dir(502) }),
      probe({ "/opt/pen/bin/pen": { uid: 502, mode: 0o100755, kind: "file" } }),
      probe({ "/opt/pen/bin/pen": { uid: 0, mode: 0o100775, kind: "file" } }),
      probe({ "/opt/pen/bin/pen": { uid: 0, mode: 0o120777, kind: "symlink" } }),
      probe({ "/Users/a/.pen": dir(UID, 0o750) }),
      probe({ "/Users/a/.pen": dir(0, 0o700) }),
      probe({ "/Users/a/.pen/control.sock": { uid: UID, mode: 0o100600, kind: "file" } }),
      probe({ "/Users/a/.pen/control.sock": { uid: 502, mode: 0o140600, kind: "socket" } }),
      { ...probe(), inspect: async () => Promise.reject(new Error("EACCES")) },
    ])
      expect(ok(yield* checkPenPlatform(root, unsafe))).toBe(false);
  }),
);

it.effect("reads the real file system: a symlinked path or a writable ancestor disables Pen", () =>
  Effect.gen(function* () {
    const base = yield* Effect.promise(async () =>
      NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-pen-gate-"))),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(base, { recursive: true, force: true })),
    );
    const shared = NodePath.join(base, "shared");
    const exe = NodePath.join(shared, "pen");
    const link = NodePath.join(base, "pen-link");
    const state = NodePath.join(base, "state");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(shared);
      await NodeFSP.writeFile(exe, "");
      await NodeFSP.chmod(exe, 0o755);
      await NodeFSP.symlink(exe, link);
      await NodeFSP.mkdir(state, { mode: 0o700 });
      await NodeFSP.chmod(shared, 0o777);
    });
    expect(yield* checkPenPlatform({ executablePath: link, stateDir: state })).toEqual({
      ok: false,
      reason: `${link} is not its own real path.`,
    });
    expect(yield* checkPenPlatform({ executablePath: exe, stateDir: state })).toEqual({
      ok: false,
      reason: `${shared} is writable by another user or not owned by this user or root.`,
    });
  }).pipe(Effect.scoped),
);
