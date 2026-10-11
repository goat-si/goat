import {
  OrchestratorMcpFailure,
  OrchestratorMcpFailureCode,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadWaitInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { assertLiveCaller, readCaller } from "./threadAccess.ts";

/**
 * Routes the thread tools by host. A thread id belongs to the environment that
 * created it, so a thread is named by (host, threadId): an omitted host is
 * this environment, any other is an SSH alias whose own T3 server is called
 * through SshRemoteDispatch as an outside client. That server judges the call
 * again; this side only makes sure the caller asks for no more than it has.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_FAN_OUT_LIMIT = 100;
const REMOTE_TIMEOUT_MS = 120_000;
const DEFAULT_WAIT_MS = 10 * 60 * 1_000;
const MAX_WAIT_MS = 60 * 60 * 1_000;
/** Extra time a remote wait gets to answer after its own timeout. */
const WAIT_ANSWER_MARGIN_MS = 60_000;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message: Array.from(message).slice(0, 2000).join("") });

const isFailureCode = Schema.is(OrchestratorMcpFailureCode);

/** How an agent hears about a failed call on another machine. */
export function hostFailure(
  error: SshRemoteDispatch.SshRemoteDispatchError,
): OrchestratorMcpFailure {
  switch (error.reason) {
    case "invalid_request":
    case "host_unknown":
      return failure("invalid_request", error.message);
    case "ssh_failed":
    case "host_unavailable":
      return failure("host_unavailable", error.message);
    case "caller_changed":
      return failure("runtime_mode_escalation_denied", error.message);
    case "remote_refused":
      return failure(
        error.remoteCode !== undefined && isFailureCode(error.remoteCode)
          ? error.remoteCode
          : "orchestration_error",
        error.message,
      );
  }
}

type ListItem = OrchestratorMcpThreadListItem;

/** Newest first, as each environment lists its own; the host breaks the last tie. */
const newestFirst = (left: ListItem, right: ListItem) =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  right.threadId.localeCompare(left.threadId) ||
  (left.host ?? "").localeCompare(right.host ?? "");

/**
 * Merges the first `limit` threads of each environment into the first
 * `limit` overall. Each list must hold its own newest threads in the order
 * `newestFirst` uses, which makes the merged page exact.
 */
export function mergeHostThreadLists(
  lists: ReadonlyArray<{ readonly threads: ReadonlyArray<ListItem>; readonly total: number }>,
  limit: number,
): { readonly threads: Array<ListItem>; readonly total: number; readonly truncated: boolean } {
  const threads = lists
    .flatMap((list) => list.threads)
    .toSorted(newestFirst)
    .slice(0, limit);
  const total = lists.reduce((sum, list) => sum + list.total, 0);
  return { threads, total, truncated: total > threads.length };
}

const withoutHost = <T extends { readonly host?: unknown; readonly allHosts?: unknown }>(
  input: T,
): Omit<T, "host" | "allHosts"> => {
  const { host: _host, allHosts: _allHosts, ...rest } = input;
  return rest;
};

/** Another machine's answer is untrusted: it must decode as the tool's own result. */
const decodeRemote =
  <A, E>(decode: (value: unknown) => Effect.Effect<A, E>, host: string, tool: string) =>
  (value: unknown) =>
    decode(value).pipe(
      Effect.mapError(() =>
        failure("orchestration_error", `${host} returned a result ${tool} could not read.`),
      ),
    );

const decodeList = Schema.decodeUnknownEffect(OrchestratorMcpThreadListResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult);
const decodeWait = Schema.decodeUnknownEffect(OrchestratorMcpThreadWaitResult);
const decodeSend = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);
const decodeInterrupt = Schema.decodeUnknownEffect(OrchestratorMcpThreadInterruptResult);

export interface HostThreadsMcpServiceShape {
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
  /**
   * Calls one of a host's own read-only tools, such as goat_project_list, and
   * decodes the answer as `decode` reads that tool's result, tagged with the host.
   */
  readonly readOnHost: <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) => Effect.Effect<A & { readonly host: string }, OrchestratorMcpFailure>;
}

export class HostThreadsMcpService extends Context.Service<
  HostThreadsMcpService,
  HostThreadsMcpServiceShape
>()("t3/mcp/HostThreadsMcpService") {}

/**
 * The caller's current runtime mode, reloaded each time. Changing a thread on
 * another machine also needs default interaction mode: the remote session
 * carries only a runtime-mode ceiling, and the remote treats an outside client
 * as default, so it could not hold a plan-mode caller to plan mode.
 */
const authorize = (writes: boolean) =>
  readCaller().pipe(
    Effect.tap(assertLiveCaller),
    Effect.flatMap((caller) =>
      writes && caller.limits.interactionMode !== "default"
        ? Effect.fail(
            failure(
              "interaction_mode_escalation_denied",
              `Changing a thread on another machine needs a caller in default interaction mode; this caller is in ${caller.limits.interactionMode} mode.`,
            ),
          )
        : Effect.succeed(caller.limits.runtimeMode),
    ),
  );

