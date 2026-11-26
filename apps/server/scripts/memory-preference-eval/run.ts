// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off -- opt-in measurement driver for a disposable GOAT server.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  CommandId,
  EnvironmentId,
  MemoryOperationId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WsMemoryRpcGroup,
  WsRpcGroup,
  type MemoryScope,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";
import { withEvalServer } from "./host.ts";
import { prompts, score, type Entry, type Observation } from "./score.ts";

const fixtureMemoryActions = new Set([
  "memory.remember",
  "memory.upsert",
  "memory.forget",
  "memory.search",
  "memory.recall",
  "memory.list",
  "memory.read",
  "memory.history",
]);

function memoryCall(item: OrchestrationV2TurnItem) {
  if (item.type !== "dynamic_tool" || item.toolName !== "goat.goat_call") return undefined;
  const input = item.input;
  if (
    typeof input !== "object" ||
    !input ||
    !("path" in input) ||
    typeof input.path !== "string" ||
    !fixtureMemoryActions.has(input.path)
  )
    return undefined;
  const args =
    "args" in input && typeof input.args === "object" && input.args !== null ? input.args : {};
  return {
    action: input.path,
    scope: "scope" in args && typeof args.scope === "string" ? args.scope : undefined,
    targetMemoryId:
      "memoryId" in args && typeof args.memoryId === "string" ? args.memoryId : undefined,
  };
}

const { values } = NodeUtil.parseArgs({
  options: { live: { type: "boolean" }, provider: { type: "string" }, model: { type: "string" } },
});
if (!values.live || !values.provider || !values.model)
  throw new Error(
    "Use --live --provider <instance> --model <model>. The three turns use that provider.",
  );
