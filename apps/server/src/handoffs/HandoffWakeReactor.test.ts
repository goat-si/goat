import { expect, it } from "@effect/vitest";
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  PROVIDER_SETTINGS_HANDOFF_PATH,
  STORAGE_CLEAN_HANDOFF_PATH,
  StorageMcpCleanInput,
  CommandId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  threadId,
  person,
  withWorld,
  startEpoch,
  ask,
  wakes,
  resolution,
} from "./HandoffWakeReactor.testkit.ts";

it.effect("wakes the asking thread once when a person answers, even while its run is active", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      const event = yield* resolution(world, summary.handoffId);
      yield* world.reactor.handle(event);
      yield* world.reactor.handle(event);
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.id).toBe(`message:handoff-wake:${summary.handoffId}:completed`);
      expect(sent[0]!.text).toContain("was approved by a person");
      expect(sent[0]!.text).not.toContain("Laptop");
      expect(sent[0]!.text).not.toContain("PRIVATE-INSTRUCTIONS");
    }),
  ),
);

it.effect("tells the agent to continue an approved hub change through goat_call", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "hub.device_join");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      const sent = yield* wakes(world);
      expect(sent[0]!.text).toContain(
        `Call goat_call {path:"hub.device_join"} again with decisionId "${summary.handoffId}"`,
      );
    }),
  ),
);

it.effect("tells the agent to finish an approved storage cleanup with an argument it accepts", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, STORAGE_CLEAN_HANDOFF_PATH);
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      yield* world.reactor.handle(yield* resolution(world, summary.handoffId));
      const text = (yield* wakes(world))[0]!.text;
      const argument = /the same items and (\w+) "([^"]+)"/.exec(text);
      expect(argument?.[2]).toBe(summary.handoffId);
      expect(Object.keys(StorageMcpCleanInput.fields)).toContain(argument?.[1]);
    }),
  ),
);

it.effect(
  "stays quiet when an approval expires with its run, so the agent does not ask again",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        yield* ask(world, "example.approve");
        yield* world.orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop"),
          threadId,
        });
        yield* world.worker.drain();
        yield* world.handoffs.sweep;
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
      }),
    ),
);

it.effect("wakes once when a clocked handoff expires before a person answers", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
      const summary = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
      yield* TestClock.adjust("31 minutes");
      yield* world.handoffs.sweep;
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent.map((message) => message.id)).toEqual([
        `message:handoff-wake:${summary.handoffId}:expired`,
      ]);
      expect(sent[0]!.text).toContain("Ask again only if the user still wants it");
    }),
  ),
);

// #1521: a card's Stop ends the thread's grant. Waking the agent about it started a new turn,
// which took the screen again and replaced the stopped card.
it.effect(
  "stays quiet when a person ends an approved computer use grant, but not a pending request",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        const pending = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: pending.handoffId, action: "cancelled" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* world.reactor.reconcile;
        const sent = yield* wakes(world);
        expect(sent.map((message) => message.id).sort()).toEqual(
          [
            `message:handoff-wake:${approved.handoffId}:completed`,
            `message:handoff-wake:${pending.handoffId}:cancelled`,
          ].sort(),
        );
        // The approval's wake waited behind the thread's running turn; ending the grant withdrew
        // it, so it never starts a turn that takes the screen again.
        const runs = (yield* world.orchestrator.getThreadProjection(threadId)).runs;
        const approvalWake = runs.find(
          (run) => run.userMessageId === `message:handoff-wake:${approved.handoffId}:completed`,
        );
        expect(approvalWake?.status).toBe("cancelled");
      }),
    ),
);

it.effect(
  "a late approval event or a repeated end still wakes no agent whose grant a person ended",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        const approval = yield* resolution(world, approved.handoffId);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        // The approval's event reaches the reactor only now, after the end.
        yield* world.reactor.handle(approval);
        // A second end of the same grant, as a repeated Stop sends.
        yield* world.handoffs
          .respond({ threadId, handoffId: approved.handoffId, action: "cancelled" }, person)
          .pipe(Effect.ignore);
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
      }),
    ),
);

it.effect(
  "interrupts an approval wake that started its turn only after a person ended the grant",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        yield* world.reactor.reconcile;
        yield* TestClock.adjust("1 second");
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        // Before the reactor hears of the end, the thread's turn ends and the wake starts.
        yield* TestClock.adjust("1 second");
        yield* world.orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-first"),
          threadId,
        });
        yield* world.worker.drain();
        const wake = `message:handoff-wake:${approved.handoffId}:completed`;
        yield* world.orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-queue"),
          threadId,
        });
        yield* world.worker.drain();
        const started = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === wake,
        );
        expect(["running", "waiting", "starting"]).toContain(started?.status);
        yield* world.reactor.reconcile;
        yield* world.worker.drain();
        const after = (yield* world.orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === wake,
        );
        expect(after?.status).toBe("interrupted");
      }),
    ),
);

it.effect(
  "stays quiet when a person ends an approved computer use grant whose approval wake failed",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const expiresAt = DateTime.add(yield* DateTime.now, { minutes: 30 });
        const approved = yield* ask(world, COMPUTER_USE_GRANT_HANDOFF_PATH, expiresAt);
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "completed" },
          person,
        );
        world.outage.failing = 1;
        yield* world.reactor.reconcile;
        yield* world.handoffs.respond(
          { threadId, handoffId: approved.handoffId, action: "cancelled" },
          person,
        );
        yield* TestClock.adjust("20 minutes");
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
      }),
    ),
);

it.effect("wakes nothing before waking began, or resolved before it began", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "declined" },
        person,
      );
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
      yield* TestClock.adjust("1 minute");
      yield* startEpoch(world);
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
    }),
  ),
);