const make = Effect.gen(function* () {
  const local = yield* OrchestratorMcpService.OrchestratorMcpService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const threads = yield* ThreadManagementService.ThreadManagementService;

  const call = (
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs?: number;
    },
  ) =>
    dispatch
      .callHostTool(
        {
          host: input.host,
          tool: input.tool,
          arguments: input.arguments,
          writes: input.writes,
          timeoutMs: input.timeoutMs ?? REMOTE_TIMEOUT_MS,
        },
        authorize(input.writes).pipe(
          Effect.provideService(McpInvocationContext, scope),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
        ),
      )
      .pipe(
        Effect.mapError((error) =>
          error instanceof SshRemoteDispatch.SshRemoteDispatchError ? hostFailure(error) : error,
        ),
      );

  /** One call to a host's own thread tool, decoded and tagged with the host. */
  const onHost = <A extends object, E>(
    scope: McpInvocationScope,
    input: {
      readonly host: string;
      readonly tool: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly writes: boolean;
      readonly timeoutMs?: number;
    },
    decode: (value: unknown) => Effect.Effect<A, E>,
  ) =>
    call(scope, input).pipe(
      Effect.flatMap(decodeRemote(decode, input.host, input.tool)),
      Effect.map((result) => ({ ...result, host: input.host })),
    );

  const listOnHost = Effect.fn("HostThreadsMcpService.listOnHost")(function* (
    scope: McpInvocationScope,
    host: string,
    input: OrchestratorMcpThreadListInput,
  ) {
    const args = withoutHost(input);
    const everyProject = args.projectId === undefined;
    const result = yield* onHost(
      scope,
      {
        host,
        tool: "goat_thread_list",
        // The caller has no thread on that host, so it has no project there either.
        arguments: everyProject ? { ...args, allProjects: true } : args,
        writes: false,
      },
      decodeList,
    ).pipe(
      Effect.catch((error) =>
        everyProject && error.code === "target_required"
          ? Effect.fail(
              failure(
                "invalid_request",
                `GOAT on ${host} is too old to list every project; update GOAT there or pass one of its projectIds, which goat_project_list with this host lists.`,
              ),
            )
          : Effect.fail(error),
      ),
    );
    return {
      ...result,
      currentThreadId: null,
      threads: result.threads.map((thread) => ({
        ...thread,
        host,
        ...(thread.projectId === undefined && result.projectId !== null
          ? { projectId: result.projectId }
          : {}),
      })),
    } satisfies OrchestratorMcpThreadListResult;
  });

  const listEverywhere = Effect.fn("HostThreadsMcpService.listEverywhere")(function* (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) {
    if (input.host !== undefined || input.projectId !== undefined || input.cursor !== undefined) {
      return yield* failure(
        "invalid_request",
        "allHosts lists every project everywhere and has no cursor; omit host, projectId, and cursor.",
      );
    }
    const limit = Math.min(input.limit ?? DEFAULT_LIST_LIMIT, MAX_FAN_OUT_LIMIT);
    const filters = {
      statuses: input.statuses,
      titleContains: input.titleContains,
      settled: input.settled,
      snoozed: input.snoozed,
      includeSubagents: input.includeSubagents,
      limit,
    };
    const hosts = yield* dispatch.connectedHosts;
    const [here, remote] = yield* Effect.all(
      [
        local.listThreads(scope, { ...filters, allProjects: true }),
        Effect.forEach(
          hosts,
          (host) =>
            listOnHost(scope, host, filters).pipe(
              Effect.result,
              Effect.map((result) => ({ host, result })),
            ),
          { concurrency: "unbounded" },
        ),
      ],
      { concurrency: "unbounded" },
    );
    const listed: Array<OrchestratorMcpThreadListResult> = [here];
    const unavailableHosts: Array<{ host: string; code: string; message: string }> = [];
    for (const { host, result } of remote) {
      if (result._tag === "Success") listed.push(result.success);
      else
        unavailableHosts.push({ host, code: result.failure.code, message: result.failure.message });
    }
    const merged = mergeHostThreadLists(listed, limit);
    return {
      projectId: null,
      currentThreadId: here.currentThreadId,
      threads: merged.threads,
      nextCursor: null,
      total: merged.total,
      truncated: merged.truncated,
      unavailableHosts,
    } satisfies OrchestratorMcpThreadListResult;
  });

  return HostThreadsMcpService.of({
    listThreads: (scope, input) =>
      input.allHosts === true
        ? listEverywhere(scope, input)
        : input.host === undefined
          ? local.listThreads(scope, input)
          : listOnHost(scope, input.host, input),
    readThread: (scope, input) =>
      input.host === undefined
        ? local.readThread(scope, input)
        : onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_read",
              arguments: withoutHost(input),
              writes: false,
            },
            decodeRead,
          ),
    waitForThread: (scope, input) => {
      if (input.host === undefined) return local.waitForThread(scope, input);
      const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_MS));
      return onHost(
        scope,
        {
          host: input.host,
          tool: "goat_thread_wait",
          arguments: { ...withoutHost(input), timeoutMs },
          writes: false,
          // A remote that times out answers timedOut:true; only silence past that is unavailability.
          timeoutMs: timeoutMs + WAIT_ANSWER_MARGIN_MS,
        },
        decodeWait,
      );
    },
    sendToThread: (scope, input) =>
      input.host === undefined
        ? local.sendToThread(scope, input)
        : onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_send",
              arguments: withoutHost(input),
              writes: true,
            },
            decodeSend,
          ),
    interruptThread: (scope, input) =>
      input.host === undefined
        ? local.interruptThread(scope, input)
        : onHost(
            scope,
            {
              host: input.host,
              tool: "goat_thread_interrupt",
              arguments: withoutHost(input),
              writes: true,
            },
            decodeInterrupt,
          ),
    readOnHost: (scope, input, decode) => onHost(scope, { ...input, writes: false }, decode),
  });
});

export const layer = Layer.effect(HostThreadsMcpService, make);
