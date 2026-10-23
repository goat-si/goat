import { expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ProviderTurnId,
  type OrchestrationV2ProviderThread,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeHarness, policy, selection, sessionAnswer, source } from "./adapter.testkit.ts";
import { ClaudeCloudError } from "./protocol.ts";
import { LOGIN } from "./testing.ts";

it.effect.each([1, 2])(
  "a registered folder's trust prompts (%s) are accepted, noticed in the thread and recorded",
  (prompts) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.trustPrompts(prompts);
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        expect(h.trustChecks).toEqual(["/fixture/project"]);
        expect(h.trustRecords).toEqual([
          { cwd: "/fixture/project", threadId: h.input.threadId, prompts },
        ]);
        const notices = h.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem.message]
            : [],
        );
        expect(notices).toEqual([
          "Claude Code asked to trust /fixture/project. GOAT accepted it automatically.",
        ]);
        expect(h.ledger.at(-1)?.status).toBe("running");
      }),
    ),
);

it.effect("a folder outside GOAT's projects keeps the trust rejection and records nothing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.trustPrompts(1);
      h.disallowTrust();
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.trustRecords).toEqual([]);
      expect(h.ledger.at(-1)).toMatchObject({
        status: "failed",
        error: "Claude Code hasn't trusted this folder yet.",
      });
    }),
  ),
);

