import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  EnvironmentId,
  Handoff,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type AuthClientSession,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Environment from "../environment/ServerEnvironment.ts";
import * as SecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Handoffs from "./Handoffs.ts";
import * as ComputerUseLeases from "../cua/ComputerUseLeases.ts";

const encodeHandoff = Schema.encodeEffect(Schema.fromJsonString(Schema.toCodecJson(Handoff)));
const threadId = ThreadId.make("thread:authority");
const handoffId = TurnItemId.make("handoff:authority");
const sessionId = AuthSessionId.make("session:authority");
const now = DateTime.makeUnsafe("2026-10-23T00:00:00Z");
const address = { threadId, handoffId };

// A session that holds every scope an orchestration:operate handoff needs; only its subject varies.
const session = (
  subject: string,
  scopes: AuthClientSession["scopes"] = ["orchestration:operate"],
): AuthClientSession => ({
  sessionId,
  subject,
  method: "bearer-access-token",
  scopes,
  client: { label: "Client", deviceType: "unknown" },
  issuedAt: now,
  expiresAt: DateTime.add(now, { days: 1 }),
  lastConnectedAt: now,
  connected: true,
  current: true,
});

const run = <A, E>(
  subject: string,
  body: (
    service: Handoffs.Handoffs["Service"],
    leases: ComputerUseLeases.ComputerUseLeases["Service"],
  ) => Effect.Effect<A, E>,
  options: {
    readonly foreground?: boolean;
    readonly scopes?: AuthClientSession["scopes"];
    readonly destination?: EnvironmentId;
    readonly afterHolder?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const answered = yield* Ref.make(0);
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const handoff = yield* encodeHandoff({
        handoffId,
        kind: "approval",
        title: "Approve",
        reason: "A person decides.",
        requestedBy: { threadId, providerInstanceId: ProviderInstanceId.make("codex"), path: "x" },
        target: {
          environmentId: options.destination ?? EnvironmentId.make("test"),
          path: options.foreground ? COMPUTER_USE_GRANT_HANDOFF_PATH : "example.approve",
        },
        ...(options.foreground
          ? { computerUseForeground: { purpose: "Check build", target: "desktop" as const } }
          : {}),
        dedupeKey: "key",
        state: "pending",
        expiresAt: options.foreground ? DateTime.add(now, { minutes: 30 }) : null,
        createdAt: now,
        actor: { type: "agent", threadId },
      });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json)
        VALUES (${handoffId}, ${threadId}, 0, 'human_handoff', 'waiting', '2026-10-23T00:00:00.000Z',
        json_object('handoff', json(${handoff})))`;
      return yield* body(yield* Handoffs.Handoffs, yield* ComputerUseLeases.ComputerUseLeases).pipe(
        Effect.result,
      );
    }).pipe(
      Effect.provide(
        Handoffs.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.unwrap(
                Effect.map(ComputerUseLeases.ComputerUseLeases, (leases) =>
                  Layer.succeed(ComputerUseLeases.ComputerUseLeases, {
                    ...leases,
                    holder: (except, apps) =>
                      leases
                        .holder(except, apps)
                        .pipe(Effect.tap(() => options.afterHolder ?? Effect.void)),
                  }),
                ),
              ),
              Layer.mock(SessionStore.SessionStore)({
                cookieName: "test",
                legacyCookieName: undefined,
                listActive: () => Effect.succeed([session(subject, options.scopes)]),
              }),
              Layer.mock(Environment.ServerEnvironment)({
                getEnvironmentId: Effect.succeed(EnvironmentId.make("test")),
              }),
              Layer.mock(SecretRequests.SecretRequests)({
                answer: () => Ref.update(answered, (count) => count + 1),
              }),
              Layer.mock(SecretStore.ServerSecretStore)({
                get: () => Effect.succeed(Option.none()),
                remove: () => Effect.void,
                getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(1)),
              }),
              Layer.unwrap(
                Effect.map(SqlClient.SqlClient, (sql) =>
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    // Applies the transition to the projection the service reads back.
                    dispatch: (command) =>
                      (command.type === "handoff.transition"
                        ? sql`UPDATE orchestration_v2_projection_turn_items
                            SET status = ${command.state}, payload_json = json_set(payload_json, '$.handoff.state', ${command.state})`
                        : Effect.void
                      ).pipe(Effect.as({ sequence: 1, storedEvents: [] }), Effect.orDie),
                  }),
                ),
              ),
            ),
          ),
          Layer.provideMerge(ComputerUseLeases.layer),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    return { result, answered: yield* Ref.get(answered) };
  });

const secretAnswer = { threadId, turnItemId: handoffId, answer: { type: "decline" as const } };

it.effect(
  "Stop during the real holder read fences a pending foreground approval before first mint",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const responded = yield* run(
        "desktop-bootstrap",
        (service, leases) =>
          Effect.gen(function* () {
            const response = yield* service
              .respond({ ...address, action: "completed" }, sessionId)
              .pipe(Effect.forkChild);
            yield* Deferred.await(entered);
            yield* leases.stop(threadId);
            yield* Deferred.succeed(release, undefined);
            const approved = yield* Fiber.join(response);
            expect(approved.state).toBe("completed");
            const admission = yield* leases.active(threadId);
            expect(Option.isSome(admission)).toBe(true);
            const control = yield* leases.control(threadId, admission);
            expect(yield* leases.foregroundAvailable(threadId, "Check build")).toBe(false);
            expect(
              yield* leases.callReservation(threadId, {
                action: "reserve",
                controlId: control.controlId,
                connectionId: "driver:after-stop",
                callId: "focus",
                interruptions: 0,
                idleEpoch: 0,
                foregroundGrantId: handoffId,
                name: "bring_to_front",
                args: { pid: 42, window_id: 7 },
              }),
            ).toEqual({ status: "refused", detail: "foreground_not_approved" });
            yield* service.respond({ ...address, action: "completed" }, sessionId);
            expect(yield* leases.foregroundAvailable(threadId, "Check build")).toBe(false);
          }),
        {
          foreground: true,
          scopes: ["orchestration:operate", "settings:write"],
          afterHolder: Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        },
      );
      expect(responded.result).toMatchObject({ _tag: "Success" });
    }),
);

it.effect("refuses an MCP client session that holds a person's scopes", () =>
  Effect.gen(function* () {
    const responded = yield* run("mcp-client", (service) =>
      service.respond({ ...address, action: "declined" }, sessionId),
    );
    expect(responded.result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "EnvironmentAuthorizationError" },
    });
    const secret = yield* run("mcp-client", (service) =>
      service.answerSecret(secretAnswer, sessionId),
    );
    expect(secret.result).toMatchObject({ _tag: "Failure" });
    expect(secret.answered).toBe(0);
  }),
);

it.effect("lets the owning desktop's bootstrap session respond and answer secrets", () =>
  Effect.gen(function* () {
    const responded = yield* run("desktop-bootstrap", (service) =>
      service.respond({ ...address, action: "declined" }, sessionId),
    );
    expect(responded.result).toMatchObject({ _tag: "Success", success: { state: "declined" } });
    const secret = yield* run("desktop-bootstrap", (service) =>
      service.answerSecret(secretAnswer, sessionId),
    );
    expect(secret.result).toMatchObject({ _tag: "Success" });
    expect(secret.answered).toBe(1);
  }),
);

it.effect(
  "foreground approval requires a person's client, both scopes, and the destination environment",
  () =>
    Effect.gen(function* () {
      for (const scopes of [
        ["orchestration:operate"],
        ["settings:write"],
        ["orchestration:operate", "settings:write"],
      ] satisfies ReadonlyArray<AuthClientSession["scopes"]>) {
        const subject = scopes.length === 2 ? "mcp-client" : "desktop-bootstrap";
        const denied = yield* run(
          subject,
          (service) => service.respond({ ...address, action: "completed" }, sessionId),
          { foreground: true, scopes },
        );
        expect(denied.result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "EnvironmentAuthorizationError" },
        });
      }
      const wrongHost = yield* run(
        "desktop-bootstrap",
        (service) => service.respond({ ...address, action: "completed" }, sessionId),
        {
          foreground: true,
          scopes: ["orchestration:operate", "settings:write"],
          destination: EnvironmentId.make("other-host"),
        },
      );
      expect(wrongHost.result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "HandoffError", reason: "invalid_request" },
      });
    }),
);
