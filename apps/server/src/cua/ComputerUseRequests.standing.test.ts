import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { instanceId, threadId, withHarness } from "../handoffs/Handoffs.testkit.ts";
import * as ServerSettings from "../serverSettings.ts";
import { stopAllComputerUse, stopComputerUse } from "./ComputerUseRpcHandlers.ts";
import { applyPatch } from "./ComputerUseSettings.ts";
import {
  requestWithHandoffs,
  sessionId,
  supported,
  withRequests,
} from "./ComputerUseRequests.testkit.ts";

it.effect.each(["session", "named"] as const)("organization denial precedes %s approval", (kind) =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      if (kind === "named")
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("org-named"),
          threadId,
          messageId: MessageId.make("message:org-named"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({
            apps: [kind === "session" ? "com.example.Editor" : "com.example.Other"],
          });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            cuaDeniedApps: ["com.example.Editor"],
          });
          assert.deepInclude(yield* request({ apps: ["com.example.Editor"] }), {
            kind: "refused",
            code: "app_not_allowed",
          });
        }),
      );
    }),
  ),
);

it.effect.each([
  { original: "Please help", edit: "Use com.example.Editor", expected: "needs_human" },
  { original: "Use com.example.Editor", edit: "Please help", expected: "available" },
] as const)("only the person's original queued text names an app: $expected", (scenario) =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("person-queue"),
        threadId,
        messageId: MessageId.make("message:person-queue"),
        text: scenario.original,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "queued",
      );
      if (queued === undefined) return assert.fail("expected queued run");
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("agent-edit"),
        threadId,
        runId: queued.id,
        text: scenario.edit,
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, scenario.expected);
        }),
      );
    }),
  ),
);

it.effect.each(["end", "stop all", "disable"] as const)(
  "old mention cannot restore an approval after %s",
  (termination) =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("old-mention"),
          threadId,
          messageId: MessageId.make("message:old-mention"),
          text: "Use com.example.Editor",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            const first = yield* request({ apps: ["com.example.Editor"] });
            if (first.kind !== "needs_human") return assert.fail("expected approval");
            yield* handoffs.respond(
              {
                threadId,
                handoffId: first.handoff.handoffId,
                action: "completed",
                computerUseScope: "session",
              },
              sessionId,
            );
            if (termination === "end")
              yield* handoffs.respond(
                { threadId, handoffId: first.handoff.handoffId, action: "cancelled" },
                sessionId,
              );
            if (termination === "stop all")
              yield* stopAllComputerUse(Option.some(leases), handoffs, sessionId);
            if (termination === "disable") {
              const settings = yield* ServerSettings.ServerSettingsService;
              yield* handoffs.withComputerUseToggle(
                false,
                settings.updateSettings({ enableCua: false }),
              );
              yield* handoffs.withComputerUseToggle(
                true,
                settings.updateSettings({ enableCua: true }),
              );
            }
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("new-mention"),
              threadId,
              messageId: MessageId.make("message:new-mention"),
              text: "Use com.example.Editor",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "user",
              creationSource: "web",
            });
            assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          }),
        );
      }),
    ),
);

it.effect("a person's named app receives a session admission after a prior approval", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-app-message"),
        threadId,
        messageId: MessageId.make("message:named-app"),
        text: "Use com.example.Editor please",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }),
      );
    }),
  ),
);

