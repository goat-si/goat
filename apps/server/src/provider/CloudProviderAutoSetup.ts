/**
 * Turns on cloud providers from the vendor CLIs already on this machine, so a
 * person who uses Devin or Cursor never types an instance id.
 *
 * Each step runs once per environment: it applies only while the cloud slot is
 * still unconfigured, and it writes that slot (or the sibling the slot follows)
 * as its last action. After that, the person's own edits are final: turning a
 * provider off, removing the sibling or picking another one is never undone.
 * Resetting the cloud card in Settings re-arms the step.
 *
 * Writes go through ServerSettingsService.updateProviderInstance with `create`,
 * so a concurrent edit to the same slot wins and this step stops.
 *
 * @module provider/CloudProviderAutoSetup
 */
import {
  ProviderDriverKind,
  ProviderInstanceId,
  runsDevinCli,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsError,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import { SpawnExecutableResolution } from "@goat/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Settings from "../serverSettings.ts";

const ACP_REGISTRY = ProviderDriverKind.make("acpRegistry");
const CURSOR = ProviderDriverKind.make("cursor");
const CURSOR_CLOUD = ProviderDriverKind.make("cursorCloud");
const DEVIN_CLOUD = ProviderDriverKind.make("devinCloud");

/** Vendor CLIs found on this machine's PATH, as absolute paths. */
export interface DetectedCloudClis {
  readonly devin: string | undefined;
  readonly cursorAgent: string | undefined;
}

export type CloudAutoSetupStep =
  | {
      readonly provider: "devinCloud";
      /** The Devin ACP provider to create; Devin Cloud borrows its executable and sign-in. */
      readonly siblingId: ProviderInstanceId;
      readonly command: string;
    }
  | {
      readonly provider: "cursorCloud";
      /** Cursor Cloud follows the default Cursor provider, which is off until turned on. */
      readonly siblingId: ProviderInstanceId;
      readonly command: string;
    };

const hasDriver = (settings: Pick<ServerSettings, "providerInstances">, driver: string) =>
  Object.values(settings.providerInstances).some((instance) => instance.driver === driver);

const freeId = (settings: Pick<ServerSettings, "providerInstances">, base: string) => {
  let candidate = base;
  for (let n = 2; Object.hasOwn(settings.providerInstances, candidate); n++) {
    candidate = `${base}_${n}`;
  }
  return ProviderInstanceId.make(candidate);
};

/** Pure: what auto setup would do with these settings and these CLIs. */
export const planCloudAutoSetup = (
  settings: Pick<ServerSettings, "providerInstances">,
  detected: DetectedCloudClis,
): ReadonlyArray<CloudAutoSetupStep> => {
  const steps: CloudAutoSetupStep[] = [];
  // Any Devin ACP provider, even one turned off, is the person's own choice.
  if (
    detected.devin !== undefined &&
    !hasDriver(settings, DEVIN_CLOUD) &&
    !Object.values(settings.providerInstances).some(runsDevinCli)
  ) {
    steps.push({
      provider: "devinCloud",
      siblingId: freeId(settings, "acpRegistry_devin"),
      command: detected.devin,
    });
  }
  if (
    detected.cursorAgent !== undefined &&
    !hasDriver(settings, CURSOR) &&
    !hasDriver(settings, CURSOR_CLOUD)
  ) {
    steps.push({
      provider: "cursorCloud",
      siblingId: ProviderInstanceId.make("cursor"),
      command: detected.cursorAgent,
    });
  }
  return steps;
};

/** The instances each step creates, in write order. The last one is the step's marker. */
const cloudAutoSetupWrites = (
  step: CloudAutoSetupStep,
): ReadonlyArray<{
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
}> =>
  step.provider === "devinCloud"
    ? [
        {
          instanceId: step.siblingId,
          instance: {
            driver: ACP_REGISTRY,
            displayName: "Devin",
            enabled: true,
            config: { source: "registry", agentId: "devin", commandPath: step.command },
          },
        },
        {
          instanceId: ProviderInstanceId.make("devinCloud"),
          instance: {
            driver: DEVIN_CLOUD,
            enabled: true,
            config: { siblingInstanceId: step.siblingId },
          },
        },
      ]
    : [{ instanceId: step.siblingId, instance: { driver: CURSOR, enabled: true } }];

export const detectCloudClis = Effect.fn("CloudProviderAutoSetup.detect")(function* () {
  const resolve = yield* SpawnExecutableResolution;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  return {
    devin: resolve("devin", platform, environment),
    cursorAgent: resolve("cursor-agent", platform, environment),
  } satisfies DetectedCloudClis;
});

export class CloudProviderAutoSetup extends Context.Service<
  CloudProviderAutoSetup,
  {
    /** Read-only: the steps the next apply would take. */
    readonly plan: Effect.Effect<ReadonlyArray<CloudAutoSetupStep>, ServerSettingsError>;
    /** Takes every pending step and returns the ones it completed. */
    readonly apply: Effect.Effect<ReadonlyArray<CloudAutoSetupStep>, ServerSettingsError>;
  }
>()("goat/provider/CloudProviderAutoSetup") {}

export const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const plan = Effect.gen(function* () {
    return planCloudAutoSetup(yield* settings.getSettings, yield* detectCloudClis());
  });
  const applyStep = (step: CloudAutoSetupStep) =>
    Effect.forEach(
      cloudAutoSetupWrites(step),
      ({ instanceId, instance }) =>
        settings.updateProviderInstance({ operation: "create", instanceId, instance }),
      { discard: true },
    ).pipe(
      Effect.as(true),
      // A slot someone else created first ends the step; the plan is re-read next time.
      Effect.catch((cause) =>
        Effect.logWarning(`Cloud auto setup skipped ${step.provider}.`, cause).pipe(
          Effect.as(false),
        ),
      ),
    );
  const apply = Effect.gen(function* () {
    const steps = yield* plan;
    const done = yield* Effect.filter(steps, applyStep);
    if (done.length > 0)
      yield* Effect.logInfo("Cloud providers set up from local CLIs.", {
        providers: done.map((step) => step.provider),
      });
    return done;
  });
  return CloudProviderAutoSetup.of({ plan, apply });
});

/** Also applies once at startup, so every host sets itself up when it runs this build. */
export const layer = Layer.effect(
  CloudProviderAutoSetup,
  Effect.gen(function* () {
    const service = yield* make;
    yield* service.apply.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Cloud auto setup failed.", cause)),
      Effect.forkScoped,
    );
    return service;
  }),
);
