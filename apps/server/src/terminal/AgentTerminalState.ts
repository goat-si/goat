// @effect-diagnostics-next-line nodeBuiltinImport:off -- PTY identities are synchronous, process-local UUIDs.
import * as NodeCrypto from "node:crypto";
import {
  OrchestratorMcpFailure,
  type TerminalError,
  type TerminalSessionStatus,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { BoundedTerminalHistory } from "./BoundedTerminalHistory.ts";

const DEFAULT_READ_BYTES = 8 * 1024;
const MAX_READ_BYTES = 32 * 1024;
const MAX_WRITE_BYTES = 16 * 1024;
const MAX_LIST_ENTRIES = 100;

interface AgentTerminalInput {
  readonly threadId: string;
  readonly authorize: Effect.Effect<void, OrchestratorMcpFailure>;
}

export interface AgentTerminalDescriptor {
  readonly threadId: string;
  readonly terminalId: string;
  readonly generation: string;
  readonly owned: boolean;
  readonly status: TerminalSessionStatus | "closed";
  readonly cwd: string;
  readonly pid: number | null;
  readonly exitCode: number | null;
  readonly exitSignal: number | null;
  readonly updatedAt: string;
}

export interface AgentTerminalSession {
  readonly threadId: string;
  readonly terminalId: string;
  readonly history: BoundedTerminalHistory;
  agentOwner: string | null;
  generation: string;
  agentRetired: boolean;
  agentBusy: boolean;
  status: TerminalSessionStatus;
  cwd: string;
  pid: number | null;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}

export interface AgentTerminalReadInput extends AgentTerminalInput {
  readonly terminalId: string;
  readonly generation?: string;
  readonly position?: number;
  readonly maxBytes?: number;
}

export interface AgentTerminalMutateInput extends AgentTerminalInput {
  readonly terminalId: string;
  readonly generation: string;
  readonly owner: string;
  readonly operation: "write" | "clear" | "restart" | "close";
  readonly data?: string;
}

export interface AgentTerminalOpenInput extends AgentTerminalInput {
  readonly cwd: string;
  readonly owner: string;
}

export interface AgentTerminalReadResult {
  readonly data: string;
  readonly position: number;
  readonly retainedStart: number;
  readonly generation: string;
  readonly gap: boolean;
  readonly status: TerminalSessionStatus;
  readonly eof: boolean;
}

export interface AgentTerminalMethods {
  readonly agentList: (
    input: AgentTerminalInput & { readonly owner?: string },
  ) => Effect.Effect<
    ReadonlyArray<AgentTerminalDescriptor>,
    TerminalError | OrchestratorMcpFailure
  >;
  readonly agentOpen: (
    input: AgentTerminalOpenInput,
  ) => Effect.Effect<AgentTerminalDescriptor, TerminalError | OrchestratorMcpFailure>;
  readonly agentRead: (
    input: AgentTerminalReadInput,
  ) => Effect.Effect<AgentTerminalReadResult, TerminalError | OrchestratorMcpFailure>;
  readonly agentMutate: (
    input: AgentTerminalMutateInput,
  ) => Effect.Effect<AgentTerminalDescriptor, TerminalError | OrchestratorMcpFailure>;
}

export function createAgentTerminalState() {
  return {
    agentOwner: null,
    generation: NodeCrypto.randomUUID(),
    agentRetired: false,
    agentBusy: false,
  };
}

export function resetAgentTerminal(session: AgentTerminalSession, owner: string | null = null) {
  session.generation = NodeCrypto.randomUUID();
  session.agentOwner = owner;
}

function descriptor(session: AgentTerminalSession, owner?: string): AgentTerminalDescriptor {
  return {
    threadId: session.threadId,
    terminalId: session.terminalId,
    generation: session.generation,
    owned: owner !== undefined && session.agentOwner === owner && !session.agentRetired,
    status: session.status,
    cwd: session.cwd,
    pid: session.pid,
    exitCode: session.exitCode,
    exitSignal: session.exitSignal,
    updatedAt: session.updatedAt,
  };
}

export function makeAgentTerminalOperations<S extends AgentTerminalSession>(operations: {
  readonly withThreadLock: <A, E>(
    threadId: string,
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E>;
  readonly sessionsForThread: (threadId: string) => Effect.Effect<ReadonlyArray<S>>;
  readonly requireSession: (
    threadId: string,
    terminalId: string,
  ) => Effect.Effect<S, TerminalError>;
  readonly open: (
    input: AgentTerminalOpenInput & { readonly terminalId: string },
  ) => Effect.Effect<S, TerminalError | OrchestratorMcpFailure>;
  readonly mutate: (
    session: S,
    input: AgentTerminalMutateInput,
  ) => Effect.Effect<void, TerminalError | OrchestratorMcpFailure>;
}): AgentTerminalMethods {
  const agentList = Effect.fn("terminal.agentList")(function* (
    input: AgentTerminalInput & { readonly owner?: string },
  ) {
    return yield* operations.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        yield* input.authorize;
        const sessions = yield* operations.sessionsForThread(input.threadId);
        yield* input.authorize;
        return sessions
          .filter((session) => !session.agentRetired)
          .slice(0, MAX_LIST_ENTRIES)
          .map((session) => descriptor(session, input.owner));
      }),
    );
  });

  const agentOpen = Effect.fn("terminal.agentOpen")(function* (input: AgentTerminalOpenInput) {
    if (!input.owner) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Terminal owner is required.",
      });
    }
    return yield* operations.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* operations.open({ ...input, terminalId: NodeCrypto.randomUUID() });
        return descriptor(session, input.owner);
      }),
    );
  });

  const agentRead = Effect.fn("terminal.agentRead")(function* (input: AgentTerminalReadInput) {
    const maxBytes = input.maxBytes ?? DEFAULT_READ_BYTES;
    if (
      !Number.isInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > MAX_READ_BYTES ||
      (input.position !== undefined &&
        (!Number.isSafeInteger(input.position) || input.position < 0))
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Invalid terminal read position or byte budget.",
      });
    }
    return yield* operations.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* operations.requireSession(input.threadId, input.terminalId);
        yield* input.authorize;
        if (session.agentRetired) {
          return yield* new OrchestratorMcpFailure({
            code: "not_found",
            message: "Terminal is no longer retained.",
          });
        }
        const reset = input.generation !== undefined && input.generation !== session.generation;
        if (!reset && input.position !== undefined && input.position > session.history.position) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: "Terminal position exceeds available output.",
          });
        }
        const page = session.history.read(
          reset ? undefined : input.position,
          maxBytes,
          session.status === "exited" || session.status === "error",
        );
        return {
          ...page,
          generation: session.generation,
          gap: reset || page.gap,
          status: session.status,
        };
      }),
    );
  });

  const agentMutate = Effect.fn("terminal.agentMutate")(function* (
    input: AgentTerminalMutateInput,
  ) {
    if (
      !["write", "clear", "restart", "close"].includes(input.operation) ||
      (input.operation === "write" &&
        (input.data === undefined ||
          input.data.length === 0 ||
          Buffer.byteLength(input.data) > MAX_WRITE_BYTES))
    ) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "Invalid terminal operation or input; input must be between 1 byte and 16 KiB.",
      });
    }
    return yield* operations.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const session = yield* operations.requireSession(input.threadId, input.terminalId);
        if (session.generation !== input.generation) {
          return yield* new OrchestratorMcpFailure({
            code: "conflict",
            message: "Terminal generation has changed.",
          });
        }
        const checkOwner = Effect.suspend(() =>
          !input.owner || session.agentRetired || session.agentOwner !== input.owner
            ? Effect.fail(
                new OrchestratorMcpFailure({
                  code: "capability_denied",
                  message: "Only the terminal opener may mutate it.",
                }),
              )
            : Effect.void,
        );
        yield* checkOwner;
        const result = descriptor(session, input.owner);
        yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            session.agentBusy = true;
          }),
          () =>
            operations.mutate(session, {
              ...input,
              authorize: input.authorize.pipe(Effect.andThen(checkOwner)),
            }),
          () =>
            Effect.sync(() => {
              session.agentBusy = false;
            }),
        );
        return input.operation === "close"
          ? {
              ...result,
              status: "closed" as const,
              pid: null,
              owned: false,
              updatedAt: session.updatedAt,
            }
          : descriptor(session, input.owner);
      }),
    );
  });
  return { agentList, agentOpen, agentRead, agentMutate };
}
