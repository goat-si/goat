/**
 * A person's approval for one storage cleanup an agent asked for (docs/internals/agent-surface.md,
 * Human steps). A thread asks through a storage.clean approval handoff; another client gets a
 * decision GOAT files. Either binds a digest of this machine's environment and the exact item ids
 * and identity tokens, so other items, or the same items after they changed, need a new approval,
 * and it is used once.
 *
 * @module StorageConsent
 */
import {
  AuthEnvironmentMaintainScope,
  OrchestratorMcpFailure,
  STORAGE_CLEAN_HANDOFF_PATH,
  type HandoffSummary,
  type StorageCleanItem,
  type StorageItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DecisionInbox from "../goatclaw/DecisionInbox.ts";
import * as ApprovalHandoffs from "../handoffs/ApprovalHandoffs.ts";
import { consumeApproval } from "../handoffs/approvalConsumption.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { identityToken } from "./storagePaths.ts";

/** A person often answers after the asking turn ends; an hour keeps what they saw current. */
const HANDOFF_TTL_MINUTES = 60;
const DECISION_TTL_HOURS = 24;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The approval record is unavailable.",
  });

const formatGiB = (bytes: number | null) =>
  bytes === null ? "size unknown" : (bytes / 1024 ** 3).toFixed(2) + " GiB";

const storageCleanBinding = (environmentId: string, items: ReadonlyArray<StorageCleanItem>) =>
  "storage-clean:" +
  identityToken([
    1,
    environmentId,
    ...items.map((item) => item.id + "\u0000" + item.token).toSorted(),
  ]);

