import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import { computerUseAttachment } from "./ComputerUseAttachment.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { database, run } from "./ComputerUseLeases.projection.testkit.ts";
import * as CuaDriver from "./CuaDriver.ts";

const layer = ComputerUseLeases.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      database,
      NodeServices.layer,
      ServerSettings.ServerSettingsService.layerTest({ enableCua: true }),
    ),
  ),
);

const driver = CuaDriver.CuaDriver.of({
  enabled: Effect.succeed(true),
  listedApps: Effect.succeedNone,
  appCatalog: Effect.succeed([]),
  acquire: Effect.succeedSome({ command: "/fixture/driver", args: ["mcp"], environment: [] }),
  lastFailure: Effect.succeedNone,
  block: Effect.succeed(undefined),
  status: Effect.succeed({ platform: "darwin", running: true }),
  computerUse: Effect.die("unused"),
  admitEnable: Effect.die("unused"),
});

/** A session prepared for the thread, as a turn start, a re-attach or a policy rotation does. */
const attach = Effect.fn("idleFixture.attach")(function* (threadId: ThreadId) {
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  // Only the transport is substituted; every lease decision is the real one.
  const attachment = yield* computerUseAttachment(Option.some(driver), {
    threadId,
    driver: ProviderDriverKind.make("codex"),
    interactionMode: "default",
    readOnly: false,
    origin: { _tag: "interactive" },
    leases: Option.some({ ...leases, proxy: { command: "/fixture/node", entrypoint: "/p" } }),
  });
  if (attachment._tag !== "proxied") return yield* Effect.die("expected a proxied attachment");
  const listed = (yield* leases.sessions).find(
    ({ control }) => control.controlId === attachment.control.controlId,
  );
  return { controlId: attachment.control.controlId, acting: listed?.control.idle !== true };
});

it.effect(
  "a session prepared after a restart for a thread with no open run lists no acting agent (#1551)",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const threadId = ThreadId.make("thread:restarted");
      // Its last turn ended before the restart; this server has no control for it yet.
      yield* run(threadId, "run-before-restart", 1, "completed");
      assert.isFalse((yield* attach(threadId)).acting);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a turn's own attachment acts, and a later preparation outside a turn leaves it idle",
  () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const threadId = ThreadId.make("thread:reprepared");
      const sql = yield* SqlClient.SqlClient;
      const leases = yield* ComputerUseLeases.ComputerUseLeases;
      yield* run(threadId, "run-turn", 1, "starting");
      const turn = yield* attach(threadId);
      assert.isTrue(turn.acting);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'run-turn'`;
      assert.isTrue(yield* leases.turnEnded(threadId));
      // Reused by a re-attach or a memory policy rotation, with no run left to end it.
      const reprepared = yield* attach(threadId);
      assert.equal(reprepared.controlId, turn.controlId);
      assert.isFalse(reprepared.acting);
    }).pipe(Effect.provide(layer)),
);