it.effect(
  "acceptance stays open until a linked PR is durably committed; the base owns result messages",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        expect(h.ledger.at(-1)?.tracking).toBe("polled");
        expect(h.events.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* Deferred.succeed(h.exit, undefined);
        yield* Deferred.await(h.read);
        expect(h.events.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("succeeded");
        expect(h.ledger.at(-1)?.summary).toContain("Result PR found\nChanged behavior.");
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        const result = h.events.findIndex(
          (event) =>
            event.type === "provider_thread.updated" &&
            event.providerThread.cloudTask?.status === "succeeded",
        );
        expect(result).toBeLessThan(h.events.findIndex((event) => event.type === "turn.terminal"));
        expect((yield* h.runtime.readThreadSnapshot({ providerThread: h.saved })).messages).toEqual(
          [],
        );
        yield* h.runtime.startTurn(h.input);
        expect(h.counts()).toEqual({ starts: 1, sends: 0, reads: 1 });
      }),
    ),
);
it.effect(
  "restart observes the saved ID without another launch and keeps the original deadline",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.noMatch();
        yield* TestClock.adjust("119 minutes");
        yield* h.runtime.resumeTurn!(h.attach);
        yield* Deferred.await(h.read);
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.url).toBe(h.saved.cloudTask.url);
        expect(h.counts().starts + h.counts().sends).toBe(0);
      }),
    ),
);
it.effect.each(["submitting", "unknown", "failed"] as const)(
  "attach reconciles %s without replay and duplicate attachment has one terminal",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const attach = {
          ...h.attach,
          cloudTask: { ...h.saved.cloudTask, status, progress: "Submitting follow-up" },
        };
        yield* h.runtime.resumeTurn!(attach);
        yield* Deferred.await(h.terminal);
        yield* h.runtime.resumeTurn!(attach);
        expect(h.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.ledger.at(-1)?.status).toBe("unknown");
      }),
    ),
);
it.effect(
  "committed PR result before crash completes the deterministic result without another lookup",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            status: "succeeded",
            prUrl: "https://github.com/fixture/repository/pull/1",
            branch: "claude/result",
            summary: "Delivered.",
          },
        });
        yield* Deferred.await(h.terminal);
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("completed");
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      }),
    ),
);
it.effect(
  "follow-up records intent and ack, preserves original source and completes from the session reply",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.sessionReads(sessionAnswer("task", "Answer."));
        const accepted = {
          ...h.saved,
          cloudTask: {
            ...h.saved.cloudTask,
            status: "submitting" as const,
            prUrl: "https://github.com/fixture/repository/pull/1",
            branch: "claude/old",
            summary: "Previous result",
          },
        };
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: accepted,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
          cloudSource: {
            repository: "https://github.com/fixture/other",
            branch: "dirty",
            sha: "b".repeat(40),
          },
        });
        yield* Deferred.await(h.admitted);
        expect(h.events.some((event) => event.type === "turn.terminal")).toBe(false);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(h.terminal);
        expect(h.ledger[0]?.progress).toBe("Submitting follow-up");
        expect(h.ledger[1]?.summary).toContain("not completed work");
        expect(h.ledger.at(-1)?.summary).toBe("Answer.");
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(h.ledger.at(-1)?.prUrl).toBeUndefined();
        expect(h.ledger.at(-1)?.taskId).toBe(accepted.nativeThreadRef.nativeId);
        expect(h.controlCommands).toEqual([
          { kind: "readiness", cwd: "/fixture/goat/control" },
          { kind: "send", cwd: "/fixture/goat/control", id: accepted.nativeThreadRef.nativeId },
        ]);
        const updated = h.events.findLast((event) => event.type === "provider_thread.updated");
        expect(updated?.providerThread.nativeThreadRef).toEqual(accepted.nativeThreadRef);
        expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
        expect(h.counts()).toEqual({ starts: 0, sends: 1, reads: 0 });
      }),
    ),
);
it.effect.each([1, 2])("follow-up commit failure %s never establishes delivery success", (index) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failCommit(index);
      yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.counts().sends).toBe(index === 1 ? 0 : 1);
      expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("failed");
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(
        h.events.find((event) => event.type === "provider_session.updated")?.providerSession
          .capabilities.sessions.followUp?.supported,
      ).toBe(false);
    }),
  ),
);
it.effect("crash during send leaves durable submitting and recovery never resends", () =>
  Effect.gen(function* () {
    let durable: OrchestrationV2ProviderThread["cloudTask"];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.pauseSend();
        yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
        yield* Deferred.await(h.sendReached);
        durable = h.ledger.at(-1);
        expect(durable?.status).toBe("submitting");
      }),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        const restored = yield* makeHarness();
        yield* restored.runtime.resumeTurn!({ ...restored.attach, cloudTask: durable! });
        yield* Deferred.await(restored.terminal);
        expect(restored.counts().sends).toBe(0);
        expect(restored.ledger.at(-1)?.status).toBe("unknown");
      }),
    );
  }),
);
it.effect.each(["rejected", "uncertain"] as const)(
  "follow-up %s keeps session identity and persists the correct delivery milestone",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.sendError(new ClaudeCloudError({ detail: "Delivery diagnostic", outcome }));
        yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe(outcome === "rejected" ? "running" : "unknown");
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(h.events.find((event) => event.type === "turn.terminal")?.status).toBe("failed");
      }),
    ),
);
it.effect("restart after follow-up ack follows the session reply without PR observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.sessionReads(sessionAnswer("an earlier prompt GOAT no longer has", "Restarted reply."));
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: { ...h.saved.cloudTask, progress: "Follow-up accepted" },
      });
      yield* Deferred.await(h.following);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(h.terminal);
      expect(h.counts().reads).toBe(0);
      expect(h.events.find((event) => event.type === "turn.terminal")).toMatchObject({
        status: "completed",
        resultText: "Restarted reply.",
      });
      expect(h.events.filter((event) => event.type === "message.updated")).toEqual([]);
    }),
  ),
);
it.effect("unsupported cancel leaves remote identity intact and invokes zero commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const error = yield* h.runtime
        .interruptTurn({
          providerThread: h.saved,
          providerTurnId: ProviderTurnId.make("cancel-test"),
        })
        .pipe(Effect.flip);
      expect(error.message).toContain("no supported CLI cancellation");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);
it.effect(
  "observer scope shutdown detaches without changing task to cancelled or sending commands",
  () =>
    Effect.gen(function* () {
      let seen: NonNullable<OrchestrationV2ProviderThread["cloudTask"]>[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          yield* h.runtime.resumeTurn!(h.attach);
          yield* Deferred.await(h.read);
          seen = h.ledger;
          expect(h.counts().sends).toBe(0);
        }),
      );
      expect(seen.some((task) => task.status === "cancelled")).toBe(false);
    }),
);