export class StorageConsent extends Context.Service<
  StorageConsent,
  {
    readonly ask: (
      scope: McpInvocationScope,
      requested: ReadonlyArray<StorageCleanItem>,
      items: ReadonlyArray<StorageItem>,
    ) => Effect.Effect<
      | { readonly kind: "handoff"; readonly handoff: HandoffSummary }
      | { readonly kind: "decision"; readonly decisionId: string },
      OrchestratorMcpFailure
    >;
    readonly admit: (
      scope: McpInvocationScope,
      approvalId: string,
      requested: ReadonlyArray<StorageCleanItem>,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/storage/StorageConsent") {}

/** What the person is shown: every path and size the approval covers. */
export const storageApprovalText = (items: ReadonlyArray<StorageItem>) => {
  const total = items.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  const lines = items.flatMap((item) => [
    "- " + item.kind.replaceAll("_", " ") + ": " + item.path + " (" + formatGiB(item.bytes) + ")",
    ...(item.files?.map((file) => "  - " + file.path + " (" + file.bytes + " bytes)") ?? []),
  ]);
  return {
    title:
      "Delete " + items.length + (items.length === 1 ? " item" : " items") + " of GOAT storage",
    reason: "An agent asks to free " + formatGiB(total) + " on this machine.",
    location: [
      "Deleting cannot be undone. Worktrees are checked again for changes and use right before they go.",
      "",
      ...lines,
    ].join("\n"),
  };
};

export const makeStorageConsent = Effect.gen(function* () {
  const approvals = yield* ApprovalHandoffs.ApprovalHandoffs;
  const inbox = yield* DecisionInbox.DecisionInbox;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore.SessionStore;

  const bindingOf = (items: ReadonlyArray<StorageCleanItem>) =>
    environment.getEnvironmentId.pipe(Effect.map((id) => storageCleanBinding(id, items)));

  /** Asks a person: a handoff for a thread, otherwise a decision bound to these items. */
  const ask = Effect.fn("StorageConsent.ask")(function* (
    scope: McpInvocationScope,
    requested: ReadonlyArray<StorageCleanItem>,
    items: ReadonlyArray<StorageItem>,
  ): Effect.fn.Return<
    | { readonly kind: "handoff"; readonly handoff: HandoffSummary }
    | { readonly kind: "decision"; readonly decisionId: string },
    OrchestratorMcpFailure
  > {
    const binding = yield* bindingOf(requested);
    const text = storageApprovalText(items);
    const now = yield* DateTime.now;
    if (scope.thread !== undefined)
      return {
        kind: "handoff",
        handoff: yield* approvals.request({
          threadId: scope.thread.threadId,
          providerInstanceId: scope.thread.providerInstanceId,
          targetPath: STORAGE_CLEAN_HANDOFF_PATH,
          title: text.title,
          reason: text.reason,
          location: text.location,
          binding: { items: binding },
          expiresAt: DateTime.add(now, { minutes: HANDOFF_TTL_MINUTES }),
        }),
      };
    const item = yield* inbox.create(
      { kind: "agent", scope },
      {
        title: text.title,
        context: text.reason + "\n\n" + text.location,
        options: [
          {
            id: "approve",
            label: "Delete these items",
            consequence: "GOAT deletes them on this machine; this cannot be undone.",
          },
          { id: "decline", label: "Decline", consequence: "Nothing is deleted." },
        ],
        requiredProfile: "owner",
        expiresAt: DateTime.formatIso(DateTime.add(now, { hours: DECISION_TTL_HOURS })),
      },
    );
    // An agent can file a decision with any text, so what it approves is kept here.
    yield* sql`INSERT INTO approval_bindings (approval_id, binding, created_at)
      VALUES (${item.id}, ${binding}, ${DateTime.formatIso(now)})`.pipe(
      Effect.mapError(storageFailure),
    );
    return { kind: "decision", decisionId: item.id };
  });

  /** Verifies and uses up a person's approval for exactly these items. */
  const admit = Effect.fn("StorageConsent.admit")(function* (
    scope: McpInvocationScope,
    approvalId: string,
    requested: ReadonlyArray<StorageCleanItem>,
  ) {
    const binding = yield* bindingOf(requested);
    if (scope.thread !== undefined) {
      yield* approvals.verify({
        threadId: scope.thread.threadId,
        handoffId: approvalId,
        targetPath: STORAGE_CLEAN_HANDOFF_PATH,
        binding: { items: binding },
      });
    } else {
      const item = yield* inbox
        .get({ kind: "agent", scope }, approvalId)
        .pipe(
          Effect.mapError(() =>
            invalid("That decision was not found. Call again without approvalId to ask for one."),
          ),
        );
      if (item.source !== "decision" || item.requiredProfile !== "owner")
        return yield* invalid("That decision does not approve a storage cleanup.");
      if (item.status === "open")
        return yield* invalid("That decision is still open; call again once it is answered.");
      if (item.status !== "answered" || item.answer !== "approve")
        return yield* invalid("That decision was not approved.");
      const rows = yield* sql<{
        readonly answered_by: string | null;
        readonly binding: string | null;
      }>`
        SELECT answered_by, (SELECT binding FROM approval_bindings WHERE approval_id = ${approvalId}) AS binding
        FROM decision_items WHERE id = ${approvalId}`.pipe(Effect.mapError(storageFailure));
      if (rows[0]?.binding !== binding)
        return yield* invalid(
          "That decision does not cover these items as they are now. Call again without approvalId to ask for a new one.",
        );
      // Only a person's answer approves a deletion; an owner-profile agent's does not.
      const answeredBy = rows[0]?.answered_by ?? "";
      if (!answeredBy.startsWith("client:"))
        return yield* invalid(
          "That decision was answered by an agent; a person approves deletions.",
        );
      // Approving is the deletion itself, so it takes what deleting from Settings takes.
      const responder = (yield* sessions.listActive().pipe(Effect.mapError(storageFailure))).find(
        (session) => "client:" + session.sessionId === answeredBy,
      );
      if (responder === undefined || !responder.scopes.includes(AuthEnvironmentMaintainScope))
        return yield* invalid(
          "Whoever approved that decision may not delete GOAT storage on this machine (it takes environment:maintain), or is no longer signed in. Call again without approvalId to ask for a new one.",
        );
    }
    yield* consumeApproval(approvalId, "storage.clean").pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
  });

  return StorageConsent.of({ ask, admit });
});

export const layer = Layer.effect(StorageConsent, makeStorageConsent).pipe(
  Layer.provide(ApprovalHandoffs.layer),
);