it.effect.each([
  { title: "display name", text: "Please use Fancy Editor", expected: "available" },
  { title: "case insensitive bundle id", text: "use COM.EXAMPLE.EDITOR", expected: "available" },
  { title: "substring", text: "Use Fancy Editors", expected: "needs_human" },
  { title: "combining mark", text: "Use Fancy Editor\u0301", expected: "needs_human" },
  { title: "bundle id prefix", text: "Use com.example.Editor.extra", expected: "needs_human" },
  { title: "bundle id punctuation", text: "Use comXexampleXEditor", expected: "needs_human" },
  {
    title: "unlisted display name",
    text: "Use Fancy Editor",
    expected: "needs_human",
    unlisted: true,
  },
  {
    title: "unlisted bundle id",
    text: "Use com.example.Editor",
    expected: "available",
    unlisted: true,
  },
  { title: "agent message", text: "Use Fancy Editor", expected: "needs_human", agent: true },
  { title: "agent send", text: "Use Fancy Editor", expected: "needs_human", sender: true },
  {
    title: "scheduled message",
    text: "Use Fancy Editor",
    expected: "needs_human",
    scheduled: true,
  },
  { title: "remote launch", text: "Use Fancy Editor", expected: "needs_human", remote: true },
  {
    title: "no prior approval",
    text: "Use Fancy Editor",
    expected: "needs_human",
    noApproval: true,
  },
] as const)("named app: $title", (scenario) =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-scenario"),
        threadId,
        messageId: MessageId.make("message:named-scenario"),
        text: scenario.text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent" in scenario ? "agent" : "user",
        creationSource: "agent" in scenario ? "mcp" : "web",
        ...("scheduled" in scenario ? { scheduledTaskId: ScheduledTaskId.make("task:named") } : {}),
        ...("sender" in scenario ? { senderThreadId: ThreadId.make("thread:sender") } : {}),
      });
      yield* withRequests(
        orchestrator,
        supported,
        ({ request, handoffs, leases }) =>
          Effect.gen(function* () {
            if (!("noApproval" in scenario)) {
              const first = yield* request({ apps: ["com.example.Other"] });
              if (first.kind !== "needs_human") return assert.fail("expected approval");
              yield* handoffs.respond(
                { threadId, handoffId: first.handoff.handoffId, action: "completed" },
                sessionId,
              );
            }
            const result = yield* request({ apps: ["com.example.Editor"] });
            assert.equal(result.kind, scenario.expected);
            if (result.kind === "available") {
              const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
              assert.isTrue(
                records.turnItems.some(
                  (item) =>
                    item.type === "human_handoff" &&
                    item.handoff.reason.includes("person named the app"),
                ),
              );
              yield* stopComputerUse(Option.some(leases), handoffs, sessionId, threadId);
              assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
            }
          }),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "remote" in scenario ? "remote" : "person",
        undefined,
        "unlisted" in scenario ? [] : [{ id: "com.example.Editor", name: "Fancy Editor" }],
      );
    }),
  ),
);

it.effect("a named denied app is refused after a person's approval", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-denied"),
        threadId,
        messageId: MessageId.make("message:named-denied"),
        text: "Use com.1password.safari",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
          const denied = yield* request({ apps: ["com.1password.safari"] });
          assert.equal(denied.kind, "refused");
          if (denied.kind === "refused") assert.equal(denied.code, "app_not_allowed");
        }),
      );
    }),
  ),
);

it.effect("automatic approvals do not count as a person's first approval", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("auto-not-person"),
        threadId,
        messageId: MessageId.make("message:auto-not-person"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          yield* (yield* ServerSettings.ServerSettingsService).updateSettings({
            cuaAllowedApps: ["com.example.Other"],
          });
          assert.equal((yield* request({ apps: ["com.example.Other"] })).kind, "available");
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect("a person's approval survives a handoff service restart for named apps", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("named-restart"),
        threadId,
        messageId: MessageId.make("message:named-restart"),
        text: "Use com.example.Editor",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Other"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            { threadId, handoffId: first.handoff.handoffId, action: "completed" },
            sessionId,
          );
        }),
      );
      yield* withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }),
      );
    }),
  ),
);

it.effect("session approval renews an expired lease without a pending approval", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        const renewed = yield* request({ apps: ["COM.EXAMPLE.EDITOR"] });
        assert.equal(renewed.kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        const cards = records.turnItems.filter((item) => item.type === "human_handoff");
        assert.equal(cards.length, 2);
        assert.isTrue(
          cards.every(
            (item) => item.type === "human_handoff" && item.handoff.state === "completed",
          ),
        );
      }),
    ),
  ),
);

