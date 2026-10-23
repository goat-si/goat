/**
 * Who approves a hub membership change. A thread asks through an approval handoff, and the
 * handoff id is its decisionId; a person or an outside client without a thread asks through the
 * decision inbox. Either approval is bound to the action, alias and key, and is used once.
 *
 * @module HubConsent
 */
import {
  HUB_DEVICE_HANDOFF_PATHS,
  OrchestratorMcpFailure,
  type HandoffSummary,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import { consumeApproval } from "../handoffs/approvalConsumption.ts";

const DECISION_TTL_MS = 24 * 60 * 60 * 1000;
export type HubConsentAction = keyof typeof HUB_DEVICE_HANDOFF_PATHS;
interface ConsentCaller {
  readonly inbox: DecisionInbox.DecisionCaller;
}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The hub audit log is unavailable.",
  });
const askingThread = (caller: ConsentCaller) =>
  caller.inbox.kind === "agent" ? caller.inbox.scope.thread : undefined;
const isHandoffId = (id: string) => id.startsWith("handoff:");

export const makeHubConsent = Effect.gen(function* () {
  const inbox = yield* DecisionInbox.DecisionInbox;
  const approvals = yield* ApprovalHandoffs.ApprovalHandoffs;
  const sql = yield* SqlClient.SqlClient;

  const request = Effect.fn("HubConsent.request")(function* (
    caller: ConsentCaller,
    action: HubConsentAction,
    input: {
      readonly title: string;
      readonly context: string;
      readonly binding: string;
      readonly approve: string;
      readonly consequence: string;
    },
  ): Effect.fn.Return<
    { readonly decisionId: string; readonly handoff?: HandoffSummary },
    OrchestratorMcpFailure
  > {
    const expiresAt = DateTime.add(yield* DateTime.now, { milliseconds: DECISION_TTL_MS });
    const thread = askingThread(caller);
    if (thread !== undefined) {
      const handoff = yield* approvals.request({
        threadId: thread.threadId,
        providerInstanceId: thread.providerInstanceId,
        targetPath: HUB_DEVICE_HANDOFF_PATHS[action],
        title: input.title,
        reason: input.context,
        location: `${input.context}\n\nApproving: ${input.approve}. ${input.consequence}`,
        binding: { binding: input.binding },
        expiresAt,
      });
      return { decisionId: handoff.handoffId, handoff };
    }
    const item = yield* inbox.create(caller.inbox, {
      title: input.title,
      context: `${input.context}\n\n${input.binding}`,
      options: [
        { id: "approve", label: input.approve, consequence: input.consequence },
        { id: "decline", label: "Decline", consequence: "Nothing changes." },
      ],
      requiredProfile: "owner",
      expiresAt: DateTime.formatIso(expiresAt),
    });
    return { decisionId: item.id };
  });

  /** An inbox decision counts once, for its bound change, and only when a person answered it. */
  const decisionApproved = Effect.fn("HubConsent.decisionApproved")(function* (
    caller: ConsentCaller,
    decisionId: string,
    binding: string,
  ) {
    const item = yield* inbox.get(caller.inbox, decisionId);
    if (
      item.source !== "decision" ||
      item.requiredProfile !== "owner" ||
      !item.context.split("\n").includes(binding)
    )
      return yield* invalid(
        "That decision does not approve this change for this device and host key. Call again without decisionId to request a new one.",
      );
    if (item.status === "open")
      return yield* invalid("That decision is still open; call again once it is answered.");
    if (item.status !== "answered" || item.answer !== "approve")
      return yield* invalid("That decision was not approved.");
    const rows = yield* sql<{
      readonly answered_by: string | null;
      readonly used: number;
    }>`SELECT answered_by, (SELECT COUNT(*) FROM audit_events WHERE decision_id = ${decisionId}
      AND action LIKE 'hub.%' AND outcome = 'started') AS used
      FROM decision_items WHERE id = ${decisionId}`.pipe(Effect.mapError(storageFailure));
    // A person approves a membership change; an owner-profile agent's answer does not count.
    if (rows[0]?.answered_by?.startsWith("client:") !== true)
      return yield* invalid(
        "That decision was answered by an agent; a person approves hub changes.",
      );
    if (rows[0].used > 0) return yield* invalid("That decision was already used.");
  });

  /** Verifies and uses up the approval for this change; call it right before the change starts. */
  const approved = Effect.fn("HubConsent.approved")(function* (
    caller: ConsentCaller,
    action: HubConsentAction,
    decisionId: string,
    binding: string,
  ) {
    if (isHandoffId(decisionId)) {
      const thread = askingThread(caller);
      if (thread === undefined)
        return yield* invalid("That approval was not asked by this caller.");
      yield* approvals.verify({
        threadId: thread.threadId,
        handoffId: decisionId,
        targetPath: HUB_DEVICE_HANDOFF_PATHS[action],
        binding: { binding },
      });
    } else yield* decisionApproved(caller, decisionId, binding);
    yield* consumeApproval(decisionId, `hub.${action}`).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  /** Whether an approval is a person's answer to a device that could not be cleaned up. */
  const forced = (caller: ConsentCaller, decisionId: string, forceBinding: string) => {
    if (!isHandoffId(decisionId))
      return inbox
        .get(caller.inbox, decisionId)
        .pipe(Effect.map((item) => item.context.split("\n").includes(forceBinding)));
    const thread = askingThread(caller);
    return thread === undefined
      ? Effect.succeed(false)
      : approvals
          .verify({
            threadId: thread.threadId,
            handoffId: decisionId,
            targetPath: HUB_DEVICE_HANDOFF_PATHS.leave,
            binding: { binding: forceBinding },
          })
          .pipe(Effect.isSuccess);
  };

  return { request, approved, forced };
});
