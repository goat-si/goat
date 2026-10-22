import {
  CommandId,
  OrchestratorMcpFailure,
  OrchestratorMcpLaunchedQuestionsResult,
  OrchestratorMcpThreadPendingRequestsResult,
  OrchestratorMcpPendingRequestReadResult,
  OrchestratorMcpPendingRequestRespondResult,
  ProviderRequestKind,
  type OrchestrationV2RuntimeRequest,
  type OrchestratorMcpPendingRequestListInput,
  type OrchestratorMcpPendingRequestListResult,
  type OrchestratorMcpPendingRequestReadInput,
  type OrchestratorMcpPendingRequestRespondInput,
  type OrchestratorMcpLaunchedQuestion,
  type UserInputRespondedBy,
  type ThreadId,
} from "@goat/contracts";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import { withHostFanOutDeadline } from "./hostFanOutDeadline.ts";
import {
  dispatchFailure,
  newCommandId,
  readCaller,
  readThread,
  unavailable,
} from "./threadAccess.ts";

const QUESTION_LIMIT = 100;
const HOST_LIMIT = 16;
const CONCURRENCY = 4;
const compareId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const FORWARD_TO_HUMAN =
  " This question needs a person: forward it to the user in your own thread, or let them answer it in the asking thread.";

/**
 * Only an outside MCP client whose session holds `orchestration:approve` may
 * see and answer provider approvals; agents inside GOAT never can.
 */
const canApprove = (scope: McpInvocationScope) =>
  scope.thread === undefined && scope.client?.approvals === true;
const approvalKinds: ReadonlySet<string> = new Set(ProviderRequestKind.literals);
const isApproval = (
  request: OrchestrationV2RuntimeRequest,
): request is OrchestrationV2RuntimeRequest & { readonly kind: ProviderRequestKind } =>
  approvalKinds.has(request.kind);
const approvalDenied = () =>
  new OrchestratorMcpFailure({
    code: "capability_denied",
    message:
      "Approvals are human-only for this caller. An MCP client token needs the orchestration:approve scope to answer them; otherwise forward the approval to the user.",
  });

export class PendingQuestionsMcpService extends Context.Service<
  PendingQuestionsMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestListInput,
    ) => Effect.Effect<OrchestratorMcpPendingRequestListResult, OrchestratorMcpFailure>;
    readonly read: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestReadInput,
    ) => Effect.Effect<OrchestratorMcpPendingRequestReadResult, OrchestratorMcpFailure>;
    readonly respond: (
      scope: McpInvocationScope,
      input: OrchestratorMcpPendingRequestRespondInput,
      commandId?: CommandId,
    ) => Effect.Effect<OrchestratorMcpPendingRequestRespondResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/PendingQuestionsMcpService") {}

const withoutHost = <T extends { readonly host?: unknown }>(input: T): Omit<T, "host"> => {
  const { host: _host, ...rest } = input;
  return rest;
};