it.effect("a session choice survives restarting the handoff service", () =>
  withHarness(({ orchestrator }) =>
    Effect.gen(function* () {
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Editor"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            {
              threadId,
              handoffId: first.handoff.handoffId,
              action: "completed",
              computerUseScope: "session",
            },
            sessionId,
          );
        }),
      );
      yield* TestClock.adjust("31 minutes");
      yield* withRequests(orchestrator, supported, ({ request }) =>
        Effect.gen(function* () {
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        }),
      );
    }),
  ),
);

it.effect("ending a session admission requires another approval", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        const address = { threadId, handoffId: first.handoff.handoffId };
        yield* handoffs.respond(
          { ...address, action: "completed", computerUseScope: "session" },
          sessionId,
        );
        yield* handoffs.respond({ ...address, action: "cancelled" }, sessionId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("Stop clears a session even after its lease expires", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        yield* stopComputerUse(Option.some(leases), handoffs, sessionId, threadId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("Stop all clears session choices without active leases", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        yield* stopAllComputerUse(Option.some(leases), handoffs, sessionId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect(
  "turning computer use off clears sessions while enabling an already enabled host does not",
  () =>
    withHarness(({ orchestrator }) =>
      withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ enableCua: true });
          const first = yield* request({ apps: ["com.example.Editor"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            {
              threadId,
              handoffId: first.handoff.handoffId,
              action: "completed",
              computerUseScope: "session",
            },
            sessionId,
          );
          yield* handoffs.withComputerUseToggle(true, settings.updateSettings({ enableCua: true }));
          yield* TestClock.adjust("31 minutes");
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
          yield* handoffs.withComputerUseToggle(
            false,
            settings.updateSettings({ enableCua: false }),
          );
          yield* handoffs.withComputerUseToggle(true, settings.updateSettings({ enableCua: true }));
          assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        }),
      ),
    ),
);

it.effect("a session choice does not approve the same app in another thread", () =>
  withHarness(({ orchestrator, worker }) =>
    Effect.gen(function* () {
      const other = ThreadId.make("thread:session-other");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("session-other-create"),
        threadId: other,
        projectId: ProjectId.make("project:handoff-tests"),
        title: "Other",
        modelSelection: { instanceId, model: "fake" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("session-other-message"),
        threadId: other,
        messageId: MessageId.make("message:session-other"),
        text: "Use the app",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* withRequests(orchestrator, supported, ({ request, handoffs }) =>
        Effect.gen(function* () {
          const first = yield* request({ apps: ["com.example.Editor"] });
          if (first.kind !== "needs_human") return assert.fail("expected approval");
          yield* handoffs.respond(
            {
              threadId,
              handoffId: first.handoff.handoffId,
              action: "completed",
              computerUseScope: "session",
            },
            sessionId,
          );
          yield* TestClock.adjust("31 minutes");
          const otherResult = yield* requestWithHandoffs(
            handoffs,
            other,
          )({ apps: ["com.example.Editor"] });
          assert.equal(otherResult.kind, "needs_human");
        }),
      );
    }),
  ),
);

it.effect("always approval renews without a card until removed in settings", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "always",
          },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        assert.equal((yield* request({ apps: ["COM.EXAMPLE.EDITOR"] })).kind, "available");
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaAllowedApps: [] });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("removing an always choice ends its current admission", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "always",
          },
          sessionId,
        );
        yield* (yield* ServerSettings.ServerSettingsService).updateSettings({ cuaAllowedApps: [] });
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
        assert.equal((yield* leases.state(threadId, first.handoff.handoffId))._tag, "ended");
      }),
    ),
  ),
);

it.effect("Stop does not remove an always choice", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "always",
          },
          sessionId,
        );
        yield* stopComputerUse(Option.some(leases), handoffs, sessionId, threadId);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
      }),
    ),
  ),
);

