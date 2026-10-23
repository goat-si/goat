import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as FleetHostStates from "../../../fleet/health/FleetHostStates.ts";
import * as HostHealthMonitor from "../../../fleet/health/HostHealthMonitor.ts";
import * as Rescheduler from "../../../fleet/health/Rescheduler.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as HealthHandlers from "./healthHandlers.ts";
import { FleetHealthToolkit } from "./healthTools.ts";

const threadId = ThreadId.make("thread:mover");

/** goat_thread_reschedule without targetHost, as a thread whose profile may name hosts. */
const rescheduleWithout = (
  hosts: ReadonlyArray<string> | undefined,
  narrowWhileWaiting?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const requests: Array<Rescheduler.RescheduleRequest> = [];
    // Runs where the Rescheduler would wait for its lock, before it re-checks the caller.
    let whileWaiting: Effect.Effect<void> = Effect.void;
    const owner = BUILTIN_PERMISSION_PROFILES.owner!;
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "provider:mover",
        thread: {
          threadId,
          providerSessionId: "provider:mover",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(liveThreadShell(threadId, { runtimeMode: "full-access" })),
      }),
      Layer.mock(FleetHostStates.FleetHostStates)({}),
      Layer.mock(HostHealthMonitor.HostHealthMonitor)({}),
      Layer.mock(Rescheduler.Rescheduler)({
        reschedule: (request) =>
          Effect.gen(function* () {
            requests.push(request);
            yield* whileWaiting;
            const authorized = yield* Effect.result(request.authorize ?? Effect.void);
            return authorized._tag === "Failure"
              ? {
                  _tag: "Refused" as const,
                  reason: "not_allowed" as const,
                  message: authorized.failure.message,
                }
              : { _tag: "Refused" as const, reason: "no_capacity" as const, message: "fixture" };
          }),
      }),
      Profiles.layer.pipe(
        Layer.provideMerge(Sqlite.layerMemory),
        Layer.provideMerge(
          ServerSettings.layerTest({
            goatclaw: {
              enabled: hosts !== undefined,
              defaultProfile: "owner",
              profiles: { owner: hosts === undefined ? owner : { ...owner, hosts: [...hosts] } },
            },
          }),
        ),
      ),
    );
    const toolkit = yield* FleetHealthToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(HealthHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const settings = yield* ServerSettings.ServerSettingsService;
      if (narrowWhileWaiting !== undefined)
        whileWaiting = settings
          .updateSettings({
            goatclaw: { profiles: { owner: { ...owner, hosts: [...narrowWhileWaiting] } } },
          })
          .pipe(Effect.orDie, Effect.asVoid);
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${threadId}, 'project', 'Mover', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`;
      return yield* toolkit
        .handle("goat_thread_reschedule", {
          host: "box",
          threadId: "thread:old",
          branch: "feature/x",
          cwd: "/repo",
          reason: "host is draining",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
    }).pipe(Effect.provide(dependencies));
    return { requests, result: result.at(-1)?.result };
  });

it.effect("a reschedule without targetHost carries the caller's goatclaw host allowlist", () =>
  Effect.gen(function* () {
    const limited = yield* rescheduleWithout(["box", "lab"]);
    expect(limited.requests.map((request) => request.allowedHosts)).toEqual([["box", "lab"]]);
    expect(limited.result).toMatchObject({ status: "refused", reason: "no_capacity" });
    // goatclaw off: placement is unrestricted, as before.
    const open = yield* rescheduleWithout(undefined);
    expect(open.requests.map((request) => request.allowedHosts)).toEqual([undefined]);
  }),
);

it.effect("a reschedule whose host allowlist narrows while it waits is refused", () =>
  Effect.gen(function* () {
    const narrowed = yield* rescheduleWithout(["box", "lab"], ["box"]);
    expect(narrowed.result).toMatchObject({
      status: "refused",
      reason: "not_allowed",
      message: expect.stringContaining("allowlist narrowed"),
    });
    const unchanged = yield* rescheduleWithout(["box", "lab"], ["box", "lab", "spare"]);
    expect(unchanged.result).toMatchObject({ status: "refused", reason: "no_capacity" });
  }),
);
