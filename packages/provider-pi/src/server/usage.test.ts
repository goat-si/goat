// @effect-diagnostics nodeBuiltinImport:off -- Creates an isolated provider home.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PiSettings } from "../settings.ts";
import { omoUsageReader, piUsageReader } from "./usage.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const decodeSettings = Schema.decodeUnknownSync(PiSettings);

it.live("scans the OmO session directory configured in settings.json", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "goat-omo-usage-")),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
    );
    yield* Effect.promise(() =>
      NodeFSP.writeFile(
        NodePath.join(dir, "settings.json"),
        JSON.stringify({ sessionDir: "~/sessions-custom" }),
      ),
    );
    if (omoUsageReader.kind !== "transcripts")
      return yield* Effect.die("Expected transcript reader");
    const instance = {
      instanceId: ProviderInstanceId.make("omo"),
      configured: true,
      environment: { HOME: dir, OMO_CODING_AGENT_DIR: dir },
      config: decodeSettings({}),
    };
    assert.deepEqual(yield* omoUsageReader.directories(instance), [
      { dir: NodePath.join(dir, "sessions-custom") },
    ]);
    assert.deepEqual(
      yield* omoUsageReader.directories({
        ...instance,
        environment: { ...instance.environment, OMO_CODING_AGENT_SESSION_DIR: "/override" },
      }),
      [{ dir: "/override" }],
    );
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("includes absolute Pi launch session directories without losing the default", () =>
  Effect.gen(function* () {
    if (piUsageReader.kind !== "transcripts")
      return yield* Effect.die("Expected transcript reader");
    const directories = yield* piUsageReader.directories({
      instanceId: ProviderInstanceId.make("pi"),
      configured: true,
      environment: { HOME: "/instance" },
      config: decodeSettings({ launchArgs: "--session-dir ~/work" }),
    });
    assert.deepEqual(directories, [
      { dir: "/instance/work" },
      { dir: "/home/test/.pi/agent/sessions" },
    ]);
  }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);

it.effect("attributes OmO usage and scans its configured session directories", () =>
  Effect.gen(function* () {
    if (omoUsageReader.kind !== "transcripts")
      return yield* Effect.die("Expected transcript reader");
    const directories = yield* omoUsageReader.directories({
      instanceId: ProviderInstanceId.make("omo"),
      configured: true,
      environment: { HOME: "/instance", OMO_CODING_AGENT_DIR: "/instance/omo" },
      config: decodeSettings({ binaryPath: "omo", launchArgs: "--session-dir ~/work" }),
    });
    assert.deepEqual(directories, [{ dir: "/instance/work" }, { dir: "/instance/omo/sessions" }]);
    const state = omoUsageReader.format.state?.initial();
    if (state === undefined) return yield* Effect.die("Expected scan state");
    const records = omoUsageReader.format.parseLine(
      JSON.stringify({
        type: "usage",
        id: "1",
        timestamp: "2026-01-01T00:00:00Z",
        provider: "test",
        model: "model",
        usage: { input: 1 },
      }),
      state,
    );
    assert.equal(records[0]?.provider, "omo");
  }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, "/home/test"),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provide(NodeServices.layer),
  ),
);