it.effect("a concurrent re-enable cannot revive a session ended by turning computer use off", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ enableCua: true });
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const off = yield* handoffs
          .withComputerUseToggle(
            false,
            Effect.gen(function* () {
              yield* settings.updateSettings({ enableCua: false });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const on = yield* handoffs
          .withComputerUseToggle(true, settings.updateSettings({ enableCua: true }))
          .pipe(Effect.forkChild);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(off);
        yield* Fiber.join(on);
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect(
  "removal waits for an in-flight automatic grant and ends it before the next request",
  () =>
    withHarness(({ orchestrator }) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        yield* withRequests(
          orchestrator,
          supported,
          ({ request }) =>
            Effect.gen(function* () {
              const settings = yield* ServerSettings.ServerSettingsService;
              yield* settings.updateSettings({ cuaAllowedApps: ["com.example.Editor"] });
              const first = yield* request({ apps: ["com.example.Editor"] }).pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              const remove = yield* settings
                .updateSettings({ cuaAllowedApps: [] })
                .pipe(Effect.forkChild);
              yield* Deferred.succeed(release, undefined);
              assert.equal((yield* Fiber.join(first)).kind, "available");
              yield* Fiber.join(remove);
              assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
            }),
          undefined,
          undefined,
          undefined,
          undefined,
          (command) =>
            command.type === "handoff.create" && command.handoff.state === "completed"
              ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
        );
      }),
    ),
);

it.effect("an automatic session admission can be ended from its resolved item", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "available");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        const automatic = records.turnItems.find(
          (item) => item.type === "human_handoff" && item.handoff.computerUseScope === "standing",
        );
        if (automatic?.type !== "human_handoff")
          return assert.fail("expected resolved automatic admission");
        assert.include(automatic.handoff.reason, "standing choice");
        yield* handoffs.respond(
          { threadId, handoffId: automatic.handoff.handoffId, action: "cancelled" },
          sessionId,
        );
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("removing an allowed app ends its admission before the settings update returns", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs, leases }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "always",
          },
          sessionId,
        );
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* applyPatch(
          handoffs,
          { cuaAllowedApps: [] },
          settings.updateSettings({ cuaAllowedApps: [] }),
          "test",
        );
        assert.equal((yield* leases.state(threadId, first.handoff.handoffId))._tag, "ended");
      }),
    ),
  ),
);

it.effect("a queued app request cannot grant after computer use is switched off", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings({ cuaAllowedApps: ["com.example.Editor"] });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const off = yield* handoffs
          .withComputerUseToggle(
            false,
            Effect.gen(function* () {
              yield* settings.updateSettings({ enableCua: false });
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const pending = yield* request({ apps: ["com.example.Editor"] }).pipe(
          Effect.result,
          Effect.forkChild,
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(off);
        assert.equal((yield* Fiber.join(pending))._tag, "Failure");
        const records = yield* orchestrator.getThreadRecords(threadId, ["turnItems"]);
        assert.isFalse(records.turnItems.some((item) => item.type === "human_handoff"));
      }),
    ),
  ),
);

it.effect("a legacy approval remains time-limited without a standing choice", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.Editor"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          { threadId, handoffId: first.handoff.handoffId, action: "completed" },
          sessionId,
        );
        yield* TestClock.adjust("31 minutes");
        assert.equal((yield* request({ apps: ["com.example.Editor"] })).kind, "needs_human");
      }),
    ),
  ),
);

it.effect("ending one admission clears the thread's other session admissions", () =>
  withHarness(({ orchestrator }) =>
    withRequests(orchestrator, supported, ({ request, handoffs }) =>
      Effect.gen(function* () {
        const first = yield* request({ apps: ["com.example.AppA"] });
        if (first.kind !== "needs_human") return assert.fail("expected approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: first.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        const second = yield* request({ apps: ["com.example.AppB"] });
        if (second.kind !== "needs_human") return assert.fail("expected second approval");
        yield* handoffs.respond(
          {
            threadId,
            handoffId: second.handoff.handoffId,
            action: "completed",
            computerUseScope: "session",
          },
          sessionId,
        );
        yield* handoffs.respond(
          { threadId, handoffId: first.handoff.handoffId, action: "cancelled" },
          sessionId,
        );
        assert.equal((yield* request({ apps: ["com.example.AppB"] })).kind, "needs_human");
      }),
    ),
  ),
);
