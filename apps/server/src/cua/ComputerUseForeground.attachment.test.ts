import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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

const attach = Effect.fn("foreground.attachFixture")(function* (fullAccess: boolean) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${threadId}, 'project', 'foreground fixture', 'codex', ${fullAccess ? "full-access" : "auto"}, 'default', '2026-01-01', '2026-01-01', '{}')`;
  const driver = CuaDriver.CuaDriver.of({
    enabled: Effect.succeed(true),
    acquire: Effect.succeedSome({ command: "/fixture/driver", args: ["mcp"], environment: [] }),
    lastFailure: Effect.succeedNone,
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
  const h = yield* harness({
    controlId: attachment.control.controlId,
    expiresAt: DateTime.formatIso(attachment.control.expiresAt),
    leaseUpdates: leaseUpdates({ threadId, controlId: attachment.control.controlId }).pipe(
      Stream.provideService(ComputerUseLeases.ComputerUseLeases, leases),
      Stream.provideService(ServerSettings.ServerSettingsService, settings),
    ),
    reservation: (request) => leases.callReservation(threadId, request).pipe(Effect.orDie),
  });
  return { attachment, leases, h };
});

describe("foreground through real computer-use attachment", () => {
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
