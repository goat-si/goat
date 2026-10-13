// @effect-diagnostics nodeBuiltinImport:off -- Verify only the test-owned temporary directory lifecycle.
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@goat/shared/HostProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../../processRunner.ts";
import { prepare } from "./ClaudeCloudSourceCheckout.ts";
const source = {
  repository: "https://github.com/fixture/repository",
  branch: "feature",
  sha: "a".repeat(40),
};
const exists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );
const harness = (head = source.sha, dirty = "") => {
  const calls: ProcessRunner.ProcessRunInput[] = [];
  const layer = Layer.mock(ProcessRunner.ProcessRunner)({
    run: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return {
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdout: input.args.includes("rev-parse")
            ? head
            : input.args.includes("--porcelain=v1")
              ? dirty
              : "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });
  return {
    calls,
    layer: layer.pipe(Layer.provideMerge(Layer.succeed(HostProcess.Environment, {}))),
  };
};
it.effect(
  "isolates all Git mutations in a disposable checkout at exactly the remote SHA and cleans on scope exit",
  () =>
    Effect.gen(function* () {
      const h = harness();
      let cwd = "";
      yield* Effect.scoped(
        Effect.gen(function* () {
          cwd = yield* prepare({ source, projectCwd: "/fixture/project" }).pipe(
            Effect.provide(h.layer),
          );
          expect(yield* exists(cwd)).toBe(true);
          expect(h.calls.every((call) => call.cwd === cwd && call.cwd !== "/fixture/project")).toBe(
            true,
          );
          expect(h.calls.find((call) => call.args.includes("fetch"))?.args.slice(2)).toEqual([
            "fetch",
            "--no-tags",
            "--depth=1",
            "origin",
            "refs/heads/feature",
          ]);
          expect(h.calls.some((call) => call.args.includes(source.sha))).toBe(true);
        }),
      );
      expect(yield* exists(cwd)).toBe(false);
    }),
);
it.effect.each([
  ["b".repeat(40), ""],
  [source.sha, "?? unexpected"],
])(
  "moved ref or dirty disposable source blocks launch and cleans the owned directory",
  ([head, dirty]) =>
    Effect.gen(function* () {
      const h = harness(head, dirty);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const error = yield* prepare({ source, projectCwd: "/fixture/project" }).pipe(
            Effect.provide(h.layer),
            Effect.flip,
          );
          expect(error.outcome).toBe("rejected");
        }),
      );
      const cwd = h.calls[0]!.cwd!;
      expect(yield* exists(cwd)).toBe(false);
      expect(
        h.calls.some((call) => call.args.includes("push") || call.cwd === "/fixture/project"),
      ).toBe(false);
    }),
);

it.effect.each([
  { ...source, repository: "file:///fixture/local-repo" },
  { repository: source.repository, branch: source.branch },
  { ...source, branch: "--upload-pack=other" },
])("invalid published source is rejected before any Git operation", (invalid) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = harness();
      const error = yield* prepare({ source: invalid, projectCwd: "/fixture/project" }).pipe(
        Effect.provide(h.layer),
        Effect.flip,
      );
      expect(error.outcome).toBe("rejected");
      expect(h.calls).toEqual([]);
    }),
  ),
);

it.effect("inherited Git configuration routing is rejected before checkout creation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = harness();
      const error = yield* prepare({ source, projectCwd: "/fixture/project" }).pipe(
        Effect.provide(h.layer),
        Effect.provideService(HostProcess.Environment, { GIT_CONFIG_COUNT: "1" }),
        Effect.flip,
      );
      expect(error.outcome).toBe("rejected");
      expect(error.detail).toContain("Inherited Git");
      expect(h.calls).toEqual([]);
    }),
  ),
);