const decodeLaunched = Schema.decodeUnknownEffect(OrchestratorMcpLaunchedQuestionsResult);
const decodeList = Schema.decodeUnknownEffect(OrchestratorMcpThreadPendingRequestsResult);
const decodeRead = Schema.decodeUnknownEffect(OrchestratorMcpPendingRequestReadResult);
const decodeRespond = Schema.decodeUnknownEffect(OrchestratorMcpPendingRequestRespondResult);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
  const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
  const inScope = <A, E, R>(scope: McpInvocationScope, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
    );
  const requireRemoteThread = (input: {
    readonly host?: string | undefined;
    readonly threadId?: ThreadId | undefined;
  }) =>
    input.host !== undefined && input.threadId === undefined
      ? Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId for a question on another host.",
          }),
        )
      : Effect.void;
  const readRequest = (scope: McpInvocationScope, input: OrchestratorMcpPendingRequestReadInput) =>
    Effect.gen(function* () {
      const context = yield* readThread(input.threadId, ["runtimeRequests", "turnItems"]);
      const request = context.projection.runtimeRequests.find(
        (request) => request.id === input.requestId,
      );
      if (request?.kind === "user_input") {
        const item = context.projection.turnItems.find(
          (item) => item.type === "user_input_request" && item.requestId === input.requestId,
        );
        if (item?.type === "user_input_request")
          return { ...context, request, questions: item.questions, approval: undefined };
      } else if (request !== undefined && isApproval(request) && canApprove(scope)) {
        const item = context.projection.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === input.requestId,
        );
        return {
          ...context,
          request,
          questions: [],
          approval: {
            kind: item?.type === "approval_request" ? item.requestKind : request.kind,
            ...(item?.type === "approval_request" && item.prompt !== undefined
              ? { prompt: item.prompt }
              : {}),
          },
        };
      }
      return yield* invalid("The user-input request was not found.");
    });
  const responseIdentity = (input: OrchestratorMcpPendingRequestRespondInput) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      if (context.caller !== undefined) {
        if (input.respondedBy !== undefined)
          return yield* invalid("A thread caller cannot supply respondedBy.");
        return {
          type: "agent",
          threadId: context.caller.id,
          environmentId: null,
          title: context.caller.title,
          reason: input.reason,
          ...(input.relayedFromUser === undefined
            ? {}
            : { relayedFromUser: input.relayedFromUser }),
        } satisfies UserInputRespondedBy;
      }
      const origin = input.respondedBy;
      if (origin === undefined)
        return {
          type: "client",
          ...(context.scope.client === undefined ? {} : { label: context.scope.client.label }),
          reason: input.reason,
        } satisfies UserInputRespondedBy;
      // A host relaying an approval names the outside client that decided it.
      if (
        origin.type === "client" &&
        input.decision !== undefined &&
        origin.reason === input.reason
      )
        return origin;
      if (
        origin.type !== "agent" ||
        origin.environmentId === null ||
        origin.environmentId === context.scope.environmentId ||
        origin.reason !== input.reason
      )
        return yield* invalid(
          "Transported respondedBy must name a foreign agent and use the same reason.",
        );
      return origin;
    });
  const launched = (scope: McpInvocationScope, input: OrchestratorMcpPendingRequestListInput) =>
    Effect.gen(function* () {
      const context = yield* readCaller();
      const foreign =
        input.launcherThreadId !== undefined || input.launcherEnvironmentId !== undefined;
      if (input.host !== undefined || input.threadId !== undefined)
        return yield* invalid(
          "For launched questions omit threadId and host; use hosts for fan-out.",
        );
      if (
        foreign &&
        (context.caller !== undefined ||
          input.hosts !== undefined ||
          input.launcherThreadId === undefined ||
          input.launcherEnvironmentId === undefined ||
          input.launcherEnvironmentId === scope.environmentId)
      )
        return yield* invalid(
          "Foreign launcher filters require an outside caller and a foreign identity pair.",
        );
      const launcherThreadId = foreign ? input.launcherThreadId : context.caller?.id;
      if (launcherThreadId === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "target_required",
          message: "Launched scope needs a thread caller or a foreign launcher filter.",
        });
      const candidates = yield* threads
        .getLaunchedPendingQuestions({
          launcherThreadId,
          launcherEnvironmentId: input.launcherEnvironmentId ?? null,
          limit: QUESTION_LIMIT + 1,
        })
        .pipe(Effect.mapError(unavailable));
      const matchedThreads = [
        ...new Set(candidates.slice(0, QUESTION_LIMIT).map((candidate) => candidate.threadId)),
      ];
      const local = (yield* Effect.forEach(
        matchedThreads,
        (threadId) =>
          Effect.gen(function* () {
            const projection = yield* threads
              .getThreadRecords(threadId, ["runtimeRequests", "turnItems"], {
                turnItemTypes: ["user_input_request"],
                runtimeRequestIds: candidates
                  .slice(0, QUESTION_LIMIT)
                  .filter((candidate) => candidate.threadId === threadId)
                  .map((candidate) => candidate.requestId),
              })
              .pipe(Effect.mapError(unavailable));
            const pendingIds = new Set(
              projection.runtimeRequests
                .filter((request) => request.kind === "user_input" && request.status === "pending")
                .map((request) => request.id),
            );
            return candidates
              .slice(0, QUESTION_LIMIT)
              .filter(
                (candidate) =>
                  candidate.threadId === threadId && pendingIds.has(candidate.requestId),
              )
              .flatMap((candidate) => {
                const item = projection.turnItems.find(
                  (item) =>
                    item.type === "user_input_request" && item.requestId === candidate.requestId,
                );
                return item?.type === "user_input_request"
                  ? [
                      {
                        host: null,
                        environmentId: scope.environmentId,
                        threadId,
                        title: projection.thread.title,
                        requestId: candidate.requestId,
                        questions: item.questions,
                        humanRequired:
                          exceededDispatchModeLimit(context.limits, projection.thread) !==
                          undefined,
                      } satisfies OrchestratorMcpLaunchedQuestion,
                    ]
                  : [];
              });
          }),
        { concurrency: CONCURRENCY },
      ))
        .flat()
        .toSorted(
          (a, b) => compareId(a.requestId, b.requestId) || compareId(a.threadId, b.threadId),
        );
      const locallyTruncated = candidates.length > QUESTION_LIMIT;
      // A transported filter only queries this destination, never its connected hosts.
      if (foreign) return { questions: local, truncated: locallyTruncated, unavailableHosts: [] };
      const aliases = [
        ...new Set(
          [...(yield* dispatch.connectedHosts), ...(input.hosts ?? [])].map((host) => host.trim()),
        ),
      ].toSorted();
      const pages = yield* Effect.forEach(
        aliases.slice(0, HOST_LIMIT),
        (host) =>
          hosts
            .readOnHost(
              scope,
              {
                host,
                tool: "goat_pending_request_list",
                arguments: {
                  scope: "launched",
                  launcherThreadId,
                  launcherEnvironmentId: scope.environmentId,
                },
              },
              decodeLaunched,
            )
            .pipe(
              Effect.flatMap((page) =>
                page.unavailableHosts.length > 0 ||
                page.questions.some((question) => question.host !== null)
                  ? Effect.fail(
                      new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: `${host} returned a non-local foreign-launcher page.`,
                      }),
                    )
                  : Effect.succeed({
                      ...page,
                      questions: page.questions.map((question) => ({
                        ...question,
                        host,
                        humanRequired:
                          question.humanRequired || context.limits.interactionMode !== "default",
                      })),
                    }),
              ),
              withHostFanOutDeadline(host),
              Effect.result,
              Effect.map((result) => ({ host, result })),
            ),
        { concurrency: CONCURRENCY },
      );
      const unique = new Map<string, OrchestratorMcpLaunchedQuestion>();
      const questions: Array<OrchestratorMcpLaunchedQuestion> = [...local];
      const unavailableHosts: Array<{ host: string; code: string; message: string }> = aliases
        .slice(HOST_LIMIT)
        .map((host) => ({
          host,
          code: "invalid_request",
          message:
            "Skipped this host because launched question discovery is limited to 16 hosts per call; query it directly with host and threadId.",
        }));
      let truncated = locallyTruncated;
      for (const { host, result } of pages) {
        if (result._tag === "Success") {
          questions.push(...result.success.questions);
          truncated ||= result.success.truncated;
        } else
          unavailableHosts.push({
            host,
            code: result.failure.code,
            message: result.failure.message,
          });
      }
      for (const question of questions) {
        const key = [question.environmentId, question.threadId, question.requestId]
          .map((part) => `${part.length}:${part}`)
          .join("");
        if (!unique.has(key)) unique.set(key, question);
      }
      const ordered = [...unique.values()].toSorted(
        (a, b) =>
          compareId(a.requestId, b.requestId) ||
          compareId(a.threadId, b.threadId) ||
          compareId(a.environmentId, b.environmentId),
      );
      return {
        questions: ordered.slice(0, QUESTION_LIMIT),
        truncated: truncated || ordered.length > QUESTION_LIMIT,
        unavailableHosts,
      };
    });
  return PendingQuestionsMcpService.of({
    list: (scope, input) =>
      inScope(
        scope,
        Effect.gen(function* () {
          if (input.scope === "launched") return yield* launched(scope, input);
          if (
            input.hosts !== undefined ||
            input.launcherThreadId !== undefined ||
            input.launcherEnvironmentId !== undefined
          )
            return yield* invalid("hosts and launcher filters require scope launched.");
          yield* requireRemoteThread(input);
          const { scope: _scope, ...remoteInput } = withoutHost(input);
          if (input.host !== undefined)
            return yield* hosts.readOnHost(
              scope,
              {
                host: input.host,
                tool: "goat_pending_request_list",
                arguments: remoteInput,
                approvals: canApprove(scope),
              },
              decodeList,
            );
          const { projection } = yield* readThread(input.threadId, ["runtimeRequests"]);
          const pending = projection.runtimeRequests.filter(
            (request) => request.status === "pending",
          );
          return {
            requestIds: pending
              .filter((request) => request.kind === "user_input")
              .map((request) => request.id),
            ...(canApprove(scope)
              ? { approvalRequestIds: pending.filter(isApproval).map((request) => request.id) }
              : {}),
          };
        }),
      ),
    read: (scope, input) =>
      inScope(
        scope,
        Effect.gen(function* () {
          yield* requireRemoteThread(input);
          if (input.host !== undefined)
            return yield* hosts.readOnHost(
              scope,
              {
                host: input.host,
                tool: "goat_pending_request_read",
                arguments: withoutHost(input),
                approvals: canApprove(scope),
              },
              decodeRead,
            );
          const { request, questions, approval } = yield* readRequest(scope, input);
          return {
            requestId: request.id,
            questions,
            ...(approval === undefined ? {} : { approval }),
            status: request.status,
            ...(request.decision === undefined ? {} : { decision: request.decision }),
            ...(request.respondedBy === undefined ? {} : { respondedBy: request.respondedBy }),
            resolvedAt: request.resolvedAt === null ? null : DateTime.formatIso(request.resolvedAt),
          };
        }),
      ),
    respond: (scope, input, commandId) =>
      inScope(
        scope,
        Effect.gen(function* () {
          yield* requireRemoteThread(input);
          if (input.answers !== undefined && input.decision !== undefined)
            return yield* invalid(
              "Send only answers for a user-input question, or only decision ('accept' or 'decline') for an approval; omit the other field.",
            );
          if (input.decision !== undefined && !canApprove(scope)) return yield* approvalDenied();
          const identity = yield* responseIdentity(input);
          if (input.host !== undefined) {
            const { caller } = yield* readCaller();
            const args = withoutHost(input);
            const { respondedBy: _transported, ...rest } = args;
            return yield* hosts
              .writeOnHost(
                scope,
                {
                  host: input.host,
                  tool: "goat_pending_request_respond",
                  arguments: {
                    ...rest,
                    ...(caller !== undefined && identity.type === "agent"
                      ? {
                          respondedBy: {
                            ...identity,
                            environmentId: identity.environmentId ?? scope.environmentId,
                          },
                        }
                      : input.decision !== undefined
                        ? { respondedBy: identity }
                        : {}),
                  },
                  approvals: input.decision !== undefined,
                },
                decodeRespond,
              )
              .pipe(
                Effect.mapError((error) => {
                  if (
                    input.decision !== undefined &&
                    error.message.includes("so nothing ran") &&
                    error.message.includes("does not take decision")
                  )
                    return invalid(
                      `GOAT on ${input.host} is too old to accept approvals over MCP; update GOAT there, or let the user answer in that thread.`,
                    );
                  if (
                    error.message.includes("so nothing ran") &&
                    (error.message.includes("does not take respondedBy") ||
                      error.message.includes("does not take reason"))
                  )
                    return invalid(
                      `GOAT on ${input.host} is too old to record who answered; update GOAT there to answer its questions from here, or let the user answer in that thread.`,
                    );
                  return (error.code === "runtime_mode_escalation_denied" ||
                    error.code === "interaction_mode_escalation_denied") &&
                    !error.message.includes(FORWARD_TO_HUMAN.trim())
                    ? new OrchestratorMcpFailure({
                        code: error.code,
                        message: error.message + FORWARD_TO_HUMAN,
                      })
                    : error;
                }),
              );
          }
          const { projection, request, questions } = yield* readRequest(scope, input);
          if (input.decision !== undefined && !isApproval(request))
            return yield* invalid("This request is a question; answer it with answers.");
          if (input.answers !== undefined && request.kind !== "user_input")
            return yield* invalid("This request is an approval; answer it with decision.");
          if (request.kind === "user_input") {
            const expectedIds = questions.map((question) => question.id);
            const expected = expectedIds.join(", ");
            if (input.answers === undefined)
              return yield* invalid(
                `Send answers keyed by question id${expected === "" ? "" : `. Expected question ids: ${expected}`}.`,
              );
            const answers = input.answers;
            // A request recorded without its questions cannot be checked; pass answers through.
            if (
              questions.length > 0 &&
              (Object.keys(answers).some((id) => !expectedIds.includes(id)) ||
                questions.some(
                  (question) => question.required !== false && !Object.hasOwn(answers, question.id),
                ))
            )
              return yield* invalid(
                `Send answers using the question ids from goat_pending_request_read, including every required question. Expected question ids: ${expected}.`,
              );
            for (const question of questions) {
              if (question.allowCustomAnswer !== false || !Object.hasOwn(answers, question.id))
                continue;
              const answer = answers[question.id];
              const values =
                typeof answer === "string" ? [answer] : Array.isArray(answer) ? answer : [];
              if (
                values.length === 0 ||
                (question.multiSelect !== true && values.length !== 1) ||
                values.some(
                  (value) =>
                    !question.options.some(
                      (option) =>
                        value === (option.value ?? option.label) || value === option.label,
                    ),
                )
              )
                return yield* invalid(
                  `Send answers["${question.id}"] as ${question.multiSelect === true ? "an array of allowed option strings" : "one allowed option string"}. Allowed options: ${question.options.map((option) => `"${option.value ?? option.label}"`).join(", ")}.`,
                );
            }
          } else if (input.decision === undefined) {
            return yield* invalid(
              "Send decision ('accept' or 'decline') for this approval; omit answers.",
            );
          }
          const result = yield* threads
            .dispatch({
              type: "runtime-request.respond",
              commandId: commandId ?? (yield* newCommandId()),
              threadId: projection.thread.id,
              requestId: input.requestId,
              ...(input.answers === undefined ? {} : { answers: input.answers }),
              ...(input.decision === undefined ? {} : { decision: input.decision }),
              respondedBy: identity,
            })
            .pipe(Effect.mapError(dispatchFailure));
          return { sequence: result.sequence };
        }),
      ),
  });
});
export const layer = Layer.effect(PendingQuestionsMcpService, make);