it.effect(
  "walks past command ids the orchestrator rejected before a restart and delivers at once",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, "example.approve");
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        // A long planning failure left rejected receipts under the first 25 command ids.
        const first = `server:handoff-wake:${summary.handoffId}:completed`;
        for (let attempt = 0; attempt < 25; attempt++)
          yield* world.sql`INSERT INTO orchestration_command_receipts
          (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
          VALUES (${attempt === 0 ? first : `${first}:attempt:${attempt}`}, 'thread', ${threadId},
          'message.dispatch', '2026-10-23T00:00:00.000Z', 0, 'rejected', 'adapter unavailable')`;
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(26);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(26);
        expect((yield* wakes(world)).map((message) => message.id)).toEqual([
          `message:handoff-wake:${summary.handoffId}:completed`,
        ]);
      }),
    ),
);

it.effect("makes one fresh attempt per eligible tick, waiting longer after each failure", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // Fourteen failures run the backoff past its 15-minute cap.
      world.outage.failing = 14;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      for (let attempt = 1; attempt < 14; attempt++) {
        const delayMs = Math.min(2 ** attempt * 1000, 15 * 60 * 1000);
        yield* TestClock.adjust(delayMs - 1);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(attempt);
        yield* TestClock.adjust(1);
        yield* world.reactor.reconcile;
        expect(world.outage.sent).toHaveLength(attempt + 1);
        expect(world.outage.sent.at(-1)).toMatch(new RegExp(`:attempt:${attempt}$`));
      }
      expect(yield* wakes(world)).toEqual([]);
      yield* TestClock.adjust("15 minutes");
      yield* world.reactor.reconcile;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(15);
      expect((yield* wakes(world)).map((message) => message.id)).toEqual([
        `message:handoff-wake:${summary.handoffId}:completed`,
      ]);
    }),
  ),
);

it.effect("reads the day's resolved handoffs through their index, not the whole history", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      const plan = yield* world.sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
        SELECT turn_item_id FROM orchestration_v2_projection_turn_items AS item
        WHERE item.type = 'human_handoff' AND item.status <> 'waiting'
          AND item.updated_at >= '2026-10-22T00:00:00.000Z'`;
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "orchestration_v2_projection_turn_items_resolved_handoff_idx (updated_at>?)",
      );
    }),
  ),
);

it.effect("counts the backoff from when a slow attempt failed", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "example.approve");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // The first attempt takes three seconds to fail, longer than its two-second backoff.
      world.outage.failing = 2;
      world.outage.slowMs = 3000;
      const first = yield* Effect.forkChild(world.reactor.reconcile);
      yield* Deferred.await(world.outage.arrived);
      yield* TestClock.adjust(3000);
      yield* Fiber.join(first);
      world.outage.slowMs = 0;
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      yield* TestClock.adjust(1999);
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(1);
      yield* TestClock.adjust(1);
      yield* world.reactor.reconcile;
      expect(world.outage.sent).toHaveLength(2);
    }),
  ),
);

it.effect(
  "wakes after GOAT finishes applying an approved provider change, saying how it ended",
  () =>
    withWorld((world) =>
      Effect.gen(function* () {
        yield* startEpoch(world);
        const summary = yield* ask(world, PROVIDER_SETTINGS_HANDOFF_PATH);
        yield* world.handoffs.respond(
          { threadId, handoffId: summary.handoffId, action: "completed" },
          person,
        );
        // Approved but not yet applied: an idle thread woken now would see no change and ask again.
        yield* world.reactor.reconcile;
        expect(yield* wakes(world)).toEqual([]);
        yield* world.handoffs.finishProviderContinuation(
          { threadId, handoffId: summary.handoffId },
          {
            version: 1,
            effects: { install: "started" },
            outcome: {
              state: "unknown_outcome",
              effect: "install",
              reason: "orchestration_error",
              message: "The install did not answer.",
              reconcile: { call: "goat_provider_diagnose", arguments: { instanceId: "cursor-2" } },
            },
          },
        );
        yield* world.reactor.reconcile;
        yield* world.reactor.reconcile;
        const sent = yield* wakes(world);
        expect(sent.map((message) => message.id)).toEqual([
          `message:handoff-wake:${summary.handoffId}:completed`,
        ]);
        expect(sent[0]!.text).toContain(
          'Call goat_call {path:"provider.diagnose", args:{"instanceId":"cursor-2"}} to settle it',
        );
      }),
    ),
);

it.effect("wakes after an approved provider sync settles, with how each host ended", () =>
  withWorld((world) =>
    Effect.gen(function* () {
      yield* startEpoch(world);
      const summary = yield* ask(world, "provider.host_sync");
      yield* world.handoffs.respond(
        { threadId, handoffId: summary.handoffId, action: "completed" },
        person,
      );
      // Installing on the hosts: an idle thread woken now would see nothing installed yet.
      yield* world.reactor.reconcile;
      expect(yield* wakes(world)).toEqual([]);
      yield* world.handoffs.finishProviderContinuation(
        { threadId, handoffId: summary.handoffId },
        {
          syncId: "sync-1",
          result: {
            syncId: "sync-1",
            driver: "codex",
            version: null,
            login: false,
            startedAt: "2026-10-23T00:00:00.000Z",
            done: true,
            hosts: [
              { host: null, phase: "installed", version: "0.163.0" },
              { host: "box", phase: "failed", version: null, message: "The installer exited 1." },
            ],
          },
        },
      );
      yield* world.reactor.reconcile;
      const sent = yield* wakes(world);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.text).toContain(
        "The sync finished on 1 of 2 host(s). box: failed (The installer exited 1.).",
      );
    }),
  ),
);
