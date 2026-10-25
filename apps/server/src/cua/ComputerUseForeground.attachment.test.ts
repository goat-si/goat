import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { runMigrations } from "../persistence/Migrations.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { computerUseAttachment } from "./ComputerUseAttachment.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import * as CuaDriver from "./CuaDriver.ts";
import {
  foregroundDatabase,
  foregroundGrant,
  revokeForegroundGrant,
} from "./ComputerUseForeground.testkit.ts";
import { call, harness } from "./ComputerUseLeaseProxy.testkit.ts";
import { leaseUpdates } from "./ComputerUseLeaseRoute.ts";

const threadId = ThreadId.make("thread:attached-foreground");
const layer = (fullAccess: boolean) =>
  ComputerUseLeases.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        foregroundDatabase,
        NodeServices.layer,
        ServerSettings.ServerSettingsService.layerTest({
          enableCua: true,
          cuaFullAccessAutoAdmit: fullAccess,
        }),
        DesktopTelemetryReceiver.layerTest({
          cuaReadiness: Effect.succeedSome({
            version: 1,
            type: "cuaReadiness",
            generation: 1,
            readiness: {
              grants: { accessibility: "granted", screenCapture: "granted" },
              helper: "authenticated",
              capture: "ready",
              tree: "ready",
              input: "background",
              blockers: [],
              reasons: [],
            },
            signals: { humanInput: "supported", privateMode: "supported" },
          }),
        }),
      ),
    ),
  );

const attach = Effect.fn("foreground.attachFixture")(function* (
  fullAccess: boolean,
  liveUpdates = true,
  agentInputGate?: Deferred.Deferred<void>,
) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', 'foreground fixture', 'codex', ${fullAccess ? "full-access" : "auto"}, 'default', '2026-01-01', '2026-01-01', '{}')`;
  const driver = CuaDriver.CuaDriver.of({
    enabled: Effect.succeed(true),
    acquire: Effect.succeedSome({ command: "/fixture/driver", args: ["mcp"], environment: [] }),
    lastFailure: Effect.succeedNone,
    block: Effect.succeed(undefined),
    status: Effect.succeed({ platform: "darwin", running: true }),
    computerUse: Effect.die("unused"),
    admitEnable: Effect.die("unused"),
  });
  // Only external transport configuration is substituted; all lease decisions remain real.
  const attachment = yield* computerUseAttachment(Option.some(driver), {
    threadId,
    driver: ProviderDriverKind.make("codex"),
    runtimeMode: fullAccess ? "full-access" : "auto",
    interactionMode: "default",
    readOnly: false,
    origin: { _tag: "unattended", reason: "goat_bot" },
    leases: Option.some({
      ...leases,
      proxy: { command: "/fixture/node", entrypoint: "/fixture/proxy" },
    }),
  });
  if (attachment._tag !== "proxied") return yield* Effect.die("expected real admitted attachment");
  const settings = yield* ServerSettings.ServerSettingsService;
  const updates = leaseUpdates({ threadId, controlId: attachment.control.controlId }).pipe(
    Stream.provideService(ComputerUseLeases.ComputerUseLeases, leases),
    Stream.provideService(ServerSettings.ServerSettingsService, settings),
  );
  const h = yield* harness({
    humanInput: agentInputGate !== undefined,
    ...(agentInputGate === undefined ? {} : { agentInputGate }),
    overlay: true,
    controlId: attachment.control.controlId,
    expiresAt: DateTime.formatIso(attachment.control.expiresAt),
    leaseUpdates: liveUpdates ? updates : updates.pipe(Stream.take(1), Stream.concat(Stream.never)),
    reservation: (request) => leases.callReservation(threadId, request).pipe(Effect.orDie),
  });
  return { attachment, leases, h };
});

