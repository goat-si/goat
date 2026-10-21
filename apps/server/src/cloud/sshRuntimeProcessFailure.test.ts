// @effect-diagnostics nodeBuiltinImport:off - Native boundary fault injection and temporary artifact checks.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@goat/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Runtime from "./sshRuntimeAutoUpdate.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return { ...actual, openSync: vi.fn(actual.openSync) };
});

const setup = Effect.gen(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(() =>
      NodeFS.promises.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-process-failure-")),
    ),
    (root) => Effect.promise(() => NodeFS.promises.rm(root, { recursive: true, force: true })),
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      vi.stubEnv("TEMP", root);
      vi.stubEnv("TMP", root);
    }),
    () =>
      Effect.sync(() => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
      }),
  );
  return { root, host: yield* Runtime.SshRuntimeHost };
});

const invoke = (
  host: Runtime.SshRuntimeHost["Service"],
  api: "run" | "runDetached",
  root: string,
) =>
  api === "run"
    ? host.run({
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { ...process.env },
        timeoutMs: 30_000,
      })
    : host.runDetached({
        shell: process.execPath,
        script: "process.exit(0)",
        args: [],
        env: { ...process.env },
        cwd: root,
      });

// quarantine: #612 Exercises Windows compiler boundary failures; POSIX has no compiler preparation.
describe.skipIf(HostProcess.Platform.defaultValue() !== "win32")("native runtime failures", () => {
  it.live("closes stdout when opening stderr fails before launch", () =>
    Effect.gen(function* () {
      const { root, host } = yield* setup;
      const actual = yield* Effect.promise(() => vi.importActual<typeof NodeFS>("node:fs"));
      let output: number | undefined;
      using _open = vi.spyOn(NodeFS, "openSync").mockImplementation((...args) => {
        if (NodePath.basename(String(args[0])) === "stderr")
          throw Object.assign(new Error("private path"), { code: "EACCES" });
        const descriptor = actual.openSync(...args);
        if (NodePath.basename(String(args[0])) === "stdout") output = descriptor;
        return descriptor;
      });
      expect(yield* invoke(host, "runDetached", root)).toEqual({
        code: null,
        stdout: "",
        stderr: "Runtime command filesystem or spawn failure (EACCES).",
      });
      expect(output).toBeDefined();
      expect(() => NodeFS.fstatSync(output!)).toThrow();
      expect(NodeFS.readdirSync(root)).toEqual([]);
    }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
  );

  it.live(
    "reports output read failure and still disposes the closed command and launch directory",
    () =>
      Effect.gen(function* () {
        const { root, host } = yield* setup;
        using _read = vi
          .spyOn(NodeFS.promises, "readFile")
          .mockRejectedValueOnce(Object.assign(new Error("private output path"), { code: "EIO" }));
        expect(yield* invoke(host, "runDetached", root)).toEqual({
          code: null,
          stdout: "",
          stderr: "Runtime command filesystem or spawn failure (EIO).",
        });
        expect(NodeFS.readdirSync(root)).toEqual([]);
      }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
  );

  describe.each(["run", "runDetached"] as const)("%s", (api) => {
    it.live("maps compiler startup failure through the same process-result contract", () =>
      Effect.gen(function* () {
        const { root, host } = yield* setup;
        vi.stubEnv("SystemRoot", NodePath.join(root, "missing-windows"));
        expect(yield* invoke(host, api, root)).toEqual({
          code: null,
          stdout: "",
          stderr: "Windows runtime job compilation failed: start.",
        });
        expect(NodeFS.readdirSync(root)).toEqual([]);
      }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
    );

    it.live(
      "reports disposal OS failure without skipping the independent launch directory cleanup",
      () =>
        Effect.gen(function* () {
          const { root, host } = yield* setup;
          const remove = NodeFS.promises.rm;
          let rejected = false;
          using _remove = vi.spyOn(NodeFS.promises, "rm").mockImplementation((file, options) => {
            if (!rejected && NodePath.basename(String(file)).startsWith("goat-job-")) {
              rejected = true;
              return Promise.reject(
                Object.assign(new Error("sentinel-private-filesystem-path"), { code: "EACCES" }),
              );
            }
            return remove(file, options);
          });
          expect(yield* invoke(host, api, root)).toEqual({
            code: null,
            stdout: "",
            stderr: "Runtime command filesystem or spawn failure (EACCES).",
          });
          const retained = NodeFS.readdirSync(root);
          expect(retained).toHaveLength(1);
          expect(retained[0]).toMatch(/^goat-job-/u);
          // The simulated removal failure remains visible; the fixture releases its owned artifact.
          yield* Effect.promise(() =>
            remove(NodePath.join(root, retained[0]!), { recursive: true }),
          );
          expect(NodeFS.readdirSync(root)).toEqual([]);
        }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
    );

    it.live("maps actual compiler nonzero exit without exposing its diagnostic payload", () =>
      Effect.gen(function* () {
        const { root, host } = yield* setup;
        const actual = yield* Effect.promise(() =>
          vi.importActual<typeof NodeChildProcess>("node:child_process"),
        );
        using _spawn = vi
          .spyOn(NodeChildProcess, "spawn")
          .mockImplementation((command, _args, options) =>
            actual.spawn(
              command,
              [
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                Buffer.from(
                  "[Console]::Error.WriteLine('sentinel-private-compiler-input');exit 9",
                  "utf16le",
                ).toString("base64"),
              ],
              options,
            ),
          );
        const result = yield* invoke(host, api, root);
        expect(result).toEqual({
          code: 9,
          stdout: "",
          stderr: "Windows runtime job compilation failed: exit.",
        });
        expect(NodeFS.readdirSync(root)).toEqual([]);
      }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
    );

    it.live(
      "kills a timed-out compiler by its retained handle and waits for close before cleanup",
      () =>
        Effect.gen(function* () {
          const { root, host } = yield* setup;
          const started = Promise.withResolvers<void>();
          const compiler = new NodeChildProcess.ChildProcess();
          const killed = Promise.withResolvers<void>();
          using _kill = vi.spyOn(compiler, "kill").mockImplementation(() => {
            killed.resolve();
            return true;
          });
          using _spawn = vi
            .spyOn(NodeChildProcess, "spawn")
            .mockImplementation((_command, args) => {
              const encoded = args?.at(-1);
              if (encoded === undefined) throw new Error("Expected compiler payload");
              const script = Buffer.from(encoded, "base64").toString("utf16le");
              const output = /-OutputAssembly '([^']+)'/.exec(script)?.[1];
              if (output === undefined) throw new Error("Expected compiler output path");
              NodeFS.writeFileSync(output, "partial executable");
              started.resolve();
              return compiler;
            });
          vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
          let finished = false;
          const run = yield* invoke(host, api, root).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                finished = true;
              }),
            ),
            Effect.forkScoped,
          );
          yield* Effect.promise(() => started.promise);
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(29_999));
          expect(_kill).not.toHaveBeenCalled();
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(1));
          yield* Effect.promise(() => killed.promise);
          expect(_kill).toHaveBeenCalledOnce();
          expect(finished).toBe(false);
          expect(NodeFS.readdirSync(root).some((name) => name.startsWith("goat-job-"))).toBe(true);
          compiler.emit("close", null, "SIGTERM");
          expect(yield* Fiber.join(run)).toEqual({
            code: null,
            stdout: "",
            stderr: "Windows runtime job compilation failed: timeout.",
          });
          expect(NodeFS.readdirSync(root)).toEqual([]);
        }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
    );

    it.live("keeps a programmer failure as a defect while releasing temporary artifacts", () =>
      Effect.gen(function* () {
        const { root, host } = yield* setup;
        const bug = new TypeError("unexpected compiler invocation bug");
        using _spawn = vi.spyOn(NodeChildProcess, "spawn").mockImplementation(() => {
          throw bug;
        });
        const result = yield* Effect.exit(invoke(host, api, root));
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result)) expect(Cause.squash(result.cause)).toBe(bug);
        expect(NodeFS.readdirSync(root)).toEqual([]);
      }).pipe(Effect.provide(Runtime.layerHost), Effect.scoped),
    );
  });
});
