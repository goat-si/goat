/**
 * request_secret: a private card in the asking thread whose value never reaches the agent. By
 * default the call waits for the person; with wait:false it returns needs_human with the card's
 * handoff at once, and the same clientRequestId collects the answer later in the run.
 *
 * @module SecretRequestTool
 */
import {
  OrchestratorMcpFailure,
  TurnItemId,
  handoffSummary,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
} from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type * as SecretRequests from "../secrets/SecretRequests.ts";
import type { McpInvocationScope, McpThreadInvocationScope } from "./McpInvocationContext.ts";
import { stableCommandId, stablePart } from "./stableCommandId.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const makeRequestSecret = (deps: {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly secretRequests: SecretRequests.SecretRequests["Service"];
  readonly loadThreadCaller: (
    scope: McpInvocationScope,
    operation: string,
  ) => Effect.Effect<
    {
      readonly scope: McpThreadInvocationScope;
      readonly parent: Parameters<typeof ThreadManagementService.latestActiveRun>[0];
    },
    OrchestratorMcpFailure
  >;
  readonly requestKey: (clientRequestId: string | undefined) => Effect.Effect<string>;
}) =>
  Effect.fn("OrchestratorMcpService.requestSecret")(function* (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ): Effect.fn.Return<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure> {
    const { threadManagement, secretRequests } = deps;
    // The follow-up call finds the card by this key, so a generated one would ask again.
    if (input.wait === false && input.clientRequestId === undefined)
      return yield* failure(
        "invalid_request",
        "Pass clientRequestId with wait:false; call again with the same id to collect the answer.",
      );
    const { scope: threadScope, parent } = yield* deps.loadThreadCaller(scope, "request_secret");
    const threadId = threadScope.thread.threadId;
    const run = ThreadManagementService.latestActiveRun(parent);
    if (
      run === undefined ||
      run.rootNodeId === null ||
      run.providerInstanceId !== threadScope.thread.providerInstanceId
    ) {
      return yield* failure(
        "parent_not_active",
        "Asking for a secret requires an active run owned by this MCP provider session.",
      );
    }
    const runId = run.id;
    const nodeId = run.rootNodeId;
    const key = yield* deps.requestKey(input.clientRequestId);
    let turnItemId = TurnItemId.make(
      `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
    );
    const record = (secretStatus: "pending" | "cancelled") =>
      threadManagement
        .dispatch({
          type: "secret_request.record",
          environmentId: threadScope.environmentId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: `secret-${secretStatus}`,
          }),
          threadId: threadId,
          runId,
          nodeId,
          turnItemId,
          label: input.label,
          reason: input.reason,
          ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
          ...(input.delivery === "file" ? { delivery: "file" as const } : {}),
          secretStatus,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Could not record the secret request: ${errorMessage(error)}`,
            ),
          ),
        );
    const readCard = threadManagement
      .getThreadRecords(threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read the secret request: ${errorMessage(error)}`,
          ),
        ),
        Effect.map((projection) => ({
          projection,
          item: projection.turnItems.find((candidate) => candidate.id === turnItemId),
        })),
      );
    const recorded = yield* record("pending");
    const recordedCard = recorded.storedEvents.find(
      (stored) =>
        stored.event.type === "turn-item.updated" && stored.event.payload.type === "secret_request",
    )?.event;
    const ownsCard =
      recordedCard?.type === "turn-item.updated" && recordedCard.payload.id === turnItemId;
    if (recordedCard?.type === "turn-item.updated") turnItemId = recordedCard.payload.id;

    const finish = Effect.fnUntraced(function* (
      status: "saved" | "declined" | "cancelled" | "timed_out",
    ) {
      yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
      if (status !== "saved") return { status };
      if (input.delivery === "file") {
        const file = yield* secretRequests
          .saveToFile({ threadId, turnItemId })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { status, file };
      }
      const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
      if (Option.isNone(secretRef)) {
        return yield* failure(
          "orchestration_error",
          "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
        );
      }
      return { status, secretRef: secretRef.value };
    });

    if (input.wait === false) {
      const { item } = yield* readCard;
      if (item?.type === "secret_request" && item.secretStatus !== "pending")
        return yield* finish(item.secretStatus);
      // A card without a handoff record has nothing a person can act on here; wait instead.
      if (item?.type === "secret_request" && item.handoff !== undefined)
        return {
          status: "pending",
          kind: "needs_human",
          handoff: handoffSummary(item.handoff),
          next: { after: "input", call: "request_secret" },
        };
    }

    // The creating call owns cancellation; retries of its request ID do not.
    const closeCard = ownsCard
      ? record("cancelled").pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close a secret request card", { error: error.message }),
          ),
        )
      : Effect.void;

    const answered = yield* Effect.gen(function* () {
      while (true) {
        const { projection, item } = yield* readCard;
        if (item?.type === "secret_request" && item.secretStatus !== "pending") {
          return item.secretStatus;
        }
        const current = projection.runs.find((candidate) => candidate.id === runId);
        if (current === undefined || ThreadManagementService.isTerminalRunStatus(current.status)) {
          yield* record("cancelled");
          return "cancelled" as const;
        }
        yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(
        Duration.millis(Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS)),
      ),
      Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
    );
    if (Option.isNone(answered)) yield* closeCard;
    const status = Option.isSome(answered)
      ? answered.value
      : yield* readCard.pipe(
          Effect.map(({ item }) =>
            item?.type === "secret_request" &&
            (item.secretStatus === "saved" || item.secretStatus === "declined")
              ? item.secretStatus
              : ("timed_out" as const),
          ),
          Effect.orElseSucceed(() => "timed_out" as const),
        );
    return yield* finish(status);
  });
