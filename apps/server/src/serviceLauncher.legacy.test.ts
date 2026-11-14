// @effect-diagnostics nodeBuiltinImport:off -- The launcher fixture starts isolated fake runtimes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";
import { vi } from "vite-plus/test";
import { main } from "./serviceLauncher.ts";

const spawned = vi.hoisted((): Array<NodeChildProcess.ChildProcess> => []);
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawned.push(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

it.layer(NodeServices.layer)("legacy service records", (it) => {
  it.effect("starts a compatible legacy install without rewriting the record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-legacy-" });
      const version = "0.0.43-nightly.20260919.1962+build.1";
      const versionDir = path.join(root, "runtime", "goat", "versions", version);
      yield* fs.makeDirectory(versionDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(versionDir, "goat"),
        `#!${process.execPath}\nimport { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./started", import.meta.url), "");\nprocess.exit(0);`,
        { mode: 0o755 },
      );
      yield* fs.writeFileString(path.join(versionDir, ".install-complete"), `${version}\n`);
      const statePath = path.join(root, "runtime", "service-state.json");
      const contents = `{ "protocol": 2, "activeVersion": "${version}" }`;
      yield* fs.writeFileString(statePath, contents);
      const restartPending = path.join(root, "runtime", ".restart-pending");
      yield* fs.writeFileString(restartPending, `${version}\n`);
      vi.stubEnv("GOAT_HOME", root);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const failure = yield* Effect.promise(() =>
        main().then(
          () => undefined,
          (error: unknown) => error,
        ),
      );
      assert.include(String(failure), "Active child exited unexpectedly (0).");
      assert.isTrue(yield* fs.exists(path.join(versionDir, "started")));
      assert.isFalse(yield* fs.exists(restartPending));
      assert.equal(yield* fs.readFileString(statePath), contents);
    }),
  );

  it.effect(
    "refuses unsupported legacy records and missing runtimes without writing or spawning",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "goat-service-legacy-refuse-" });
        const statePath = path.join(root, "runtime", "service-state.json");
        yield* fs.makeDirectory(path.dirname(statePath), { recursive: true });
        vi.stubEnv("GOAT_HOME", root);
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const count = spawned.length;
        const legacy = { protocol: 2, activeVersion: "1.0.0" };
        for (const contents of [
          JSON.stringify({
            ...legacy,
            update: {
              id: "u",
              fromVersion: "1.0.0",
              targetVersion: "1.1.0",
              dbPath: "/tmp/state.sqlite",
              status: "pending",
            },
          }),
          JSON.stringify({ ...legacy, update: null }),
          JSON.stringify({ ...legacy, extra: true }),
          JSON.stringify({ ...legacy, protocol: 1 }),
          JSON.stringify({ ...legacy, protocol: 5 }),
          JSON.stringify({ ...legacy, activeVersion: "latest" }),
          "{ invalid JSON",
          JSON.stringify(legacy),
        ]) {
          yield* fs.writeFileString(statePath, contents);
          const failure = yield* Effect.promise(() =>
            main().then(
              () => undefined,
              (error: unknown) => error,
            ),
          );
          assert.include(
            String(failure),
            contents === JSON.stringify(legacy)
              ? "runtime is missing or incomplete"
              : "Service state is invalid or unsupported",
          );
          assert.equal(yield* fs.readFileString(statePath), contents);
          assert.equal(spawned.length, count);
        }
      }),
  );
});
