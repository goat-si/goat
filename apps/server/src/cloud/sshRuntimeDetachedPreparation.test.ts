// @effect-diagnostics nodeBuiltinImport:off - Exercises native compilation and filesystem cleanup.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as WindowsJob from "./sshRuntimeWindowsJob.ts";
import * as SshRuntimeAutoUpdate from "./sshRuntimeAutoUpdate.ts";
import { defaultWindowsGitBash } from "./sshRuntimeGitBash.ts";

vi.mock("./sshRuntimeWindowsJob.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof WindowsJob>();
  return { ...actual, windowsJobCommand: vi.fn(actual.windowsJobCommand) };
});

const isolatedTemp = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() =>
      NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-preparation-")),
    ),
    (root) => Effect.promise(() => NodeFS.promises.rm(root, { recursive: true, force: true })),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("TEMP", root);
      vi.stubEnv("TMP", root);
    }),
    () => Effect.sync(() => vi.unstubAllEnvs()),
  );
  return root;
});

// quarantine: #612 Requires native Windows PowerShell 5.1 Add-Type and Git Bash.
describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("detached preparation", () => {
  it.live("awaits cancelled compilation cleanup without launching a late command", () =>
    Effect.gen(function* () {
      const root = yield* isolatedTemp;
      const original = yield* Effect.promise(() =>
        vi.importActual<typeof WindowsJob>("./sshRuntimeWindowsJob.ts"),
      );
      const compiled =
        Promise.withResolvers<Awaited<ReturnType<typeof WindowsJob.windowsJobCommand>>>();
      const release = Promise.withResolvers<void>();
      const disposed = Promise.withResolvers<void>();
      using _compile = vi
        .spyOn(WindowsJob, "windowsJobCommand")
        .mockImplementation(async (input) => {
          const owned = await original.windowsJobCommand(input);
          compiled.resolve(owned);
          await release.promise;
          return {
            ...owned,
            dispose: async () => {
              await owned.dispose();
              disposed.resolve();
            },
          };
        });
      const shell = yield* defaultWindowsGitBash();
      if (shell === undefined) throw new Error("Git Bash is required");
      const marker = NodePath.join(root, "late-command");
      const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
      let finalized = false;
      const run = yield* host
        .runDetached({
          shell,
          script: 'printf late > "$1"\n',
          args: [marker.replaceAll("\\", "/")],
          env: { ...process.env },
          cwd: root,
        })
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
          Effect.forkScoped,
        );
      try {
        const owned = yield* Effect.promise(() => compiled.promise);
        expect(NodeFS.existsSync(owned.command)).toBe(true);
        // Interrupt immediately at the held compilation boundary; awaiting interrupt here
        // would deadlock the correct implementation until this test releases preparation.
        run.interruptUnsafe();
        const finalizedBeforeRelease = finalized;
        release.resolve();
        yield* Fiber.await(run);
        yield* Effect.promise(() => disposed.promise);
        expect({
          finalizedBeforeRelease,
          lateCommand: NodeFS.existsSync(marker),
          files: NodeFS.readdirSync(root),
        }).toEqual({
          finalizedBeforeRelease: false,
          lateCommand: false,
          files: [],
        });
      } finally {
        release.resolve();
        yield* Fiber.interrupt(run);
        yield* Effect.promise(() => disposed.promise);
      }
    }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost), Effect.scoped),
  );

  it.live("removes preparation files when the native compiler cannot start", () =>
    Effect.gen(function* () {
      const root = yield* isolatedTemp;
      const host = yield* SshRuntimeAutoUpdate.SshRuntimeHost;
      const result = yield* Effect.exit(
        host.runDetached({
          shell: process.execPath,
          script: "process.exit(99)",
          args: [],
          env: { ...process.env, SystemRoot: NodePath.join(root, "missing-windows") },
          cwd: root,
        }),
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(NodeFS.readdirSync(root)).toEqual([]);
    }).pipe(Effect.provide(SshRuntimeAutoUpdate.layerHost), Effect.scoped),
  );
});
