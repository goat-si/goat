/**
 * Consent for one cloud agent launch, which bills a provider account (docs/internals/agent-surface.md,
 * Human steps). A thread asks through a cloud_agent.launch approval handoff; a caller without a
 * thread gets a decision GOAT files for exactly this launch. Either approval binds a digest of the
 * launch's arguments and holder, so a different launch needs a new approval, and is used once.
 *
 * @module CloudLaunchConsent
 */
import {
  CLOUD_AGENT_LAUNCH_HANDOFF_PATH,
  OrchestratorMcpFailure,
  type HandoffSummary,
  type PermissionProfileView,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- A digest of the launch binds its approval.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import { consumeApproval } from "../handoffs/approvalConsumption.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** A person usually answers after the asking turn ends; an hour keeps the launch's context fresh. */
const HANDOFF_TTL_MINUTES = 60;
const DECISION_TTL_HOURS = 24;

/** Everything the approval covers: change any of it and the approval no longer applies. */
export interface CloudLaunchBinding {
  readonly provider: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly prompt: string;
  readonly title: string | null;
  readonly notifyWebhook: boolean | null;
  readonly holder: { readonly host: string | null; readonly instanceId: string };
  readonly threadId: string | null;
}

const digestOf = (binding: CloudLaunchBinding) =>
  NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        1,
        binding.provider,
        binding.repo,
        binding.branch,
        binding.prompt,
        binding.title,
        binding.notifyWebhook,
        binding.holder.host,
        binding.holder.instanceId,
        binding.threadId,
      ]),
    )
    .digest("hex");

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const refusal = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The approval record is unavailable.",
  });

export const makeCloudLaunchConsent = Effect.gen(function* () {
  const approvals = yield* ApprovalHandoffs.ApprovalHandoffs;
  const permissions = yield* Profiles.PermissionProfiles;
  const inbox = yield* DecisionInbox.DecisionInbox;
  const sql = yield* SqlClient.SqlClient;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const consume = (approvalId: string) =>
    consumeApproval(approvalId, "cloud.launch").pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );

  /**
   * The branch a launch without one starts from: the one checked out in the project folder now.
   * The approval binds it and the launch passes it explicitly, so switching the checkout after a
   * person approved does not move the launch to a branch they never saw.
   */
  const checkedOutBranch = Effect.fn("CloudLaunchConsent.checkedOutBranch")(function* (
    workspaceRoot: string,
  ) {
    const status = yield* git
      .statusDetailsLocal(workspaceRoot, { includeDivergence: false })
      .pipe(
        Effect.mapError(() => invalid("Could not read the project folder's checked-out branch.")),
      );
    if (!status.isRepo || status.branch === null)
      return yield* invalid(
        "The project folder has no branch checked out. Pass branch to say which one to launch from.",
      );
    return status.branch;
  });

  /** Asks a person: a handoff from a thread, otherwise a decision bound to this launch. */
  const ask = Effect.fn("CloudLaunchConsent.ask")(function* (
    scope: McpInvocationScope,
    digest: string,
    request: { readonly title: string; readonly reason: string; readonly location: string },
  ): Effect.fn.Return<HandoffSummary, OrchestratorMcpFailure> {
    const now = yield* DateTime.now;
    if (scope.thread !== undefined)
      return yield* approvals.request({
        threadId: scope.thread.threadId,
        providerInstanceId: scope.thread.providerInstanceId,
        targetPath: CLOUD_AGENT_LAUNCH_HANDOFF_PATH,
        title: request.title,
        reason: request.reason,
        location: request.location,
        binding: { launch: digest },
        expiresAt: DateTime.add(now, { minutes: HANDOFF_TTL_MINUTES }),
      });
    const item = yield* inbox.create(
      { kind: "agent", scope },
      {
        title: request.title,
        context: request.location,
        options: [
          { id: "approve", label: "Allow this launch", consequence: request.reason },
          { id: "decline", label: "Decline", consequence: "Nothing starts." },
        ],
        requiredProfile: "owner",
        expiresAt: DateTime.formatIso(DateTime.add(now, { hours: DECISION_TTL_HOURS })),
      },
    );
    yield* sql`INSERT INTO approval_bindings (approval_id, binding, created_at)
      VALUES (${item.id}, ${digest}, ${DateTime.formatIso(now)})`.pipe(
      Effect.mapError(storageFailure),
    );
    return yield* refusal(
      `A cloud launch bills a paid account, and a person must allow this one. GOAT filed decision ${item.id} for exactly this launch; once a person approves it, call again with the same arguments and decisionId ${item.id}.`,
    );
  });

  /** Admitted, or the handoff a person must answer first. Fails when no approval can apply. */
  const admit = Effect.fn("CloudLaunchConsent.admit")(function* (
    scope: McpInvocationScope,
    effective: PermissionProfileView,
    input: {
      readonly decisionId: string | undefined;
      readonly handoffId: string | undefined;
      readonly target: string;
      readonly binding: CloudLaunchBinding;
      readonly request: {
        readonly title: string;
        readonly reason: string;
        readonly location: string;
      };
    },
  ): Effect.fn.Return<
    { readonly admitted: true } | { readonly admitted: false; readonly handoff: HandoffSummary },
    OrchestratorMcpFailure
  > {
    if (!effective.enabled) return { admitted: true };
    const digest = digestOf(input.binding);
    if (input.handoffId !== undefined) {
      if (scope.thread === undefined)
        return yield* invalid(
          "handoffId works only from the thread that asked; outside a thread pass decisionId.",
        );
      yield* approvals.verify({
        threadId: scope.thread.threadId,
        handoffId: input.handoffId,
        targetPath: CLOUD_AGENT_LAUNCH_HANDOFF_PATH,
        binding: { launch: digest },
      });
      yield* consume(input.handoffId);
      const time = DateTime.formatIso(yield* DateTime.now);
      yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${time}, ${`thread:${scope.thread.threadId}`}, ${effective.profile.id}, 'cloud.launch',
        ${input.target}, 'handoff', ${input.handoffId})`.pipe(Effect.mapError(storageFailure));
      return { admitted: true };
    }
    // An inbox decision does not bind a launch; from a thread, ask for a handoff that does.
    if (input.decisionId !== undefined && scope.thread === undefined) {
      const bound = yield* sql<{ readonly binding: string }>`
        SELECT binding FROM approval_bindings WHERE approval_id = ${input.decisionId}`.pipe(
        Effect.mapError(storageFailure),
      );
      if (bound[0]?.binding !== digest)
        return yield* refusal(
          `Decision ${input.decisionId} was not filed by GOAT for this launch. Call again without decisionId to ask for one.`,
        );
      yield* permissions.requireCloudApproval(scope, effective, {
        decisionId: input.decisionId,
        target: input.target,
      });
      yield* consume(input.decisionId);
      return { admitted: true };
    }
    // A person started this run: the existing rule admits it and records why.
    const started = yield* permissions
      .requireCloudApproval(scope, effective, { target: input.target })
      .pipe(Effect.result);
    if (started._tag === "Success") return { admitted: true };
    if (started.failure.code !== "capability_denied") return yield* started.failure;
    return { admitted: false, handoff: yield* ask(scope, digest, input.request) };
  });

  return { admit, checkedOutBranch };
});
