import {
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderHostSyncDriver,
  type ServerProvider,
} from "@goat/contracts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { recipeFor } from "./ProviderHostSyncRecipes.ts";

/** Drivers whose sessions run a CLI from PATH and whose probe writes ServerProvider.cli. */
const CLI_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
  "grok",
  "opencode",
  "pi",
  "omo",
]);
/** Twice the default background provider check, so a launch normally probes nothing. */
const PRESENT_FRESH_MS = 10 * 60_000;

/** Whether this driver's probe runs an instance's CLI from PATH, so its answer says installed. */
export const checksCli = (driver: string, cli: ServerProvider["cli"]) =>
  CLI_DRIVERS.has(driver) && cli !== "none";

/**
 * The chosen instance's CLI was not found on this machine by a probe that just ran. created says
 * whether a thread already exists: before creation nothing ran; after, that thread can be retried.
 */
export class ProviderCliMissingError extends Schema.TaggedError<ProviderCliMissingError>()(
  "ProviderCliMissingError",
  {
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    displayName: Schema.String,
    host: Schema.String,
    binary: Schema.String,
    /** provider.sync installs this instance's CLI; otherwise its own settings need fixing. */
    syncable: Schema.Boolean,
    created: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  /** Read by makeProviderFailure as the failure code. */
  get code(): string {
    return "provider_cli_missing";
  }
  override get message(): string {
    const fix = this.syncable
      ? `Install it with ${goatCallText("provider.sync", `{driver:"${this.driver}", login:false}`)} on that machine, or in Settings → Connections → Providers on your machines.`
      : `Fix its Binary path or environment in Settings → Providers on that machine.`;
    const what = this.syncable
      ? `${this.displayName} is not installed on ${this.host} (the ${this.binary} command was not found)`
      : `${this.displayName} on ${this.host} runs ${this.binary}, which was not found`;
    return this.created
      ? `${what}, so this thread could not start. ${fix} Then retry this thread.`
      : `${what}. ${fix} No thread was created.`;
  }
}

export type CliAnswer =
  | { readonly kind: "present" | "missing" | "none"; readonly provider: ServerProvider }
  | { readonly kind: "unknown" };

export interface ProviderCliGateShape {
  /** Refuses only when a probe that ran for this call found the CLI missing. */
  readonly require: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderCliMissingError>;
  /**
   * One probe per instance, shared by concurrent callers. fresh never joins a probe that started
   * before the call, so an answer after an install comes from a probe that started after it.
   */
  readonly probe: (
    instanceId: ProviderInstanceId,
    options?: { readonly fresh?: boolean },
  ) => Effect.Effect<CliAnswer>;
  /** The refusal for a probed missing CLI, or undefined when this instance is not missing. */
  readonly missing: (
    instanceId: ProviderInstanceId,
    created: boolean,
    cause?: unknown,
  ) => Effect.Effect<ProviderCliMissingError | undefined>;
}

export class ProviderCliGate extends Context.Service<ProviderCliGate, ProviderCliGateShape>()(
  "goat/provider/ProviderCliGate",
) {}

interface InFlight {
  readonly generation: number;
  readonly answer: Deferred.Deferred<CliAnswer>;
}
interface FlightState {
  readonly started: ReadonlyMap<string, number>;
  readonly flights: ReadonlyMap<string, InFlight>;
}
type Claim = { readonly join: InFlight } | { readonly start: InFlight };

const UNKNOWN: CliAnswer = { kind: "unknown" };
const answerOf = (provider: ServerProvider): CliAnswer =>
  provider.cli === undefined ? UNKNOWN : { kind: provider.cli, provider };

const make = Effect.gen(function* () {
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const host = yield* HostProcess.Hostname;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<FlightState>({ started: new Map(), flights: new Map() });

  const cachedProvider = (instanceId: ProviderInstanceId) =>
    providers.getProviders.pipe(
      Effect.map((all) => all.find((provider) => provider.instanceId === instanceId)),
    );
  const checked = (provider: ServerProvider | undefined): provider is ServerProvider =>
    provider !== undefined && CLI_DRIVERS.has(provider.driver) && provider.cli !== "none";

  const runProbe = Effect.fn("ProviderCliGate.runProbe")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const instance = yield* instances.getInstance(instanceId);
    if (instance === undefined) return UNKNOWN;
    const exit = yield* Effect.exit(instance.snapshot.refresh);
    // A probe of an instance that settings replaced or removed meanwhile answers for nothing.
    if ((yield* instances.getInstance(instanceId)) !== instance) return UNKNOWN;
    return Exit.isSuccess(exit) ? answerOf(exit.value) : UNKNOWN;
  });

  const settle = (instanceId: ProviderInstanceId, flight: InFlight) =>
    runProbe(instanceId).pipe(
      Effect.catchCause(() => Effect.succeed(UNKNOWN)),
      Effect.flatMap((answer) => Deferred.succeed(flight.answer, answer)),
      Effect.ensuring(
        Ref.update(state, (current) => {
          if (current.flights.get(instanceId)?.generation !== flight.generation) return current;
          const flights = new Map(current.flights);
          flights.delete(instanceId);
          // No flight left to order against, so a removed instance leaves nothing behind.
          const started = new Map(current.started);
          started.delete(instanceId);
          return { flights, started };
        }),
      ),
    );

  const probe = Effect.fn("ProviderCliGate.probe")(function* (
    instanceId: ProviderInstanceId,
    options?: { readonly fresh?: boolean },
  ) {
    const requestedAfter = (yield* Ref.get(state)).started.get(instanceId) ?? 0;
    while (true) {
      const answer = yield* Deferred.make<CliAnswer>();
      // Claiming a flight and forking its worker is one step, so no flight is left without one.
      const claim = yield* Effect.uninterruptible(
        Ref.modify(state, (current): readonly [Claim, FlightState] => {
          const flight = current.flights.get(instanceId);
          if (flight !== undefined) return [{ join: flight }, current];
          const start = { generation: (current.started.get(instanceId) ?? 0) + 1, answer };
          return [
            { start },
            {
              started: new Map(current.started).set(instanceId, start.generation),
              flights: new Map(current.flights).set(instanceId, start),
            },
          ];
        }).pipe(
          Effect.tap((claimed) =>
            // In the service scope, so a caller that goes away never strands the others.
            "start" in claimed
              ? Effect.forkIn(Effect.interruptible(settle(instanceId, claimed.start)), scope)
              : Effect.void,
          ),
        ),
      );
      if ("start" in claim) return yield* Deferred.await(claim.start.answer);
      const joined = yield* Deferred.await(claim.join.answer);
      if (options?.fresh !== true || claim.join.generation > requestedAfter) return joined;
    }
  });

  const describe = Effect.fn("ProviderCliGate.describe")(function* (
    provider: ServerProvider,
    created: boolean,
    cause: unknown,
  ) {
    const recipe = recipeFor(provider.driver as ProviderHostSyncDriver);
    const current = yield* settings.getSettings.pipe(Effect.option);
    const entry = Option.isSome(current)
      ? deriveProviderInstanceConfigMap(current.value)[provider.instanceId]
      : undefined;
    const configured = (entry?.config as { readonly binaryPath?: unknown } | undefined)?.binaryPath;
    const binary =
      typeof configured === "string" && configured.trim() !== ""
        ? configured.trim()
        : recipe.binary;
    // provider.sync acts on the driver's default instance and installs the recipe's binary.
    const own = (yield* instances.listInstances).filter(
      (instance) => instance.driverKind === provider.driver,
    );
    const synced =
      own.find((instance) => String(instance.instanceId) === String(provider.driver)) ?? own[0];
    return new ProviderCliMissingError({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? recipe.displayName,
      host,
      binary,
      syncable:
        synced?.instanceId === provider.instanceId &&
        (binary === recipe.binary || (recipe.aliases ?? []).includes(binary)),
      created,
      ...(cause === undefined ? {} : { cause }),
    });
  });

  const missing = Effect.fn("ProviderCliGate.missing")(function* (
    instanceId: ProviderInstanceId,
    created: boolean,
    cause?: unknown,
  ) {
    if (!checked(yield* cachedProvider(instanceId))) return undefined;
    const answer = yield* probe(instanceId, { fresh: true });
    return answer.kind === "missing" ? yield* describe(answer.provider, created, cause) : undefined;
  });

  const require = Effect.fn("ProviderCliGate.require")(function* (instanceId: ProviderInstanceId) {
    const cached = yield* cachedProvider(instanceId);
    if (!checked(cached)) return;
    if (cached.cli === "present" && cached.cliCheckedAt !== undefined) {
      const age = (yield* Clock.currentTimeMillis) - Date.parse(cached.cliCheckedAt);
      if (age >= 0 && age < PRESENT_FRESH_MS) return;
    }
    const answer = yield* probe(instanceId);
    // A TaggedError fails the effect when yielded.
    if (answer.kind === "missing") return yield* yield* describe(answer.provider, false, undefined);
  });

  return ProviderCliGate.of({ require, probe, missing });
});

