import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderInstallationGate from "../provider/ProviderInstallationGate.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const KNOWN = ProviderInstanceId.make("codex");

// The gate keeps one entry per instance id for the server's lifetime, so only registered ids enter it.
it.effect("takes the installation gate only for a registered provider instance", () =>
  Effect.gen(function* () {
    const gated: Array<string> = [];
    const instance = {
      instanceId: KNOWN,
      textGeneration: {
        generateBranchName: () => Effect.succeed({ branch: "feature/gate" }),
      },
    } as unknown as ProviderInstance;
    const textGeneration = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: (id) => Effect.succeed(id === KNOWN ? instance : undefined),
          }),
          ServerSettings.layerTest(),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
          Layer.succeed(
            ProviderInstallationGate.ProviderInstallationGate,
            ProviderInstallationGate.ProviderInstallationGate.of({
              execute: (instanceId, effect) =>
                Effect.sync(() => gated.push(instanceId)).pipe(Effect.andThen(effect)),
              update: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    const generate = (instanceId: ProviderInstanceId) =>
      textGeneration.generateBranchName({
        cwd: "/tmp",
        message: "Add a gate",
        modelSelection: { instanceId, model: "gpt-5" },
      });

    const unknown = yield* Effect.exit(generate(ProviderInstanceId.make("never-registered")));
    assert.isTrue(unknown._tag === "Failure");
    assert.deepEqual(gated, []);
    assert.deepEqual(yield* generate(KNOWN), { branch: "feature/gate" });
    assert.deepEqual(gated, [KNOWN]);
  }),
);