it.effect(
  "control directory rejection preserves the accepted session without another launch or send",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.controlError(
          new ClaudeCloudError({ detail: "Control cwd unavailable", outcome: "rejected" }),
        );
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: h.saved,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
        });
        yield* Deferred.await(h.terminal);
        expect(h.controlCommands).toEqual([]);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.ledger.at(-1)?.status).toBe("running");
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.nativeThreadRef.nativeId);
        expect(h.ledger.at(-1)?.source).toEqual(source);
        expect(
          h.events.some(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.capabilities.sessions.followUp?.supported === false,
          ),
        ).toBe(false);
      }),
    ),
);

it.effect("publishes the explicit source restriction and no local runtime capabilities", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      expect(h.runtime.providerSession.capabilities.sessions.sourceRestriction).toBe(
        "project-folder",
      );
      expect(h.runtime.providerSession.capabilities.turns.terminalStatusQuality).toBe("none");
      expect(h.runtime.providerSession.capabilities.tools.supportsMcpTools).toBe(false);
    }),
  ),
);
it.effect.each(["submitting", "unknown", "failed"] as const)(
  "blocks saved %s follow-ups even after base marks the current run submitting",
  (status) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const prior = { ...h.saved, cloudTask: { ...h.saved.cloudTask, status } };
        yield* h.runtime.resumeThread({ providerThread: prior });
        yield* h.runtime.startTurn({
          ...h.input,
          providerThread: { ...prior, cloudTask: { ...prior.cloudTask, status: "submitting" } },
        });
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
        expect(h.controlCommands).toEqual([]);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
      }),
    ),
);
it.effect("does not clear uncertainty on an otherwise unsupported follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({
        ...h.input,
        providerThread: { ...h.saved, cloudTask: { ...h.saved.cloudTask, status: "unknown" } },
        modelSelection: { ...selection, model: "local-model" },
      });
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.controlCommands).toEqual([]);
    }),
  ),
);
it.effect.each([
  { modelSelection: { ...selection, model: "local-model" } },
  { modelSelection: { ...selection, options: [{ id: "effort", value: "high" }] } },
  { runtimePolicy: { ...policy, interactionMode: "plan" as const } },
  { runtimePolicy: { ...policy, runtimeMode: "full-access" as const } },
  { runtimePolicy: { ...policy, reasoningEffort: "high" } },
])("rejects unsupported local controls before any remote command (%j)", (patch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({ ...h.input, ...patch, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.ledger.at(-1)?.summary).toContain("Follow-up rejected");
    }),
  ),
);
it.effect("changed sibling binding rejects without sending or rebinding the saved session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.login({ ...LOGIN, binding: "another-login" });
      yield* h.runtime.startTurn({ ...h.input, providerThread: h.saved });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
      expect(h.ledger.at(-1)?.status).toBe("running");
    }),
  ),
);
it.effect("trust refusal has no accepted create and preserves an actionable error summary", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.startError(
        new ClaudeCloudError({
          outcome: "rejected",
          detail:
            "Claude Code hasn't trusted this folder yet. Open it once with `claude` in /fixture/project, accept the trust prompt, then try again.",
        }),
      );
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.counts().starts).toBe(1);
      expect(h.ledger.at(-1)?.status).toBe("failed");
      expect(h.ledger.at(-1)?.summary).toContain("Open it once with `claude` in /fixture/project");
      expect(h.ledger.at(-1)?.taskId).toBe(h.input.runId);
    }),
  ),
);
it.effect(
  "post-acceptance sender failure retains identity and blocks follow-up without observing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        yield* Deferred.fail(
          h.exit,
          new ClaudeCloudError({ detail: "Sender exit uncertain", outcome: "uncertain" }),
        );
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.taskId).toBe(h.saved.cloudTask.taskId);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.summary).toBe("Sender exit uncertain");
        expect(h.counts().reads).toBe(0);
      }),
    ),
);
it.effect("incomplete GitHub reads use the original deadline and retain a curated reason", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.observationError(
        new ClaudeCloudError({ outcome: "uncertain", detail: "fixture raw GitHub defect" }),
      );
      yield* TestClock.adjust("119 minutes");
      yield* h.runtime.resumeTurn!(h.attach);
      yield* Deferred.await(h.read);
      yield* TestClock.adjust("1 minute");
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.ledger.at(-1)?.summary).toContain("GitHub observation was incomplete");
      expect(h.ledger.at(-1)?.summary).not.toContain("fixture raw");
    }),
  ),
);
it.effect("recovered rejection settles only its saved receipt and emits one terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const attach = {
        ...h.attach,
        cloudTask: {
          ...h.saved.cloudTask,
          progress: "Follow-up rejected",
          error: "Session archived",
        },
      };
      yield* h.runtime.resumeTurn!(attach);
      yield* Deferred.await(h.terminal);
      yield* h.runtime.resumeTurn!(attach);
      expect(h.ledger.at(-1)?.summary).toContain("Follow-up rejected: Session archived");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.events.filter((event) => event.type === "turn.terminal")).toHaveLength(1);
    }),
  ),
);
it.effect("saved malformed identity cannot perform observation or follow-up", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.resumeTurn!({
        ...h.attach,
        cloudTask: { ...h.saved.cloudTask, url: "https://claude.ai.evil.test/code/session_ABC123" },
      });
      yield* Deferred.await(h.terminal);
      expect(h.ledger.at(-1)?.status).toBe("unknown");
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);