export const layer = Layer.effect(ProviderCliGate, make);

/** A refused launch as an agent sees it: nothing ran, and driver only when provider.sync is the fix. */
export const cliMissingFailure = (error: ProviderCliMissingError) =>
  new OrchestratorMcpFailure({
    code: "provider_unavailable",
    classification: "provider_cli_missing",
    message: error.message,
    ...(error.syncable ? { driver: error.driver } : {}),
  });

/** For upstream files: the gate a layer was built with, or a no-op where none was provided. */
export const providerCliGuard = Effect.serviceOption(ProviderCliGate).pipe(
  Effect.map(
    (gate) => (instanceId: ProviderInstanceId) =>
      Option.isSome(gate) ? gate.value.require(instanceId) : Effect.void,
  ),
);

/**
 * For upstream files, captured when their layer is built: a session that failed to open because
 * its CLI is now missing becomes that refusal; anything else, or no gate, is unchanged.
 */
export const openFailureExplainer = Effect.serviceOption(ProviderCliGate).pipe(
  Effect.map((gate) =>
    Effect.fn("ProviderCliGate.explainOpenFailure")(function* <E extends { readonly _tag: string }>(
      failure: E,
    ): Effect.fn.Return<E | ProviderCliMissingError> {
      if (failure._tag !== "ProviderSessionOpenError" || Option.isNone(gate)) return failure;
      const { instanceId } = failure as unknown as { readonly instanceId: ProviderInstanceId };
      return (yield* gate.value.missing(instanceId, true, failure)) ?? failure;
    }),
  ),
);
