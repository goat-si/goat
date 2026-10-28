// @effect-diagnostics nodeBuiltinImport:off -- Version probes are mocked without spawning processes.
import * as NodeChildProcess from "node:child_process";
import { expect, it, vi } from "vite-plus/test";

import { readGnomeShellVersion } from "./linuxSession.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

function setup() {
  const pending: Array<(error: Error | null, output: string) => void> = [];
  const sync = vi.spyOn(NodeChildProcess, "execFileSync").mockReturnValue("GNOME Shell 49.0\n");
  const probe = vi.spyOn(NodeChildProcess, "execFile").mockImplementation(((...args: unknown[]) => {
    const callback = args.at(-1);
    pending.push((error, output) => {
      if (typeof callback === "function") callback(error, output, "");
    });
    return new NodeChildProcess.ChildProcess();
  }) as typeof NodeChildProcess.execFile);
  return {
    pending,
    probe,
    [Symbol.dispose]() {
      probe.mockRestore();
      sync.mockRestore();
    },
  };
}

it("shares one in-flight GNOME lookup and permits a fresh one after completion", async () => {
  using native = setup();
  const env = { PATH: "/fixture", XDG_CURRENT_DESKTOP: "GNOME" };
  const first = readGnomeShellVersion(env);
  const second = readGnomeShellVersion({ XDG_CURRENT_DESKTOP: "GNOME", PATH: "/fixture" });
  expect(native.pending).toHaveLength(1);
  native.pending[0]?.(null, "GNOME Shell 50.1\n");
  expect(await first).toBe("GNOME Shell 50.1\n");
  expect(await second).toBe("GNOME Shell 50.1\n");
  const next = readGnomeShellVersion(env);
  expect(native.pending).toHaveLength(2);
  native.pending[1]?.(null, "GNOME Shell 50.2\n");
  expect(await next).toBe("GNOME Shell 50.2\n");
});

it("keeps GNOME lookups for different environments separate", async () => {
  using native = setup();
  const first = readGnomeShellVersion({ PATH: "/fixture/first" });
  const second = readGnomeShellVersion({ PATH: "/fixture/second" });
  expect(native.pending).toHaveLength(2);
  native.pending[0]?.(null, "GNOME Shell 49.0\n");
  native.pending[1]?.(null, "GNOME Shell 50.1\n");
  expect(await first).toBe("GNOME Shell 49.0\n");
  expect(await second).toBe("GNOME Shell 50.1\n");
});

it("returns unknown on GNOME probe failure and retries on the next read", async () => {
  using native = setup();
  const env = { PATH: "/fixture/retry" };
  const failed = readGnomeShellVersion(env);
  native.pending[0]?.(new Error("Version probe failed"), "");
  expect(await failed).toBeNull();
  const retry = readGnomeShellVersion(env);
  expect(native.pending).toHaveLength(2);
  native.pending[1]?.(null, "GNOME Shell 50.1\n");
  expect(await retry).toBe("GNOME Shell 50.1\n");
});

it("rejects excess distinct GNOME lookups and admits them after a flight finishes", async () => {
  using native = setup();
  const active = Array.from({ length: 32 }, (_, index) =>
    readGnomeShellVersion({ PATH: `/fixture/admission/${index}` }),
  );
  const overflow = readGnomeShellVersion({ PATH: "/fixture/admission/overflow" });
  try {
    await expect(Promise.resolve(overflow)).rejects.toThrow(
      "GNOME version probe admission is full.",
    );
  } finally {
    for (const complete of native.pending) complete(null, "GNOME Shell 49.0\n");
    await Promise.all(active);
  }
  const next = readGnomeShellVersion({ PATH: "/fixture/admission/overflow" });
  expect(native.pending).toHaveLength(33);
  native.pending[32]?.(null, "GNOME Shell 50.1\n");
  expect(await next).toBe("GNOME Shell 50.1\n");
});

it("returns unknown when starting the GNOME probe throws and permits a retry", async () => {
  using native = setup();
  const env = { PATH: "/fixture/spawn-failure" };
  native.probe.mockImplementationOnce(() => {
    throw new Error("Unable to spawn gnome-shell");
  });
  expect(await readGnomeShellVersion(env)).toBeNull();
  const next = readGnomeShellVersion(env);
  expect(native.pending).toHaveLength(1);
  native.pending[0]?.(null, "GNOME Shell 50.1\n");
  expect(await next).toBe("GNOME Shell 50.1\n");
});
