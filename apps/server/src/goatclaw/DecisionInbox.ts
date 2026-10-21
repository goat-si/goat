import {
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  CommandId,
  DecisionItem,
  DecisionOption,
  DecisionRequestInput,
  EnvironmentId,
  MessageId,
  OrchestrationV2UserInputQuestion,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderRequestKind,
  RuntimeRequestId,
  ThreadId,
  type AuthEnvironmentScope,
  type DecisionAnswerInput,
  type DecisionListInput,
  type RuntimeMode,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  exceededDispatchModeLimit,
  type DispatchModes,
} from "../orchestration-v2/DispatchModeLimit.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Settings from "../serverSettings.ts";
import * as Profiles from "./PermissionProfiles.ts";

/** Client identity is constructed by the authenticated RPC boundary, never decoded from input. */
export type DecisionCaller =
  | { readonly kind: "agent"; readonly scope: McpInvocationScope }
  | {
      readonly kind: "client";
      readonly environmentId: EnvironmentId;
      readonly sessionId: string;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    };

export class DecisionInbox extends Context.Service<
  DecisionInbox,
  {
    readonly create: (
      caller: DecisionCaller,
      input: DecisionRequestInput,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly list: (
      caller: DecisionCaller,
      input: DecisionListInput,
    ) => Effect.Effect<{ readonly items: ReadonlyArray<DecisionItem> }, OrchestratorMcpFailure>;
    readonly get: (
      caller: DecisionCaller,
      id: string,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly answer: (
      caller: DecisionCaller,
      input: DecisionAnswerInput,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly withdraw: (
      caller: DecisionCaller,
      id: string,
    ) => Effect.Effect<DecisionItem, OrchestratorMcpFailure>;
    readonly runDueWork: Effect.Effect<void, OrchestratorMcpFailure>;
  }
>()("goat/goatclaw/DecisionInbox") {}

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Decision inbox storage is unavailable.",
  });
const scopeOf = (caller: DecisionCaller): McpInvocationScope =>
  caller.kind === "agent"
    ? caller.scope
    : {
        environmentId: caller.environmentId,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: `decision-client:${caller.sessionId}`,
        thread: undefined,
        client: {
          sessionId: caller.sessionId,
          label: "Decision inbox",
          access: "full-access",
          approvals: true,
        },
        grantedScopes: caller.scopes,
      };
const actorOf = (caller: DecisionCaller) =>
  caller.kind === "client"
    ? `client:${caller.sessionId}`
    : caller.scope.thread === undefined
      ? `mcp:${caller.scope.client?.sessionId ?? caller.scope.requestNamespace}`
      : `thread:${caller.scope.thread.threadId}`;
const isOwner = (caller: DecisionCaller) =>
  caller.kind === "client" && caller.scopes.includes(AuthSettingsWriteScope);
const writeAccess = (caller: DecisionCaller) =>
  caller.kind === "client"
    ? caller.scopes.includes(AuthOrchestrationOperateScope)
      ? Effect.void
      : Effect.fail(denied("Answering decisions requires orchestration:operate."))
    : caller.scope.readOnly === true || caller.scope.client?.access === "read-only"
      ? Effect.fail(denied("This credential is read-only."))
      : Effect.void;
const isApprovalKind = Schema.is(ProviderRequestKind);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const decodeRequest = Schema.decodeEffect(DecisionRequestInput);
const encodeOptions = Schema.encodeSync(Schema.fromJsonString(Schema.Array(DecisionOption)));
const decodeOptions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(DecisionOption)),
);
const decodeQuestion = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      questions: Schema.optionalKey(Schema.Array(OrchestrationV2UserInputQuestion)),
      prompt: Schema.optionalKey(Schema.String),
    }),
  ),
);
interface DecisionRow {
  id: string;
  from_thread_id: string | null;
  from_host: string | null;
  title: string;
  context: string;
  options_json: string;
  recommended: string | null;
  required_profile: string;
  expires_at: string | null;
  status: DecisionItem["status"];
  answer: string | null;
  answered_by: string | null;
  created_at: string;
  updated_at: string;
}
interface PendingRow {
  thread_id: string;
  runtime_request_id: string;
  kind: string;
  status: string;
  created_at: string;
  resolved_at: string | null;
  item_json: string | null;
  title: string;
  runtime_mode: RuntimeMode;
  interaction_mode: "plan" | "default";
}
const pendingId = (threadId: string, requestId: string) =>
  `pending:${encodeURIComponent(threadId)}:${encodeURIComponent(requestId)}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const profiles = yield* Profiles.PermissionProfiles;
  const settings = yield* Settings.ServerSettingsService;
  const pending = yield* PendingQuestions.PendingQuestionsMcpService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const deliveryPermit = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const audit = Effect.fn("DecisionInbox.audit")(function* (
    time: string,
    actor: string,
    profile: string,
    action: string,
    id: string,
    outcome: string,
  ) {
    yield* sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
      VALUES (${time}, ${actor}, ${profile}, ${action}, ${id}, ${outcome}, ${id})`;
  }, Effect.mapError(storageFailure));
  const toItem = Effect.fn("DecisionInbox.decode")(function* (row: DecisionRow) {
    return {
      id: row.id,
      source: "decision",
      from: {
        ...(row.from_thread_id === null ? {} : { threadId: ThreadId.make(row.from_thread_id) }),
        ...(row.from_host === null ? {} : { host: row.from_host }),
      },
      title: row.title,
      context: row.context,
      options: yield* decodeOptions(row.options_json).pipe(Effect.mapError(storageFailure)),
      recommended: row.recommended,
      requiredProfile: row.required_profile,
      expiresAt: row.expires_at,
      status: row.status,
      answer: row.answer,
      answeredBy: row.answered_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      humanRequired: false,
    } satisfies DecisionItem;
  });
  const expire = Effect.fn("DecisionInbox.expire")(function* () {
    const time = yield* now;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const expired = yield* sql<{
          id: string;
        }>`UPDATE decision_items SET status = 'expired', updated_at = ${time}
        WHERE status = 'open' AND expires_at <= ${time} RETURNING id`;
        for (const row of expired)
          yield* audit(time, "scheduler", "system", "decision.expire", row.id, "expired");
      }),
    );
  }, Effect.mapError(storageFailure));
  const durable = Effect.fn("DecisionInbox.durable")(function* (id: string) {
    const row = (yield* sql<DecisionRow>`SELECT * FROM decision_items WHERE id = ${id}`.pipe(
      Effect.mapError(storageFailure),
    ))[0];
    return row === undefined ? undefined : yield* toItem(row);
  });
  const answererLabel = Effect.fn("DecisionInbox.answererLabel")(function* (
    actor: string,
    viewerSessionId?: string,
  ) {
    if (viewerSessionId !== undefined && actor === `client:${viewerSessionId}`) return "You";
    if (actor.startsWith("client:") || actor.startsWith("mcp:")) {
      const sessionId = actor.slice(actor.indexOf(":") + 1);
      const row = (yield* sql<{
        client_label: string | null;
      }>`SELECT client_label FROM auth_sessions WHERE session_id = ${sessionId}`.pipe(
        Effect.mapError(storageFailure),
      ))[0];
      return (
        row?.client_label?.trim() || (actor.startsWith("client:") ? "a paired client" : "an agent")
      );
    }
    if (actor.startsWith("thread:")) {
      const row = (yield* sql<{
        title: string;
      }>`SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = ${actor.slice(7)}`.pipe(
        Effect.mapError(storageFailure),
      ))[0];
      return row?.title.trim() || "an agent";
    }
    return "an agent";
  });
  const presentItems = Effect.fn("DecisionInbox.presentItems")(function* (
    caller: DecisionCaller,
    items: ReadonlyArray<DecisionItem>,
  ) {
    if (caller.kind === "agent") return items;
    // History commonly repeats one responder; resolve each identity only once per response.
    const labels = new Map<string, string>();
    for (const actor of new Set(
      items.flatMap((item) => (item.answeredBy === null ? [] : [item.answeredBy])),
    )) {
      labels.set(actor, yield* answererLabel(actor, caller.sessionId));
    }
    return items.map((item) => ({
      ...item,
      answeredBy: item.answeredBy === null ? null : labels.get(item.answeredBy)!,
    }));
  });
  const presentItem = Effect.fn("DecisionInbox.presentItem")(function* (
    caller: DecisionCaller,
    item: DecisionItem,
  ) {
    return (yield* presentItems(caller, [item]))[0]!;
  });
  const callerLimits = Effect.fn("DecisionInbox.callerLimits")(function* (caller: DecisionCaller) {
    if (caller.kind === "client") return undefined;
    const scope = scopeOf(caller);
    const effective = yield* profiles.resolve(scope);
    const callerThread =
      scope.thread === undefined
        ? undefined
        : (yield* sql<{
            interaction_mode: "plan" | "default";
          }>`SELECT interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${scope.thread.threadId}`.pipe(
            Effect.mapError(storageFailure),
          ))[0];
    return {
      runtimeMode: effective.runtimeMode,
      interactionMode: callerThread?.interaction_mode ?? "default",
    };
  });
  const project = Effect.fn("DecisionInbox.projectPending")(function* (
    row: PendingRow,
    limits: DispatchModes | undefined,
  ) {
    const data =
      row.item_json === null
        ? {}
        : yield* decodeQuestion(row.item_json).pipe(Effect.mapError(storageFailure));
    const questions = data.questions ?? [];
    const approval = isApprovalKind(row.kind)
      ? { kind: row.kind, ...(data.prompt === undefined ? {} : { prompt: data.prompt }) }
      : undefined;
    const humanRequired =
      approval !== undefined ||
      (limits !== undefined &&
        exceededDispatchModeLimit(limits, {
          runtimeMode: row.runtime_mode,
          interactionMode: row.interaction_mode,
        }) !== undefined);
    return {
      id: pendingId(row.thread_id, row.runtime_request_id),
      source: "pending_request",
      from: { threadId: ThreadId.make(row.thread_id) },
      title: questions[0]?.header ?? row.title,
      context:
        questions.map((question) => question.question).join("\n\n") ||
        data.prompt ||
        "Provider approval",
      options:
        questions.length === 1
          ? questions[0]!.options.map((option) => ({
              id: option.value ?? option.label,
              label: option.label,
              consequence: option.description,
            }))
          : [],
      recommended: null,
      requiredProfile: humanRequired ? "owner" : "worker",
      expiresAt: null,
      status:
        row.status === "pending"
          ? "open"
          : row.status === "resolved"
            ? "answered"
            : row.status === "expired"
              ? "expired"
              : "withdrawn",
      answer: null,
      answeredBy: null,
      createdAt: row.created_at,
      updatedAt: row.resolved_at ?? row.created_at,
      humanRequired,
      pending: {
        threadId: ThreadId.make(row.thread_id),
        requestId: RuntimeRequestId.make(row.runtime_request_id),
        questions,
        ...(approval === undefined ? {} : { approval }),
      },
    } satisfies DecisionItem;
  });
  const pendingRows = Effect.fn("DecisionInbox.pendingRows")(function* (id?: string, limit = 100) {
    const target =
      id === undefined
        ? undefined
        : yield* Effect.try({
            try: () => {
              const parts = id.split(":");
              if (parts.length !== 3 || parts[0] !== "pending")
                throw new Error("Invalid pending id");
              return {
                threadId: decodeURIComponent(parts[1]!),
                requestId: decodeURIComponent(parts[2]!),
              };
            },
            catch: () => invalid("The decision was not found."),
          });
    // Match the existing request index instead of hydrating every thread transcript.
    return yield* sql<PendingRow>`SELECT r.thread_id, r.runtime_request_id, r.kind, r.status, r.created_at, r.resolved_at,
      t.title, t.runtime_mode, t.interaction_mode,
      (SELECT i.payload_json FROM orchestration_v2_projection_turn_items i
       WHERE i.thread_id = r.thread_id AND i.type IN ('user_input_request', 'approval_request')
       AND json_extract(i.payload_json, '$.requestId') = r.runtime_request_id ORDER BY i.ordinal DESC LIMIT 1) AS item_json
      FROM orchestration_v2_projection_runtime_requests r
      JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id AND t.deleted_at IS NULL
      WHERE (r.kind = 'user_input' OR r.kind IN ('command', 'file-read', 'file-change', 'mcp-elicitation', 'permission'))
        AND ((${target === undefined ? 1 : 0} = 1 AND r.status = 'pending') OR (r.thread_id = ${target?.threadId ?? null} AND r.runtime_request_id = ${target?.requestId ?? null}))
      ORDER BY r.created_at DESC, r.runtime_request_id LIMIT ${limit}`.pipe(
      Effect.mapError(storageFailure),
    );
  });
  const get = Effect.fn("DecisionInbox.get")(function* (caller: DecisionCaller, id: string) {
    yield* expire();
    const item = yield* durable(id);
    if (item !== undefined) return yield* presentItem(caller, item);
    const row = (yield* pendingRows(id, 200)).find(
      (row) => pendingId(row.thread_id, row.runtime_request_id) === id,
    );
    if (row === undefined) return yield* invalid("The decision was not found.");
    return yield* project(row, yield* callerLimits(caller));
  });
  const requireProfile = Effect.fn("DecisionInbox.requireProfile")(function* (
    caller: DecisionCaller,
    requiredProfile: string,
  ) {
    const effective = yield* profiles.resolve(scopeOf(caller));
    if (isOwner(caller)) return "owner";
    const required = (yield* settings.getSettings.pipe(Effect.mapError(storageFailure))).goatclaw
      .profiles[requiredProfile];
    if (required === undefined)
      return yield* denied("The decision's required permission profile is unavailable.");
    const held = effective.profile;
    const modes = ["approval-required", "auto-accept-edits", "auto", "full-access"];
    if (
      !required.capabilities.every((capability) => held.capabilities.includes(capability)) ||
      modes.indexOf(held.runtimeModeCeiling) < modes.indexOf(required.runtimeModeCeiling) ||
      held.maxLanes < required.maxLanes ||
      (held.hosts !== undefined &&
        (required.hosts === undefined ||
          !required.hosts.every((host) => held.hosts!.includes(host)))) ||
      (held.maxTurns !== undefined &&
        (required.maxTurns === undefined || held.maxTurns < required.maxTurns)) ||
      (held.maxWallClockMs !== undefined &&
        (required.maxWallClockMs === undefined || held.maxWallClockMs < required.maxWallClockMs))
    )
      return yield* denied(`This decision requires permission profile ${requiredProfile}.`);
    return effective.profile.id;
  });
  const deliver = Effect.fn("DecisionInbox.deliver")(function* () {
    const rows = yield* sql<
      DecisionRow & { project_id: string }
    >`SELECT d.*, t.project_id FROM decision_answer_deliveries q
      JOIN decision_items d ON d.id = q.decision_id
      JOIN orchestration_v2_projection_threads t ON t.thread_id = d.from_thread_id AND t.deleted_at IS NULL
      WHERE q.delivered_at IS NULL
      ORDER BY q.last_attempted_at, q.decision_id LIMIT 100`.pipe(Effect.mapError(storageFailure));
    for (const row of rows) {
      yield* Effect.gen(function* () {
        // Unattempted and older work stays ahead of a batch of failing destinations.
        yield* sql`UPDATE decision_answer_deliveries SET last_attempted_at = ${yield* now} WHERE decision_id = ${row.id}`.pipe(
          Effect.mapError(storageFailure),
        );
        const item = yield* toItem(row);
        const option = item.options.find((option) => option.id === item.answer);
        yield* threads
          .sendToThread({
            projectId: ProjectId.make(row.project_id),
            threadId: ThreadId.make(row.from_thread_id!),
            commandId: CommandId.make(`decision-answer:${row.id}`),
            messageId: MessageId.make(`decision-answer:${row.id}`),
            text: `Decision answered: ${item.title}\nDecision id: ${item.id}\nAnswer: ${option?.label ?? item.answer}\nAnswered by: ${yield* answererLabel(item.answeredBy!)}`,
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError(
              () =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: "Decision answer delivery is pending; it will be retried.",
                }),
            ),
          );
        yield* sql`UPDATE decision_answer_deliveries SET delivered_at = ${yield* now} WHERE decision_id = ${row.id}`.pipe(
          Effect.mapError(storageFailure),
        );
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Decision answer delivery queued for retry", { decisionId: row.id }),
        ),
      );
    }
  }, deliveryPermit.withPermits(1));
  const reconcileAudits = Effect.fn("DecisionInbox.reconcileAudits")(function* () {
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          command_id: string;
          decision_id: string;
          actor: string;
          profile: string;
          accepted_at: string;
          status: string;
        }>`
        SELECT i.*, r.accepted_at, r.status FROM decision_pending_answer_audits i
        JOIN orchestration_command_receipts r ON r.command_id = i.command_id
        WHERE i.reconciled = 0`;
        for (const row of rows) {
          yield* audit(
            row.accepted_at,
            row.actor,
            row.profile,
            "decision.answer",
            row.decision_id,
            row.status === "accepted" ? "answered" : "rejected",
          );
          yield* sql`UPDATE decision_pending_answer_audits SET reconciled = 1 WHERE command_id = ${row.command_id}`;
        }
      }),
    );
  }, Effect.mapError(storageFailure));
  const runDueWork = expire().pipe(Effect.andThen(reconcileAudits()), Effect.andThen(deliver()));
  return DecisionInbox.of({
    get,
    runDueWork,
    list: Effect.fn("DecisionInbox.list")(function* (caller, input) {
      yield* expire();
      const limit = input.limit ?? 100;
      const rows = yield* sql<DecisionRow>`SELECT * FROM decision_items
        WHERE (${input.status ?? null} IS NULL OR status = ${input.status ?? null})
        ORDER BY created_at DESC, id LIMIT ${limit}`.pipe(Effect.mapError(storageFailure));
      const items: DecisionItem[] = yield* Effect.forEach(rows, toItem);
      if (input.status === undefined || input.status === "open") {
        const limits = yield* callerLimits(caller);
        for (const row of yield* pendingRows(undefined, limit))
          items.push(yield* project(row, limits));
      }
      return {
        items: yield* presentItems(
          caller,
          items
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
            .slice(0, limit),
        ),
      };
    }),
    create: Effect.fn("DecisionInbox.create")(function* (caller, rawInput) {
      yield* writeAccess(caller);
      const input = yield* decodeRequest(rawInput).pipe(
        Effect.mapError(() => invalid("Invalid decision request.")),
      );
      const effective = yield* profiles.resolve(scopeOf(caller));
      if (!isOwner(caller) && !effective.profile.capabilities.includes("threads.launch"))
        return yield* denied("This profile cannot request decisions.");
      const policy = (yield* settings.getSettings.pipe(Effect.mapError(storageFailure))).goatclaw;
      if (policy.profiles[input.requiredProfile] === undefined)
        return yield* invalid("requiredProfile must name a stored permission profile.");
      if (
        new Set(input.options.map((option) => option.id)).size !== input.options.length ||
        (input.recommended !== undefined &&
          !input.options.some((option) => option.id === input.recommended))
      )
        return yield* invalid("Option ids must be unique and recommended must name an option.");
      const time = yield* now;
      const expiresAt =
        input.expiresAt === undefined
          ? null
          : DateTime.formatIso(DateTime.makeUnsafe(input.expiresAt));
      if (expiresAt !== null && expiresAt <= time)
        return yield* invalid("expiresAt must be in the future.");
      const id = `decision:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`;
      const sourceThreadId = scopeOf(caller).thread?.threadId ?? null;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO decision_items (id, from_thread_id, title, context, options_json, recommended, required_profile, expires_at, status, created_at, updated_at)
          VALUES (${id}, ${sourceThreadId}, ${input.title}, ${input.context}, ${encodeOptions(input.options)}, ${input.recommended ?? null}, ${input.requiredProfile}, ${expiresAt}, 'open', ${time}, ${time})`;
            yield* audit(
              time,
              actorOf(caller),
              isOwner(caller) ? "owner" : effective.profile.id,
              "decision.request",
              id,
              "open",
            );
          }),
        )
        .pipe(Effect.mapError(storageFailure));
      return yield* presentItem(caller, (yield* durable(id))!);
    }),
    answer: Effect.fn("DecisionInbox.answer")(function* (caller, input) {
      yield* writeAccess(caller);
      const item = yield* get(caller, input.id);
      if (item.status !== "open") return yield* invalid("This decision is no longer open.");
      if (item.humanRequired && caller.kind !== "client")
        return yield* denied("This item requires a person in a client; forward it to the user.");
      const profile = yield* requireProfile(caller, item.requiredProfile);
      if ("pending" in item && item.pending !== undefined) {
        if (input.optionId !== undefined)
          return yield* invalid("Answer projected questions with answers or decision.");
        const commandId = CommandId.make(
          `decision-response:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        );
        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO decision_pending_answer_audits (command_id, decision_id, actor, profile)
            VALUES (${commandId}, ${item.id}, ${actorOf(caller)}, ${profile})`;
              yield* audit(
                yield* now,
                actorOf(caller),
                profile,
                "decision.answer",
                item.id,
                "requested",
              );
            }),
          )
          .pipe(Effect.mapError(storageFailure));
        const scope = scopeOf(caller);
        const effective = yield* profiles.resolve(scope);
        const callerThread =
          scope.thread === undefined
            ? undefined
            : (yield* sql<{
                interaction_mode: "plan" | "default";
              }>`SELECT interaction_mode FROM orchestration_v2_projection_threads WHERE thread_id = ${scope.thread.threadId}`.pipe(
                Effect.mapError(storageFailure),
              ))[0];
        yield* pending
          .respond(
            scope,
            {
              threadId: item.pending.threadId,
              requestId: item.pending.requestId,
              reason: input.reason,
              ...(input.answers === undefined ? {} : { answers: input.answers }),
              ...(input.decision === undefined ? {} : { decision: input.decision }),
            },
            commandId,
          )
          .pipe(
            Effect.provideService(
              DispatchModeLimit,
              caller.kind === "client"
                ? undefined
                : {
                    runtimeMode: effective.runtimeMode,
                    interactionMode: callerThread?.interaction_mode ?? "default",
                  },
            ),
          );
        yield* reconcileAudits();
        return yield* presentItem(caller, {
          ...item,
          status: "answered",
          answer: null,
          answeredBy: actorOf(caller),
          updatedAt: yield* now,
        });
      }
      if (
        input.answers !== undefined ||
        input.decision !== undefined ||
        !item.options.some((option) => option.id === input.optionId)
      )
        return yield* invalid("Choose one of this decision's option ids.");
      const time = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql<{
              id: string;
            }>`UPDATE decision_items SET status = 'answered', answer = ${input.optionId!}, answered_by = ${actorOf(caller)}, updated_at = ${time}
          WHERE id = ${item.id} AND status = 'open' AND (expires_at IS NULL OR expires_at > ${time}) RETURNING id`;
            if (changed.length === 0) return yield* invalid("This decision is no longer open.");
            yield* audit(time, actorOf(caller), profile, "decision.answer", item.id, "answered");
            if (item.from.threadId !== undefined)
              yield* sql`INSERT INTO decision_answer_deliveries (decision_id) VALUES (${item.id})`;
          }),
        )
        .pipe(Effect.mapError((error) => (isMcpFailure(error) ? error : storageFailure())));
      yield* deliver().pipe(
        Effect.catch(() =>
          Effect.logWarning("Decision answer delivery queued for retry", { decisionId: item.id }),
        ),
      );
      return yield* presentItem(caller, (yield* durable(item.id))!);
    }),
    withdraw: Effect.fn("DecisionInbox.withdraw")(function* (caller, id) {
      yield* writeAccess(caller);
      const item = yield* get(caller, id);
      if (item.source !== "decision")
        return yield* invalid("Projected requests are managed in their asking thread.");
      const scope = scopeOf(caller);
      if (
        !isOwner(caller) &&
        (scope.thread === undefined || scope.thread.threadId !== item.from.threadId)
      )
        return yield* denied("Only the asking thread or the owner can withdraw this decision.");
      const effective = yield* profiles.resolve(scope);
      const time = yield* now;
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql<{
              id: string;
            }>`UPDATE decision_items SET status = 'withdrawn', updated_at = ${time} WHERE id = ${id} AND status = 'open' RETURNING id`;
            if (changed.length === 0) return yield* invalid("This decision is no longer open.");
            yield* audit(
              time,
              actorOf(caller),
              isOwner(caller) ? "owner" : effective.profile.id,
              "decision.withdraw",
              id,
              "withdrawn",
            );
          }),
        )
        .pipe(Effect.mapError((error) => (isMcpFailure(error) ? error : storageFailure())));
      return yield* presentItem(caller, (yield* durable(id))!);
    }),
  });
});
export const layer = Layer.effect(DecisionInbox, make);
export const layerRunning = Layer.effectDiscard(
  Effect.gen(function* () {
    const inbox = yield* DecisionInbox;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("decision-inbox", inbox.runDueWork);
  }),
);