it.effect(
  "bounds final result summary while retaining the PR Summary prefix and truth caveat",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.summary("Summary start. " + "x".repeat(4000));
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.accepted);
        yield* Deferred.succeed(h.exit, undefined);
        yield* Deferred.await(h.read);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        const summary = h.ledger.at(-1)?.summary;
        expect(summary?.length).toBeLessThanOrEqual(4000);
        expect(summary).toMatch(/^Result PR found\nSummary start\. /);
        expect(summary).toMatch(
          /PR presence does not confirm that the session stopped or its checks passed\.$/,
        );
      }),
    ),
);
it.effect("initial intent failure invokes no sender", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.failCommit(1);
      yield* h.runtime.startTurn(h.input);
      yield* Deferred.await(h.terminal);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.ledger.at(-1)?.status).toBe("unknown");
    }),
  ),
);
it.effect(
  "failed initial acceptance acknowledgement retains the known ID and performs no PR reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.failCommit(2);
        yield* h.runtime.startTurn(h.input);
        yield* Deferred.await(h.terminal);
        expect(h.ledger.at(-1)?.status).toBe("unknown");
        expect(h.ledger.at(-1)?.taskId).toBe("session_ABC123");
        expect(h.ledger.at(-1)?.url).toBe("https://claude.ai/code/session_ABC123");
        expect(h.counts().starts).toBe(1);
        expect(h.counts().reads).toBe(0);
      }),
    ),
);

it.effect("rejects attachments before readiness or submission", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.runtime.startTurn({
        ...h.input,
        providerThread: h.saved,
        message: {
          ...h.input.message,
          attachments: [
            {
              type: "file",
              id: ChatAttachmentId.make("fixture-file"),
              name: "fixture.txt",
              mimeType: "text/plain",
              sizeBytes: 1,
            },
          ],
        },
      });
      yield* Deferred.await(h.terminal);
      expect(h.controlCommands).toEqual([]);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
    }),
  ),
);

it.effect.each(
  [true, false, undefined].flatMap((included) =>
    ["result", "rejected", "uncertain"].map((outcome) => ({ included, outcome })),
  ),
)(
  "launches the project folder without a pushed SHA and preserves source evidence (%s)",
  ({ included, outcome }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const input = {
          ...h.input,
          cloudSource: { repository: source.repository, branch: "unpublished-local" },
          providerThread: {
            ...h.input.providerThread,
            cloudTask: {
              ...h.saved.cloudTask,
              taskId: h.input.runId,
              status: "submitting" as const,
              localChangesExcluded: true,
              ...(included === undefined ? {} : { localChangesIncluded: included }),
            },
          },
        };
        if (outcome !== "result")
          h.startError(
            new ClaudeCloudError({
              outcome: outcome === "rejected" ? "rejected" : "uncertain",
              detail: "Fixture sender refusal or uncertain admission",
            }),
          );
        yield* h.runtime.startTurn(input);
        if (outcome === "result") {
          yield* Deferred.await(h.accepted);
          yield* Deferred.succeed(h.exit, undefined);
          yield* Deferred.await(h.read);
          yield* Deferred.succeed(h.deliver, undefined);
        }
        yield* Deferred.await(h.terminal);
        expect(h.startCwds).toEqual(["/fixture/project"]);
        expect(h.controlCommands[0]?.cwd).toBe("/fixture/goat/control");
        expect(h.input.runtimePolicy.cwd).toBe("/fixture/repo");
        expect(h.input.appThread.worktreePath).toBe("/fixture/thread-worktree");
        expect(h.ledger[0]?.status).toBe("submitting");
        expect(h.ledger.at(-1)?.status).toBe(
          outcome === "result" ? "succeeded" : outcome === "rejected" ? "failed" : "unknown",
        );
        for (const task of h.ledger) {
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
          expect(task.localChangesExcluded).toBe(false);
          expect(task.source).toEqual(input.cloudSource);
        }
      }),
    ),
);

