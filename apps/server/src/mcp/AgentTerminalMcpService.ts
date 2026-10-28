import {
  OrchestratorMcpFailure,
  type AgentTerminalHandleInput,
  type AgentTerminalListResult,
  type AgentTerminalReadInput,
  type AgentTerminalReadResult,
  type AgentTerminalResult,
  type AgentTerminalWriteInput,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Manager from "../terminal/Manager.ts";
import type { AgentTerminalDescriptor } from "../terminal/AgentTerminalState.ts";
import * as Access from "./AgentWorkspaceTerminalAccess.ts";
import * as Audit from "./AgentWorkspaceTerminalAudit.ts";
import { makeTerminalTokens, type TerminalToken } from "./AgentTerminalTokens.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ToolAccess from "./McpToolAccess.ts";

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (error: unknown) =>
  isMcpFailure(error)
    ? error
    : new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The terminal operation failed. Read its status before retrying.",
      });
const missingManager = () => Access.denied("This environment does not support agent terminals.");
const samePermit = (a: Access.AgentWorkspacePermit, b: Access.AgentWorkspacePermit) =>
  a.projectId === b.projectId &&
  a.threadId === b.threadId &&
  a.root === b.root &&
  a.owner === b.owner &&
  a.bindingGeneration === b.bindingGeneration;

export class AgentTerminalMcpService extends Context.Service<
  AgentTerminalMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentTerminalListResult, OrchestratorMcpFailure>;
    readonly open: (
      scope: McpInvocationScope,
    ) => Effect.Effect<AgentTerminalResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: AgentTerminalReadInput,
    ) => Effect.Effect<AgentTerminalReadResult, OrchestratorMcpFailure>;
    readonly mutate: (
      scope: McpInvocationScope,
      input: AgentTerminalHandleInput | AgentTerminalWriteInput,
      operation: "write" | "clear" | "restart" | "close",
    ) => Effect.Effect<AgentTerminalResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/AgentTerminalMcpService") {}

