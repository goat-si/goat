import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { PiSettings } from "../settings.ts";
import { piUsageReader } from "./usage.ts";

const decodeSettings = Schema.decodeUnknownSync(PiSettings);

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