const modelSelection = {
  instanceId: ProviderInstanceId.make(values.provider),
  model: values.model,
};
const projects = ["default-project", "exception-project"] as const;
const results = await withEvalServer(async ({ root, origin, headers, rpc }) => {
  const environmentId = EnvironmentId.make(
    (await NodeFSP.readFile(NodePath.join(root, "goat/userdata/environment-id"), "utf8")).trim(),
  );
  for (const project of projects) {
    const workspaceRoot = NodePath.join(root, project);
    NodeChildProcess.execFileSync("git", ["init", "--quiet", workspaceRoot]);
    const created = await fetch(origin + "/api/projects/mutate", {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "project.create",
        commandId: NodeCrypto.randomUUID(),
        projectId: project,
        title: project,
        workspaceRoot,
      }),
    });
    if (!created.ok) throw new Error("Project creation failed: " + created.status);
  }
  return Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup.merge(WsMemoryRpcGroup));
      const hub = yield* client["memory.hubSettings.get"]({});
      if (hub.settings.mode !== "hub" || !hub.settings.memorySpaceId)
        throw new Error("Disposable memory hub is unavailable");
      const memorySpaceId = hub.settings.memorySpaceId;
      const threads = [
        ThreadId.make(NodeCrypto.randomUUID()),
        ThreadId.make(NodeCrypto.randomUUID()),
      ] as const;
      for (const [id, threadId] of [
        [projects[0], threads[0]],
        [projects[1], threads[1]],
      ] as const) {
        const projectId = ProjectId.make(id);
        yield* client["memory.projectBinding.update"]({
          memorySpaceId,
          project: { environmentId, projectId },
          requestId: MemoryOperationId.make(NodeCrypto.randomUUID()),
          expectedVersion: 0,
          action: "setExplicit",
          sharedProjectId: id,
        });
        yield* client["orchestration.dispatchCommand"]({
          type: "thread.create",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          projectId,
          title: "Package manager preferences",
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
      }
      const snapshot = Effect.fn("preferenceEval.snapshot")(function* () {
        const active: Entry[] = [];
        const history: Entry[] = [];
        const scopes = new Map<string, MemoryScope>([["user", { kind: "user" }]]);
        for (const [index, sharedProjectId] of projects.entries()) {
          scopes.set(sharedProjectId, {
            kind: "project",
            projectKey: { kind: "explicit", sharedProjectId },
          });
          const threadId = threads[index];
          if (threadId)
            scopes.set(sharedProjectId + "-thread", {
              kind: "thread",
              thread: { environmentId, threadId },
            });
        }
        for (const [scopeLabel, scope] of scopes) {
          const page = yield* client["memory.list"]({
            memorySpaceId,
            scope,
            limit: 100,
            includeQuarantined: true,
          });
          if (page.nextCursor)
            throw new Error("Unexpectedly large preference fixture; snapshot incomplete");
          for (const item of page.items) {
            if (item.status === "active")
              active.push({
                id: item.memoryId,
                scope: scopeLabel,
                revision: item.revision.revisionId,
                text: item.payload.text,
                parents: item.revision.parents,
                writtenBy:
                  item.revision.provenance.originThreadId ??
                  item.revision.provenance.sourceThread?.threadId,
              });
            const previous = yield* client["memory.history"]({
              memorySpaceId,
              memoryId: item.memoryId,
              limit: 100,
            });
            if (previous.nextCursor) throw new Error("Incomplete preference history");
            for (const h of previous.revisions) {
              if (h.payload)
                history.push({
                  id: item.memoryId,
                  scope: scopeLabel,
                  revision: h.revision.revisionId,
                  text: h.payload.text,
                  parents: h.revision.parents,
                  writtenBy:
                    h.revision.provenance.originThreadId ??
                    h.revision.provenance.sourceThread?.threadId,
                });
            }
          }
        }
        return { active, history } satisfies Observation;
      });
      const turn = Effect.fn("preferenceEval.turn")(function* (threadId: ThreadId, text: string) {
        const messageId = MessageId.make(NodeCrypto.randomUUID());
        const approved = new Set<string>();
        yield* client["orchestration.dispatchCommand"]({
          type: "message.dispatch",
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          threadId,
          messageId,
          text,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        while (true) {
          const thread = yield* client["orchestration.getThreadProjection"]({ threadId });
          const run = thread.runs.find((r) => r.userMessageId === messageId);
          if (run) {
            const items = thread.turnItems.filter((item) => item.runId === run.id);
            const running = items.filter(
              (item) => item.type === "dynamic_tool" && item.status === "running",
            );
            for (const request of items) {
              if (
                request.type !== "approval_request" ||
                request.status !== "waiting" ||
                approved.has(request.requestId)
              )
                continue;
              // Only confirm a single, identifiable Memory call in this synthetic thread.
              if (
                request.appName !== "goat" ||
                !request.prompt?.includes('"goat_call"') ||
                running.length !== 1 ||
                !running[0] ||
                !memoryCall(running[0])
              ) {
                throw new Error(
                  "Unexpected approval in the disposable thread: " + request.requestKind,
                );
              }
              yield* client["orchestration.dispatchCommand"]({
                type: "runtime-request.respond",
                commandId: CommandId.make(NodeCrypto.randomUUID()),
                threadId,
                requestId: request.requestId,
                decision: "accept",
              });
              approved.add(request.requestId);
            }
          }
          if (
            run &&
            ["completed", "cancelled", "interrupted", "failed", "rolled_back"].includes(run.status)
          ) {
            if (run.status !== "completed")
              throw new Error("Provider run ended " + run.status + " for message " + messageId);
            const tools = thread.turnItems.flatMap((item) =>
              item.runId === run.id && item.type === "dynamic_tool"
                ? [{ tool: item.toolName, ...memoryCall(item), status: item.status }]
                : [],
            );
            return {
              threadId,
              runId: run.id,
              model: run.modelSelection,
              text,
              tools,
              memory: yield* snapshot(),
            };
          }
          yield* Effect.sleep("500 millis");
        }
      }, Effect.timeout("3 minutes"));
      const initial = yield* turn(threads[0], prompts[0]);
      const correction = yield* turn(threads[0], prompts[1]);
      const exception = yield* turn(threads[1], prompts[2]);
      return {
        scenario: "package-manager-correction-v1",
        modelSelection,
        turns: [initial, correction, exception],
        ...score([initial.memory, correction.memory, exception.memory]),
      };
    }).pipe(Effect.provide(rpc), Effect.scoped),
  );
});
console.log(JSON.stringify(results, null, 2));
if (results.verdict === "fail") process.exitCode = 1;
if (results.verdict === "needs_review") process.exitCode = 2;