const make = Effect.gen(function* () {
  const manager = yield* Manager.TerminalManager;
  const access = yield* Access.AgentWorkspaceTerminalAccess;
  const audit = yield* Audit.AgentWorkspaceTerminalAudit;
  const tokens = makeTerminalTokens();
  const owner = (scope: McpInvocationScope, permit: Access.AgentWorkspacePermit) =>
    `${scope.environmentId}/${permit.owner}/${permit.bindingGeneration ?? "thread"}`;
  const tokenOf = (
    scope: McpInvocationScope,
    permit: Access.AgentWorkspacePermit,
    terminal: AgentTerminalDescriptor,
  ): TerminalToken => ({
    environment: scope.environmentId,
    threadId: terminal.threadId,
    terminalId: terminal.terminalId,
    generation: terminal.generation,
    owner: permit.owner,
    binding: permit.bindingGeneration ?? null,
    root: permit.root,
    mutable: terminal.owned && terminal.cwd === permit.root,
  });
  const resultOf = (
    scope: McpInvocationScope,
    permit: Access.AgentWorkspacePermit,
    terminal: AgentTerminalDescriptor,
  ): AgentTerminalResult => ({
    handle: tokens.issue(tokenOf(scope, permit, terminal)),
    status: terminal.status,
    owned: terminal.owned && terminal.cwd === permit.root,
    pid: terminal.pid,
    exitCode: terminal.exitCode,
  });
  const parse = (value: string) =>
    Effect.try({
      try: () => tokens.read(value),
      catch: () =>
        Access.invalid(
          "The terminal handle or cursor is invalid or expired. Obtain a fresh handle with terminal.list.",
        ),
    });
  const checkToken = (
    scope: McpInvocationScope,
    permit: Access.AgentWorkspacePermit,
    token: TerminalToken,
  ) =>
    token.environment === scope.environmentId &&
    token.threadId === permit.threadId &&
    token.owner === permit.owner &&
    token.binding === (permit.bindingGeneration ?? null) &&
    token.root === permit.root
      ? Effect.void
      : Effect.fail(
          Access.denied("This terminal handle belongs to another opener, binding or workspace."),
        );
  const recheck = (
    scope: McpInvocationScope,
    permit: Access.AgentWorkspacePermit,
    writing: boolean,
  ) =>
    access
      .authorize(scope, {}, writing ? "terminal:operate" : "terminal:read")
      .pipe(
        Effect.flatMap((current) =>
          samePermit(permit, current)
            ? Effect.void
            : Effect.fail(
                Access.denied("The terminal binding or workspace changed during this operation."),
              ),
        ),
      );
  const list = Effect.fn("AgentTerminal.list")(function* (scope: McpInvocationScope) {
    const permit = yield* access.authorize(scope, {}, "terminal:read");
    if (!permit.threadId || !manager.agentList) return yield* missingManager();
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(scope, "terminal.list", permit.threadId, "requested", auditId);
    const terminals = yield* manager
      .agentList({
        threadId: permit.threadId,
        owner: owner(scope, permit),
        authorize: recheck(scope, permit, false),
      })
      .pipe(Effect.mapError(failure));
    yield* recheck(scope, permit, false);
    yield* audit.append(scope, "terminal.list", permit.threadId, "completed", auditId);
    return {
      terminals: terminals.map((terminal) => resultOf(scope, permit, terminal)),
      truncated: terminals.length === 100,
    };
  });
  const open = Effect.fn("AgentTerminal.open")(function* (scope: McpInvocationScope) {
    const permit = yield* access.authorize(scope, {}, "terminal:operate");
    if (!permit.threadId || !manager.agentOpen) return yield* missingManager();
    yield* ToolAccess.admit({ destination: permit, environment: scope.environmentId });
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(scope, "terminal.open", permit.threadId, "requested", auditId);
    const terminal = yield* manager
      .agentOpen({
        threadId: permit.threadId,
        cwd: permit.root,
        owner: owner(scope, permit),
        authorize: recheck(scope, permit, true),
      })
      .pipe(Effect.mapError(failure));
    yield* audit.append(scope, "terminal.open", terminal.terminalId, "completed", auditId);
    return resultOf(scope, permit, terminal);
  });
  const read = Effect.fn("AgentTerminal.read")(function* (
    scope: McpInvocationScope,
    input: AgentTerminalReadInput,
  ) {
    const permit = yield* access.authorize(scope, {}, "terminal:read");
    const handle = yield* parse(input.handle);
    yield* checkToken(scope, permit, handle);
    const cursor = input.cursor === undefined ? undefined : yield* parse(input.cursor);
    if (cursor) {
      yield* checkToken(scope, permit, cursor);
      if (cursor.terminalId !== handle.terminalId || cursor.position === undefined)
        return yield* Access.invalid(
          "The cursor belongs to another terminal or has no output position.",
        );
    }
    if (!manager.agentRead) return yield* missingManager();
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(scope, "terminal.read", handle.terminalId, "requested", auditId);
    const page = yield* manager
      .agentRead({
        threadId: handle.threadId,
        terminalId: handle.terminalId,
        generation: cursor?.generation ?? handle.generation,
        ...(cursor?.position === undefined ? {} : { position: cursor.position }),
        ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
        authorize: recheck(scope, permit, false),
      })
      .pipe(Effect.mapError(failure));
    yield* recheck(scope, permit, false);
    yield* audit.append(scope, "terminal.read", handle.terminalId, "completed", auditId);
    return {
      data: page.data,
      nextCursor: tokens.issue({ ...handle, generation: page.generation, position: page.position }),
      retainedStart: page.retainedStart,
      gap: page.gap,
      status: page.status,
      eof: page.eof,
    };
  });
  const mutate = Effect.fn("AgentTerminal.mutate")(function* (
    scope: McpInvocationScope,
    input: AgentTerminalHandleInput | AgentTerminalWriteInput,
    operation: "write" | "clear" | "restart" | "close",
  ) {
    const permit = yield* access.authorize(scope, {}, "terminal:operate");
    const handle = yield* parse(input.handle);
    yield* checkToken(scope, permit, handle);
    if (!handle.mutable)
      return yield* Access.denied("Only an agent terminal's authenticated opener may mutate it.");
    if (!manager.agentMutate) return yield* missingManager();
    yield* ToolAccess.admit({ ...input, operation, destination: permit });
    const auditId = Audit.newAccessAuditId();
    yield* audit.append(scope, `terminal.${operation}`, handle.terminalId, "requested", auditId);
    const terminal = yield* manager
      .agentMutate({
        threadId: handle.threadId,
        terminalId: handle.terminalId,
        generation: handle.generation,
        owner: owner(scope, permit),
        operation,
        ...("data" in input ? { data: input.data } : {}),
        authorize: recheck(scope, permit, true),
      })
      .pipe(Effect.mapError(failure));
    yield* audit.append(scope, `terminal.${operation}`, handle.terminalId, "completed", auditId);
    return resultOf(scope, permit, terminal);
  });
  return AgentTerminalMcpService.of({ list, open, read, mutate });
});
export const layer = Layer.effect(AgentTerminalMcpService, make);
