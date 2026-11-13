/**
 * Who approves a hub membership change: a thread through a handoff whose id is its decisionId,
 * others through the decision inbox, bound to the action, alias and key until used or expired.
 * Join, leave and move spend it on success; a route change on any outcome after ocx starts except
 * a fixed refusal, since the Home may have the edit.
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
import { approvalUsed, markApprovalUsed } from "../handoffs/approvalConsumption.ts";

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
    // Only decisions the server asked for approve a hub change: an agent can file a decision with
    // any context, so the binding is kept here, where no tool input reaches.
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO approval_bindings (approval_id, binding, created_at)
      VALUES (${item.id}, ${input.binding}, ${createdAt})`.pipe(Effect.mapError(storageFailure));
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
    // The inbox expires only open decisions; an answered one lapses here, like a handoff.
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (
      item.expiresAt !== null &&
      DateTime.toEpochMillis(DateTime.makeUnsafe(item.expiresAt)) <= now
    )
      return yield* invalid("That decision expired. Call again without decisionId to ask again.");
    const rows = yield* sql<{
      readonly answered_by: string | null;
      readonly binding: string | null;
    }>`SELECT answered_by,
      (SELECT binding FROM approval_bindings WHERE approval_id = ${decisionId}) AS binding
      FROM decision_items WHERE id = ${decisionId}`.pipe(Effect.mapError(storageFailure));
    if (rows[0]?.binding !== binding)
      return yield* invalid(
        "That decision was not asked by GOAT for this change. Call again without decisionId to request one.",
      );
    // A person approves a membership change; an owner-profile agent's answer does not count.
    if (rows[0]?.answered_by?.startsWith("client:") !== true)
      return yield* invalid(
        "That decision was answered by an agent; a person approves hub changes.",
      );
    if (yield* approvalUsed(decisionId).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
      return yield* invalid("That decision was already used.");
  });

  /**
   * Verifies the approval for this change without spending it; call it right before the change
   * starts, under the membership permit, and call `used` once the change has happened (for a
   * route change, once it may have).
   */
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
  });

  /** The approved change happened: the approval covers nothing more. */
  const used = Effect.fn("HubConsent.used")(function* (
    caller: ConsentCaller,
    action: HubConsentAction,
    decisionId: string | undefined,
  ) {
    if (decisionId === undefined) return;
    const thread = askingThread(caller);
    if (isHandoffId(decisionId) && thread !== undefined)
      return yield* approvals.markUsed({
        threadId: thread.threadId,
        handoffId: decisionId,
        action: `hub.${action}`,
      });
    yield* markApprovalUsed(decisionId, `hub.${action}`).pipe(
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

  return { request, approved, used, forced };
});