describe("foreground through real computer-use attachment", () => {
  it.effect.each(["foreground", "background"] as const)(
    "refuses revoked %s authority after the input-start report while lease updates stall",
    (delivery) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* foregroundGrant(threadId, "handoff:report-background", {
          foreground: false,
          minutes: 10,
          apps: ["com.example.AppA"],
        });
        const grant = yield* foregroundGrant(threadId, "handoff:report-foreground", { minutes: 5 });
        const gate = yield* Deferred.make<void>();
        const { h, leases } = yield* attach(false, false, gate);
        const competitor = ThreadId.make("thread:report-competitor");
        const competingControl = yield* leases.control(competitor, Option.none());
        const competingCall = {
          action: "reserve" as const,
          controlId: competingControl.controlId,
          connectionId: "driver:competitor",
          callId: "same-window",
          interruptions: 0,
          idleEpoch: 0,
          name: "type_text",
          args: { pid: 43, window_id: 8, text: "competing work" },
        };
        yield* h.send(call(1, "list_apps"));
        yield* h.nextToDriver;
        yield* h.nextReservation;
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              structuredContent: {
                apps: [
                  { pid: 42, bundle_id: "com.example.AppA" },
                  { pid: 43, bundle_id: "com.example.AppB" },
                ],
              },
            },
          }),
        );
        yield* h.nextToProvider;
        yield* h.send(
          call(2, "type_text", {
            pid: 43,
            window_id: 8,
            text: "revoked work",
            delivery_mode: delivery,
          }),
        );
        assert.equal((yield* h.nextReservation).action, "reserve");
        assert.equal(yield* h.agentCall, "start 2");
        assert.equal(yield* h.driverQueued, 0);
        assert.deepEqual(yield* leases.callReservation(competitor, competingCall), {
          status: "refused",
          detail: "target_busy",
          holderThreadId: threadId,
        });
        yield* revokeForegroundGrant(grant.handoffId);
        yield* Deferred.succeed(gate, undefined);
        const observed = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "dispatched", message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer", message }))),
        );
        assert.equal(
          observed.kind,
          "answer",
          "Cancelled authority must not dispatch after the report",
        );
        const result = observed.message.result as { structuredContent: { detail: string } };
        assert.equal(
          result.structuredContent.detail,
          delivery === "foreground" ? "foreground_not_approved" : "app_not_approved",
        );
        assert.equal((yield* h.nextValidation).action, "validate");
        assert.equal((yield* h.nextReservation).action, "release");
        assert.equal(yield* h.agentCall, "end 2");
        const available = yield* leases.callReservation(competitor, competingCall);
        if (available.status !== "admitted" || available.reservationId === null)
          return assert.fail("denied confirmation must release the original window ownership");
        yield* leases.callReservation(competitor, {
          action: "release",
          controlId: competingControl.controlId,
          connectionId: competingCall.connectionId,
          reservationId: available.reservationId,
        });
        assert.include(
          h.log.findLast((entry) => entry.startsWith("draw ")),
          '"phase":"resting"',
        );
        yield* h.send(call(3, "type_text", { pid: 42, window_id: 7, text: "approved background" }));
        assert.equal((yield* h.nextToDriver).id, 3);
        assert.equal((yield* h.nextReservation).action, "reserve");
        assert.equal((yield* h.nextValidation).action, "validate");
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 3, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 3);
        assert.equal((yield* h.nextReservation).action, "release");
      }).pipe(Effect.provide(layer(false))),
  );

  it.effect.each(["expiry", "cancel"] as const)(
    "keeps background app scope after foreground %s while lease updates stall",
    (ending) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* foregroundGrant(threadId, "handoff:background-stalled", {
          foreground: false,
          minutes: 10,
          apps: ["com.example.AppA"],
        });
        const grant = yield* foregroundGrant(threadId, "handoff:foreground-stalled", {
          minutes: 5,
        });
        const { attachment, leases, h } = yield* attach(false, false);
        const apps = {
          apps: [
            { pid: 42, bundle_id: "com.example.AppA" },
            { pid: 43, bundle_id: "com.example.AppB" },
          ],
        };
        yield* h.send(call(1, "list_apps"));
        assert.equal((yield* h.nextToDriver).id, 1);
        yield* h.nextReservation;
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: apps } }),
        );
        assert.equal((yield* h.nextToProvider).id, 1);
        if (ending === "expiry") {
          yield* TestClock.adjust("5 minutes");
          yield* h.killed;
          assert.equal((yield* h.nextReservation).action, "close");
          yield* h.restarted;
        } else yield* revokeForegroundGrant(grant.handoffId);
        const remaining = yield* leases.controlState(threadId, attachment.control.controlId);
        assert.deepEqual(remaining._tag === "active" ? remaining.apps : remaining, [
          "com.example.AppA",
        ]);
        if (ending === "expiry") {
          yield* h.send(call(2, "list_apps"));
          assert.equal((yield* h.nextToDriver).id, 2);
          yield* h.nextReservation;
          yield* h.reply(
            JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: apps } }),
          );
          assert.equal((yield* h.nextToProvider).id, 2);
        }
        yield* h.send(
          call(3, "type_text", { pid: 43, window_id: 8, text: "outside background scope" }),
        );
        const observed = yield* Effect.raceFirst(
          h.nextToDriver.pipe(Effect.map((message) => ({ kind: "dispatched" as const, message }))),
          h.nextToProvider.pipe(Effect.map((message) => ({ kind: "answer" as const, message }))),
        );
        assert.equal(observed.kind, "answer", "Ended foreground authority cannot admit app B");
        const result = observed.message.result as { structuredContent: { detail: string } };
        assert.equal(result.structuredContent.detail, "app_not_approved");
        assert.equal((yield* h.nextReservation).action, "reserve");
        assert.equal((yield* h.nextReservation).action, "release");
        yield* h.send(call(4, "type_text", { pid: 42, window_id: 7, text: "approved background" }));
        assert.equal((yield* h.nextToDriver).id, 4);
      }).pipe(Effect.provide(layer(false))),
  );

  it.effect.each(["none", "pause", "stop"] as const)(
    "binds a new foreground admission after an existing background control unless interrupted by %s",
    (interruption) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* foregroundGrant(threadId, "handoff:background-first", {
          foreground: false,
          minutes: 10,
        });
        const first = yield* attach(false);
        const grant = yield* foregroundGrant(threadId, "handoff:foreground-next");
        assert.isTrue(yield* first.leases.foregroundAvailable(threadId, "Check the build status"));
        if (interruption === "pause") {
          yield* first.leases.pause("takeover");
          yield* first.leases.resume;
        } else if (interruption === "stop") yield* first.leases.stop(threadId);
        const next = yield* attach(false);
        assert.notEqual(next.attachment.control.controlId, first.attachment.control.controlId);
        assert.equal(next.attachment.control.handoffId, grant.handoffId);
        assert.equal(
          yield* next.leases.foregroundAvailable(threadId, "Check the build status"),
          interruption === "none",
        );
        const decision = yield* next.leases.callReservation(threadId, {
          action: "reserve",
          controlId: next.attachment.control.controlId,
          connectionId: "driver:next-attachment",
          callId: "focus",
          interruptions: interruption === "pause" ? 1 : 0,
          idleEpoch: 0,
          foregroundGrantId: grant.handoffId,
          name: "bring_to_front",
          args: { pid: 42, window_id: 7 },
        });
        assert.deepEqual(
          decision.status === "admitted" ? { status: decision.status } : decision,
          interruption === "none"
            ? { status: "admitted" }
            : { status: "refused", detail: "foreground_not_approved" },
        );
      }).pipe(Effect.provide(layer(false))),
  );

  it.effect.each(["existing", "first"] as const)(
    "uses a shorter desktop foreground approval until expiry (attachment: %s)",
    (ordering) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const apps = ["com.example.AppA"];
        const background = yield* foregroundGrant(threadId, "handoff:long-app", {
          foreground: false,
          minutes: 10,
          apps,
        });
        const first = ordering === "existing" ? yield* attach(false) : undefined;
        if (first !== undefined) {
          const initial = yield* first.leases.controlState(
            threadId,
            first.attachment.control.controlId,
          );
          assert.deepEqual(initial._tag === "active" ? initial.apps : initial, apps);
        }
        const grant = yield* foregroundGrant(threadId, "handoff:short-desktop", { minutes: 5 });
        const { attachment, leases, h } = yield* attach(false);
        if (first !== undefined)
          assert.equal(attachment.control.controlId, first.attachment.control.controlId);
        assert.equal(attachment.control.handoffId, background.handoffId);
        assert.isTrue(yield* leases.foregroundAvailable(threadId, "Check the build status"));
        assert.isFalse(yield* leases.foregroundAvailable(threadId, "A different purpose"));
        const approved = yield* leases.controlState(threadId, attachment.control.controlId);
        assert.equal(approved._tag, "active");
        assert.isUndefined(
          approved._tag === "active" ? approved.apps : approved,
          "The actual attachment must admit the approved whole desktop, not only app A",
        );
        yield* h.send(
          call("foreground-B", "type_text", {
            pid: 43,
            window_id: 8,
            text: "approved desktop work",
            delivery_mode: "foreground",
          }),
        );
        assert.equal((yield* h.nextToDriver).id, "foreground-B");
        yield* h.nextReservation;
        yield* h.reply(
          JSON.stringify({ jsonrpc: "2.0", id: "foreground-B", result: { content: [] } }),
        );
        assert.equal((yield* h.nextToProvider).id, "foreground-B");
        yield* h.nextReservation;
        yield* h.send(call(1, "run_script", { script: "opaque approved work" }));
        assert.equal((yield* h.nextToDriver).id, 1);
        const reserved = yield* h.nextReservation;
        assert.equal(
          reserved.action === "reserve" ? reserved.foregroundGrantId : undefined,
          grant.handoffId,
        );
        yield* TestClock.adjust("5 minutes");
        yield* h.killed;
        assert.equal((yield* h.nextReservation).action, "close");
        const cutOff = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        assert.equal(cutOff.structuredContent.detail, "foreground_not_approved");
        yield* h.restarted;
        const remaining = yield* leases.controlState(threadId, attachment.control.controlId);
        assert.deepEqual(remaining._tag === "active" ? remaining.apps : remaining, apps);
        assert.isUndefined(remaining._tag === "active" ? remaining.foreground : remaining);
        assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build status"));
        yield* h.send(call(2, "run_script", { script: "expired desktop work" }));
        const refused = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        assert.equal(refused.structuredContent.detail, "desktop_not_approved");
        yield* h.send(call(3, "list_apps"));
        assert.equal((yield* h.nextToDriver).id, 3);
        yield* h.reply(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            result: {
              structuredContent: {
                apps: [
                  { pid: 42, bundle_id: apps[0] },
                  { pid: 43, bundle_id: "com.example.AppB" },
                ],
              },
            },
          }),
        );
        assert.equal((yield* h.nextToProvider).id, 3);
        yield* h.send(call(4, "type_text", { pid: 42, window_id: 7, text: "background" }));
        assert.equal((yield* h.nextToDriver).id, 4);
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 4, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 4);
        yield* h.send(
          call(5, "type_text", {
            pid: 43,
            window_id: 8,
            text: "unapproved",
            delivery_mode: "foreground",
          }),
        );
        const outside = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        assert.equal(outside.structuredContent.detail, "app_not_approved");
        yield* leases.approveForeground(grant, yield* leases.foregroundApprovalEpoch);
        const next = yield* attach(false);
        assert.isFalse(yield* leases.foregroundAvailable(threadId, "Check the build status"));
        assert.equal(next.attachment.control.controlId, attachment.control.controlId);
        assert.equal(next.attachment.control.handoffId, background.handoffId);
      }).pipe(Effect.provide(layer(false))),
  );

  it.effect.each([false, true])(
    "binds first unattended approval before its first control (full access %s)",
    (fullAccess) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const grant = yield* foregroundGrant(threadId, "handoff:first-attached");
        const { attachment, h } = yield* attach(fullAccess);
        assert.equal(attachment.control.handoffId, fullAccess ? undefined : grant.handoffId);
        yield* h.send(call(1, "bring_to_front", { pid: 42, window_id: 7 }));
        assert.equal((yield* h.nextToDriver).id, 1);
        const reserved = yield* h.nextReservation;
        assert.equal(
          reserved.action === "reserve" ? reserved.foregroundGrantId : undefined,
          grant.handoffId,
        );
        yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
        assert.equal((yield* h.nextToProvider).id, 1);
      }).pipe(Effect.provide(layer(fullAccess))),
  );

  it.effect("full-access attachment alone never supplies foreground authority", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const { h } = yield* attach(true);
      yield* h.send(call(1, "bring_to_front", { pid: 42, window_id: 7 }));
      const result = (yield* h.nextToProvider).result as { structuredContent: { detail: string } };
      assert.equal(result.structuredContent.detail, "foreground_not_approved");
      assert.equal(yield* h.driverQueued, 0);
    }).pipe(Effect.provide(layer(true))),
  );

  it.effect("handback keeps background admission but requires a new foreground approval", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* foregroundGrant(threadId, "handoff:handback");
      const { h, leases } = yield* attach(true);
      yield* h.send(call(1, "bring_to_front", { pid: 42, window_id: 7 }));
      yield* h.nextToDriver;
      yield* h.nextReservation;
      yield* h.reply(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } }));
      yield* h.nextToProvider;
      yield* h.nextReservation;
      yield* leases.pause("human_input");
      yield* h.killed;
      assert.equal((yield* h.nextReservation).action, "close");
      yield* leases.resume;
      yield* h.restarted;
      yield* h.send(call(2, "bring_to_front", { pid: 42, window_id: 7 }));
      const result = (yield* h.nextToProvider).result as { structuredContent: { detail: string } };
      assert.equal(result.structuredContent.detail, "foreground_not_approved");
      yield* h.send(call(3, "type_text", { pid: 42, window_id: 7, text: "background" }));
      assert.equal((yield* h.nextToDriver).id, 3);
    }).pipe(Effect.provide(layer(true))),
  );

  it.effect.each(["expiry", "cancel"] as const)(
    "cuts off outstanding foreground work on %s without another agent request",
    (ending) =>
      Effect.gen(function* () {
        yield* runMigrations();
        const grant = yield* foregroundGrant(threadId, "handoff:ending", { minutes: 5 });
        const { h } = yield* attach(true);
        yield* h.send(call(1, "run_script", { script: "opaque work" }));
        yield* h.nextToDriver;
        yield* h.nextReservation;
        if (ending === "expiry") yield* TestClock.adjust("5 minutes");
        else yield* revokeForegroundGrant(grant.handoffId);
        yield* h.killed;
        assert.equal((yield* h.nextReservation).action, "close");
        const result = (yield* h.nextToProvider).result as {
          structuredContent: { detail: string };
        };
        assert.equal(result.structuredContent.detail, "foreground_not_approved");
        yield* h.restarted;
        yield* h.send(call(2, "type_text", { pid: 42, window_id: 7, text: "background" }));
        assert.equal((yield* h.nextToDriver).id, 2);
      }).pipe(Effect.provide(layer(true))),
  );
});
