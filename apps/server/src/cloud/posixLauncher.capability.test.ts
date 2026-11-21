// @effect-diagnostics nodeBuiltinImport:off -- Capability probes execute isolated fake runtimes.
import { expect, it, vi } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { runtimeSupportsScriptLauncher, writePosixLauncher } from "./posixLauncher.ts";

it("treats a timed-out capability probe as an old runtime", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-launcher-probe-"));
  const executable = NodePath.join(root, "goat");
  const started = Promise.withResolvers<void>();
  const watcher = NodeFS.watch(root, (_event, filename) => {
    if (filename === "started") started.resolve();
  });
  NodeFS.writeFileSync(
    executable,
    `#!/bin/sh\nprintf ready > '${NodePath.join(root, "started")}'\nread -r ignored\n`,
    { mode: 0o755 },
  );
  vi.useFakeTimers();
  try {
    const probe = runtimeSupportsScriptLauncher(executable);
    await started.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await probe).toBe(false);
  } finally {
    vi.useRealTimers();
    watcher.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

it.each([
  ["exact", "printf 'script-launcher\\n'", true],
  ["malformed", "printf 'script-launcher extra\\n'", false],
  ["failed", "printf 'script-launcher\\n'; exit 1", false],
  ["stderr", "printf 'script-launcher\\n'; printf 'warning\\n' >&2", false],
  ["excess output", "printf '%05000d' 0", false],
] as const)(
  "only accepts an exact successful capability reply (%s)",
  async (_name, body, expected) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-launcher-probe-"));
    try {
      const executable = NodePath.join(root, "goat");
      NodeFS.writeFileSync(executable, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      expect(await runtimeSupportsScriptLauncher(executable)).toBe(expected);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("leaves a legacy link when the target capability probe times out", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-launcher-timeout-"));
  const old = NodePath.join(root, "old");
  const target = NodePath.join(root, "target");
  const launcher = NodePath.join(root, "goat");
  NodeFS.writeFileSync(old, "old");
  NodeFS.symlinkSync(old, launcher);
  const started = Promise.withResolvers<void>();
  const watcher = NodeFS.watch(root, (_event, filename) => {
    if (filename === "started") started.resolve();
  });
  NodeFS.writeFileSync(
    target,
    `#!/bin/sh\nprintf ready > '${NodePath.join(root, "started")}'\nread -r ignored\n`,
    { mode: 0o755 },
  );
  vi.useFakeTimers();
  try {
    const update = writePosixLauncher(launcher, target);
    await started.promise;
    await vi.advanceTimersByTimeAsync(2_000);
    await update;
    expect(NodeFS.readlinkSync(launcher)).toBe(target);
  } finally {
    vi.useRealTimers();
    watcher.close();
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
