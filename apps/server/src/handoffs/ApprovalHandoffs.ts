/**
 * Approval handoffs a person answers in a GOAT client, bound to the exact change they approve:
 * the continuation arguments are stored encrypted and compared by HMAC, so an approval for one
 * device, key or launch never authorizes another.
 *
 * @module ApprovalHandoffs
 */
import {
  OrchestratorMcpFailure,
  TurnItemId,
  type HandoffSummary,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Handoffs from "./Handoffs.ts";

type Binding = Readonly<Record<string, unknown>>;
const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export class ApprovalHandoffs extends Context.Service<
  ApprovalHandoffs,
  {
    readonly request: (input: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
      readonly targetPath: string;
      readonly title: string;
      readonly reason: string;
      /** Shown only to the person reviewing it. */
      readonly location: string;
      readonly binding: Binding;
      readonly expiresAt: DateTime.Utc;
    }) => Effect.Effect<HandoffSummary, OrchestratorMcpFailure>;
    /** Succeeds only for an unexpired approval a person gave to exactly this change. */
    readonly verify: (input: {
      readonly threadId: ThreadId;
      readonly handoffId: string;
      readonly targetPath: string;
      readonly binding: Binding;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/handoffs/ApprovalHandoffs") {}

const make = Effect.gen(function* () {
  const handoffs = yield* Handoffs.Handoffs;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const request: ApprovalHandoffs["Service"]["request"] = Effect.fn("ApprovalHandoffs.request")(
    function* (input) {
      const records = yield* threads
        .getThreadRecords(input.threadId, ["runs"])
        .pipe(Effect.mapError(() => invalid("The asking thread was not found.")));
      const run = ThreadManagement.latestActiveRun(records);
      if (run === undefined || run.rootNodeId === null)
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Ask from a running turn of this thread.",
        });
      return yield* handoffs
        .create({
          kind: "approval",
          title: input.title,
          reason: input.reason,
          requestedBy: {
            threadId: input.threadId,
            providerInstanceId: input.providerInstanceId,
            path: input.targetPath,
          },
          target: { environmentId: yield* environment.getEnvironmentId, path: input.targetPath },
          runId: run.id,
          nodeId: run.rootNodeId,
          human: { location: input.location },
          args: input.binding,
          expiresAt: input.expiresAt,
        })
        .pipe(
          Effect.mapError((error) =>
            error.reason === "limit_reached"
              ? invalid(error.message)
              : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
    },
  );

  const verify: ApprovalHandoffs["Service"]["verify"] = Effect.fn("ApprovalHandoffs.verify")(
    function* (input) {
      const handoff = yield* handoffs
        .read({ threadId: input.threadId, handoffId: TurnItemId.make(input.handoffId) })
        .pipe(Effect.mapError(() => invalid("That approval was not asked by this thread.")));
      if (
        handoff.target.path !== input.targetPath ||
        !(yield* handoffs.matchesArgs(handoff, input.binding))
      )
        return yield* invalid(
          "That approval does not cover this change. Call again without decisionId to request a new one.",
        );
      if (handoff.state === "pending" || handoff.state === "opened")
        return yield* invalid("That approval is still open; call again once a person answers it.");
      if (handoff.state !== "completed" || handoff.actor.type !== "client")
        return yield* invalid("That approval was not given.");
      const now = yield* DateTime.now;
      if (
        handoff.expiresAt !== null &&
        DateTime.toEpochMillis(handoff.expiresAt) <= DateTime.toEpochMillis(now)
      )
        return yield* invalid("That approval expired. Call again without decisionId to ask again.");
    },
  );

  return ApprovalHandoffs.of({ request, verify });
});

export const layer = Layer.effect(ApprovalHandoffs, make);