it.effect.each([
  { label: "missing launch source", launch: undefined, source },
  {
    label: "wrong restriction",
    launch: { cwd: "/fixture/project", restriction: "published-ref" as const },
    source,
  },
  { label: "empty cwd", launch: { cwd: " ", restriction: "project-folder" as const }, source },
  {
    label: "missing GitHub source",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: undefined,
  },
  {
    label: "non-GitHub source",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: { ...source, repository: "https://gitlab.com/fixture/repo" },
  },
  {
    label: "empty branch",
    launch: { cwd: "/fixture/project", restriction: "project-folder" as const },
    source: { ...source, branch: " " },
  },
])("rejects an ineligible project launch before creating remote work (%s)", (fixture) =>
  Effect.scoped(
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const { cloudLaunchSource: _launch, cloudSource: _source, ...input } = h.input;
      yield* h.runtime.startTurn({
        ...input,
        ...(fixture.launch === undefined ? {} : { cloudLaunchSource: fixture.launch }),
        ...(fixture.source === undefined ? {} : { cloudSource: fixture.source }),
      });
      yield* Deferred.await(h.terminal);
      expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 0 });
      expect(h.events.find((event) => event.type === "turn.terminal")?.failure?.message).toContain(
        "GitHub project folder",
      );
    }),
  ),
);

it.effect.each([true, false, undefined])(
  "follow-up keeps legacy source flags without a project launch source (%s)",
  (included) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.sessionReads(sessionAnswer("task", "Answer."));
        const prior = {
          ...h.saved,
          cloudTask: {
            ...h.saved.cloudTask,
            localChangesExcluded: true,
            ...(included === undefined ? {} : { localChangesIncluded: included }),
          },
        };
        const { cloudLaunchSource: _launch, ...input } = h.input;
        yield* h.runtime.startTurn({
          ...input,
          providerThread: prior,
          runtimePolicy: { ...policy, cwd: "/missing/deleted-project" },
          cloudSource: { ...source, repository: "https://github.com/fixture/other" },
        });
        yield* Deferred.await(h.admitted);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 1, reads: 0 });
        for (const task of h.ledger) {
          expect(task.source).toEqual(source);
          expect(task.localChangesExcluded).toBe(true);
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
        }
        expect(h.controlCommands.map((command) => command.cwd)).toEqual([
          "/fixture/goat/control",
          "/fixture/goat/control",
        ]);
      }),
    ),
);

it.effect.each([true, false, undefined])(
  "recovery preserves legacy upload evidence without creating or sending (%s)",
  (included) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.runtime.resumeTurn!({
          ...h.attach,
          cloudTask: {
            ...h.saved.cloudTask,
            localChangesExcluded: true,
            ...(included === undefined ? {} : { localChangesIncluded: included }),
          },
        });
        yield* Deferred.await(h.read);
        yield* Deferred.succeed(h.deliver, undefined);
        yield* Deferred.await(h.terminal);
        expect(h.counts()).toEqual({ starts: 0, sends: 0, reads: 1 });
        for (const task of h.ledger) {
          expect(task.localChangesIncluded).toBe(included);
          expect(Object.hasOwn(task, "localChangesIncluded")).toBe(included !== undefined);
          expect(task.localChangesExcluded).toBe(true);
          expect(task.source).toEqual(source);
        }
      }),
    ),
);
