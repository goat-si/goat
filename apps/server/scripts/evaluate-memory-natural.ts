// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone opt-in live eval.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as C from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { RpcClient } from "effect/rpc";
import { withNaturalHost } from "./memoryNaturalHost.ts";
import { confirmsRecall, installQuestion, summarizeNaturalTurn } from "./memoryNaturalTurn.ts";

const { values } = NodeUtil.parseArgs({
  options: { provider: { type: "string" }, model: { type: "string" } },
});
if (!values.provider || !values.model)
  throw new Error("Supply --provider and --model for three live GOAT turns.");
const modelSelection = {
  instanceId: C.ProviderInstanceId.make(values.provider),
  model: values.model,
};
const uuid = NodeCrypto.randomUUID;
const commandId = () => C.CommandId.make(uuid());
const group = C.WsRpcGroup.merge(C.WsMemoryRpcGroup);

const row = await withNaturalHost(async (workspace, protocol) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(group);
      const projectId = C.ProjectId.make(uuid());
      const reader = C.ThreadId.make(uuid());
      const writer = C.ThreadId.make(uuid());
      const memoryId = C.MemoryId.make(uuid());
      const { environment } = yield* client["server.getConfig"]({});
      const { settings } = yield* client["memory.hubSettings.get"]({});
      if (settings.mode !== "hub" || !settings.memorySpaceId)
        throw new Error("The fixture's memory hub is unavailable");
      const memorySpaceId = settings.memorySpaceId;
      const projectKey = { kind: "explicit" as const, sharedProjectId: uuid() };
      yield* client["projects.mutate"]({
        type: "project.create",
        commandId: commandId(),
        projectId,
        title: "Package manager fixture",
        workspaceRoot: workspace,
      });
      yield* client["memory.projectBinding.update"]({
        memorySpaceId,
        project: { environmentId: environment.environmentId, projectId },
        requestId: C.MemoryOperationId.make(uuid()),
        expectedVersion: 0,
        action: "setExplicit",
        sharedProjectId: projectKey.sharedProjectId,
      });
      for (const [threadId, title] of [
        [reader, "Reader"],
        [writer, "Writer"],
      ] as const) {
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.create",
          commandId: commandId(),
          threadId,
          projectId,
          title,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const write = Effect.fn("memoryEval.setInstallCommand")(function* (
        manager: "npm" | "pnpm",
        previous: C.MemoryRevisionId | null,
        evidence: readonly C.MemoryEvidence[],
      ) {
        const result = yield* client["memory.upsert"]({
          memorySpaceId,
          memoryId,
          operationId: C.MemoryOperationId.make(uuid()),
          expectedHeads: previous ? [previous] : [],
          scope: { kind: "project", projectKey },
          assertionKind: "fact",
          payload: {
            text: "Install dependencies for this project with " + manager + " install.",
            evidence,
            derivedFromMemoryRevisions: [],
          },
          baseBoundary: null,
        });
        if (result.outcome !== "accepted" || !result.revisionId)
          throw new Error("Fixture memory write failed: " + result.outcome);
        return result.revisionId;
      });
      const turn = Effect.fn("memoryEval.turn")(function* (threadId: C.ThreadId, text: string) {
        const messageId = C.MessageId.make(uuid());
        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: commandId(),
          threadId,
          messageId,
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const accepted = new Set<C.RuntimeRequestId>();
        const read = Effect.gen(function* () {
          const p = yield* client["orchestration.getThreadProjection"]({ threadId });
          const run = p.runs.find((r) => r.userMessageId === messageId);
          if (!run) return null;
          const items = p.turnItems.filter((item) => item.runId === run.id);
          const tools = items.filter((item) => item.type === "dynamic_tool");
          if (["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) {
            const approvals = items
              .filter((item) => item.type === "approval_request")
              .filter((item) => item.status === "waiting" && !accepted.has(item.requestId));
            if (approvals.length) {
              const [approval] = approvals;
              const running = tools.filter((tool) => tool.status === "running");
              if (approvals.length !== 1 || !approval || !confirmsRecall(approval, running))
                throw new Error("Fixture requires interactive approval for an unexpected tool");
              yield* client["orchestration.dispatchCommand"]({
                type: "runtime-request.respond",
                commandId: commandId(),
                threadId,
                requestId: approval.requestId,
                decision: "accept",
              });
              accepted.add(approval.requestId);
            }
            return null;
          }
          if (run.status !== "completed")
            throw new Error("Provider turn " + run.id + " ended " + run.status);
          const answer =
            p.messages.findLast((m) => m.runId === run.id && m.role === "assistant" && !m.streaming)
              ?.text ?? "";
          return {
            messageId,
            runId: run.id,
            answer,
            tools,
          };
        });
        const result = yield* read.pipe(
          Effect.repeat({ while: (r) => r === null, schedule: Schedule.spaced("500 millis") }),
          Effect.timeout("3 minutes"),
        );
        if (!result) throw new Error("No completed turn");
        return result;
      });
      const ask = Effect.fn("memoryEval.observeReader")(function* (
        expected: "npm" | "pnpm",
        currentRevision: C.MemoryRevisionId,
        previousRevision: C.MemoryRevisionId | null,
      ) {
        const { runId, answer, tools } = yield* turn(reader, installQuestion);
        const receipt = yield* client["memory.turn.inspect"]({
          memorySpaceId,
          threadId: reader,
          runId,
        });
        return {
          runId,
          currentRevision,
          ...summarizeNaturalTurn({
            answer,
            memoryId,
            previousRevision,
            currentRevision,
            expected,
            receipt,
            tools,
          }),
        };
      });
      const oldRevision = yield* write("npm", null, [{ origin: "user", messageIds: [] }]);
      const initial = yield* ask("npm", oldRevision, null);
      const change = yield* turn(
        writer,
        "This project has migrated to pnpm. The install command is now pnpm install. Acknowledge this change only; I will update the existing saved project memory.",
      );
      const currentRevision = yield* write("pnpm", oldRevision, [
        {
          origin: "user",
          sourceThread: { environmentId: environment.environmentId, threadId: writer },
          messageIds: [change.messageId],
        },
      ]);
      const followup = yield* ask("pnpm", currentRevision, oldRevision);
      return {
        scenario: "natural-package-manager-edit",
        modelSelection,
        reader,
        writer,
        writerRun: change.runId,
        memoryId,
        question: installQuestion,
        qualified: initial.outcome === "grounded-current",
        initial,
        followup,
      };
    }).pipe(Effect.scoped, Effect.provide(protocol), Effect.timeout("10 minutes")),
  ),
);
console.log(JSON.stringify(row));
