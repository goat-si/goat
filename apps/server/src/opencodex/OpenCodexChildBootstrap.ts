import {
  CloudMachineError,
  EnvironmentId,
  OpenCodexChildBootstrapStatus,
  type HubDeviceMcpResult,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as CloudMachines from "../cloudMachines/CloudMachineService.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as HubMembership from "../hub/HubMembership.ts";
import { HubOcx } from "../hub/HubOcx.ts";
import { compareOpenCodexVersions, isStableOpenCodexVersion } from "../hub/opencodexUpdatePlan.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Inventory from "./OpenCodexInventory.ts";
import { CHILD_MINIMUM_VERSION, PREPARE_EXIT } from "./childPrepare.ts";

const STATE_FILE = "opencodex-child-bootstrap.json";
// npm downloads OpenCodex and its bundled Bun runtime, then the service gets 40 seconds to answer.
const PREPARE_TIMEOUT_MS = 15 * 60_000;
/** A blocked machine is tried again on a later readying, but not on every one. */
const RETRY_AFTER_MS = 10 * 60_000;

type Status = OpenCodexChildBootstrapStatus;
type Reason = NonNullable<Status["reason"]>;
const Records = Schema.Record(Schema.String, OpenCodexChildBootstrapStatus);
const decodeRecords = Schema.decodeUnknownOption(Schema.fromJsonString(Records));
const encodeRecords = Schema.encodeSync(Schema.fromJsonString(Records));

const PREPARE_REASONS: Readonly<Record<number, readonly [Reason, string]>> = {
  [PREPARE_EXIT.npmMissing]: [
    "npm_missing",
    "npm is not installed there. OpenCodex installs with npm (Node 18 or later).",
  ],
  [PREPARE_EXIT.installFailed]: ["install_failed", "npm could not install OpenCodex there."],
  [PREPARE_EXIT.ocxUnusable]: [
    "ocx_unusable",
    `After installing, the first ocx there still is not OpenCodex ${CHILD_MINIMUM_VERSION} or later.`,
  ],
  [PREPARE_EXIT.runtimeUnhealthy]: [
    "runtime_unhealthy",
    "OpenCodex is installed there but did not start; see ~/.opencodex/goat-start.log on it.",
  ],
};

export class OpenCodexChildBootstrap extends Context.Service<
  OpenCodexChildBootstrap,
  {
    /**
     * Installs OpenCodex on a cloud machine this Home created, starts it and links it as a Remote
     * Link Child. Every step is skipped when it is already done, so running it again is safe.
     * Undefined when this machine is not a hub, which leaves the machine untouched.
     */
    readonly ensure: (alias: string) => Effect.Effect<Status | undefined>;
    /** The last outcome for a machine, or undefined when this Home never tried it. */
    readonly status: (alias: string) => Effect.Effect<Status | undefined>;
  }
>()("goat/opencodex/OpenCodexChildBootstrap") {}

const make = Effect.gen(function* () {
  const cloud = yield* CloudMachines.CloudMachineService;
  const ocx = yield* HubOcx;
  const membership = yield* HubMembership.HubMembership;
  const inventory = yield* Inventory.OpenCodexInventory;
  const settings = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Scope.Scope;
  const stateFile = path.join(config.stateDir, STATE_FILE);
  const writing = yield* Semaphore.make(1);
  const jobs = new Map<string, Fiber.Fiber<Status>>();
  const releases = new Map<string, Fiber.Fiber<void>>();

  const stored = yield* fs.readFileString(stateFile).pipe(
    Effect.map((text) => Option.getOrElse(decodeRecords(text), () => ({}))),
    Effect.orElseSucceed((): Readonly<Record<string, Status>> => ({})),
  );
  // A job does not outlive the server, so a "running" record from before a restart is stale.
  const initial = Object.fromEntries(
    Object.entries(stored).map(([alias, status]): [string, Status] => [
      alias,
      status.state === "running"
        ? {
            ...status,
            state: "blocked",
            reason: "unreachable",
            message: "GOAT restarted during setup.",
          }
        : status,
    ]),
  );
  const records = yield* Ref.make<Readonly<Record<string, Status>>>(initial);
  /** One atomic write per change, so a restart sees each outcome whole or not at all. */
  const save = (change: (current: Readonly<Record<string, Status>>) => Record<string, Status>) =>
    writing.withPermits(1)(
      Effect.gen(function* () {
        const next = change(yield* Ref.get(records));
        yield* Ref.set(records, next);
        yield* fs.makeDirectory(config.stateDir, { recursive: true });
        yield* fs.writeFileString(`${stateFile}.tmp`, encodeRecords(next));
        yield* fs.rename(`${stateFile}.tmp`, stateFile);
      }).pipe(Effect.ignore({ log: true })),
    );
  const record = Effect.fn("OpenCodexChildBootstrap.record")(function* (
    alias: string,
    status: Omit<Status, "checkedAt">,
  ) {
    const next: Status = { ...status, checkedAt: yield* Clock.currentTimeMillis };
    yield* save((current) => ({ ...current, [alias]: next }));
    return next;
  });

  const hubEnabled = settings.getSettings.pipe(
    Effect.map((configured) => configured.hub.enabled),
    Effect.orElseSucceed(() => false),
  );

  const joined = (alias: string, version: string | undefined, outcome: HubDeviceMcpResult) =>
    record(alias, {
      state:
        outcome.state === "child" ? "child" : outcome.state === "degraded" ? "degraded" : "blocked",
      ...(outcome.state === "child" || outcome.state === "degraded"
        ? {}
        : { reason: "link_failed" as const }),
      message: outcome.message,
      ...(version === undefined ? {} : { version }),
    });

  const run = Effect.fn("OpenCodexChildBootstrap.run")(function* (alias: string) {
    const blocked = (reason: Reason, message: string, version?: string) =>
      record(alias, { state: "blocked", reason, message, ...(version ? { version } : {}) });
    yield* record(alias, { state: "running" });
    const home = (yield* inventory.read).binaries[0]?.version;
    if (
      !isStableOpenCodexVersion(home) ||
      compareOpenCodexVersions(home, CHILD_MINIMUM_VERSION) < 0
    )
      return yield* blocked(
        "home_unavailable",
        `This Home needs OpenCodex ${CHILD_MINIMUM_VERSION} or later to install the same release there.`,
      );
    if ((yield* ocx.devicePlatform(alias)) === "windows")
      return yield* blocked("platform_unsupported", "Remote Link refuses Windows Children.");
    const prepared = yield* ocx.prepareDevice(alias, home, PREPARE_TIMEOUT_MS).pipe(
      Effect.map((output) => ({ ok: true as const, output })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!prepared.ok) return yield* blocked("unreachable", prepared.error.message);
    const known = PREPARE_REASONS[prepared.output.code];
    if (prepared.output.code !== 0)
      return yield* blocked(
        known?.[0] ?? "install_failed",
        known?.[1] ?? `Preparing OpenCodex there exited ${prepared.output.code}.`,
      );
    const version = prepared.output.stdout.trim() || undefined;
    const scope: McpInvocationScope = {
      environmentId: yield* environment.getEnvironmentId.pipe(
        Effect.orElseSucceed(() => EnvironmentId.make("local")),
      ),
      capabilities: new Set(["orchestration"]),
      issuedAt: yield* Clock.currentTimeMillis,
      requestNamespace: "opencodex-child-bootstrap",
      thread: undefined,
      client: {
        sessionId: "opencodex-child-bootstrap",
        label: "GOAT cloud machine setup",
        access: "read-only",
      },
    };
    return yield* membership.joinProvisioned(scope, alias).pipe(
      Effect.flatMap((result) => joined(alias, version, result)),
      Effect.catch((error) => blocked("link_failed", error.message, version)),
    );
  });

  /** One job per machine: a second caller joins the job already running for it. */
  const start = Effect.fn("OpenCodexChildBootstrap.start")(function* (alias: string) {
    const existing = jobs.get(alias);
    if (existing !== undefined) return existing;
    const fiber = yield* run(alias).pipe(
      Effect.catchCause(() =>
        record(alias, { state: "blocked", reason: "link_failed", message: "Setup stopped." }),
      ),
      Effect.ensuring(Effect.sync(() => jobs.delete(alias))),
      Effect.forkIn(serviceScope, { startImmediately: false }),
    );
    jobs.set(alias, fiber);
    // Visible before the job runs, so a reader never sees a stale outcome for a started job.
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(records, (current) => ({
      ...current,
      [alias]: { state: "running" as const, checkedAt: now },
    }));
    return fiber;
  });

  const ensure: OpenCodexChildBootstrap["Service"]["ensure"] = Effect.fn(
    "OpenCodexChildBootstrap.ensure",
  )(function* (alias) {
    if (!(yield* hubEnabled) || !(yield* cloud.owns(alias))) return undefined;
    return yield* Fiber.join(yield* start(alias));
  });

  /** A joined Child is left to goat_hub_device_repair; a blocked one waits before retrying. */
  const onReady = Effect.fn("OpenCodexChildBootstrap.onReady")(function* (alias: string) {
    if (jobs.has(alias) || !(yield* hubEnabled) || !(yield* cloud.owns(alias))) return;
    const previous = (yield* Ref.get(records))[alias];
    const now = yield* Clock.currentTimeMillis;
    if (previous?.state === "child" || previous?.state === "degraded") return;
    if (previous?.state === "blocked" && now - previous.checkedAt < RETRY_AFTER_MS) return;
    yield* start(alias);
  });
  yield* cloud.onReady(onReady);

  /**
   * Revokes the link this Home added for a deleted or forgotten machine. Only a catalog that says
   * so releases it; until then, or when the revoke fails, the hub keeps the release pending.
   */
  const release = Effect.fn("OpenCodexChildBootstrap.release")(function* (alias: string) {
    if (!(yield* cloud.isRemoved(alias))) return;
    yield* membership.releaseProvisioned(alias);
  });
  const startRelease = Effect.fn("OpenCodexChildBootstrap.startRelease")(function* (alias: string) {
    if (releases.has(alias)) return;
    const fiber = yield* release(alias).pipe(
      Effect.ignore({ log: true }),
      Effect.ensuring(Effect.sync(() => releases.delete(alias))),
      Effect.forkIn(serviceScope, { startImmediately: false }),
    );
    releases.set(alias, fiber);
  });
  // Recorded before the catalog lets go of the machine, so the release survives a restart.
  yield* cloud.onRemoving((alias) =>
    membership
      .requestRelease(alias)
      .pipe(Effect.mapError(() => new CloudMachineError({ reason: "storage_failed" }))),
  );
  // A removed machine is gone for good; a stopped one keeps its record and link for its next start.
  yield* cloud.onAliasInvalidated((alias, cause) =>
    cause !== "removed"
      ? Effect.void
      : save((current) => {
          const { [alias]: _gone, ...rest } = current;
          return rest;
        }).pipe(Effect.andThen(startRelease(alias))),
  );
  // Releases that failed, or never ran, before this start.
  yield* membership.pendingReleases.pipe(
    Effect.flatMap((aliases) => Effect.forEach(aliases, startRelease, { discard: true })),
    Effect.ignore({ log: true }),
  );

  return OpenCodexChildBootstrap.of({
    ensure,
    status: (alias) => Ref.get(records).pipe(Effect.map((current) => current[alias])),
  });
});

export const layer = Layer.effect(OpenCodexChildBootstrap, make);
