import * as AccountAccess from "../accounts/AccountAccess.ts";
import * as AccountTransactions from "../accounts/AccountTransactions.ts";
import {
  RelayAuthorizationUnavailableError,
  RelayEnvironmentOwnerMismatchError,
} from "@goat/contracts/relayErrors";
import type { RelayAgentActivityState } from "@goat/contracts/relay";
import { RelayAgentActivityState as RelayAgentActivityStateSchema } from "@goat/contracts/relay";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Function from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayAgentActivityRows, relayEnvironmentLinks } from "../persistence/schema.ts";

export class AgentActivityRowUpsertPersistenceError extends Schema.TaggedError<AgentActivityRowUpsertPersistenceError>()(
  "AgentActivityRowUpsertPersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowDeletePersistenceError extends Schema.TaggedError<AgentActivityRowDeletePersistenceError>()(
  "AgentActivityRowDeletePersistenceError",
  {
    environmentId: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete agent activity state for environment ${this.environmentId}, thread ${this.threadId}.`;
  }
}

export class AgentActivityRowPruneTerminalPersistenceError extends Schema.TaggedError<AgentActivityRowPruneTerminalPersistenceError>()(
  "AgentActivityRowPruneTerminalPersistenceError",
  {
    updatedBefore: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prune terminal agent activity rows updated before ${this.updatedBefore}.`;
  }
}

export class AgentActivityRowListPersistenceError extends Schema.TaggedError<AgentActivityRowListPersistenceError>()(
  "AgentActivityRowListPersistenceError",
  {
    userId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to list agent activity state for user ${this.userId}.`;
  }
}

export class AgentActivityRows extends Context.Service<
  AgentActivityRows,
  {
    readonly upsert: (input: {
      readonly userId: string;
      readonly accountEpoch: number;
      readonly environmentPublicKey: string;
      readonly state: RelayAgentActivityState;
    }) => Effect.Effect<
      void,
      | AgentActivityRowUpsertPersistenceError
      | AccountAccess.AccountAccessError
      | RelayEnvironmentOwnerMismatchError
    >;
    readonly pruneTerminal: (input: {
      readonly updatedBefore: string;
    }) => Effect.Effect<void, AgentActivityRowPruneTerminalPersistenceError>;
    readonly remove: (input: {
      readonly userId: string;
      readonly accountEpoch: number;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
      readonly threadId: string;
    }) => Effect.Effect<
      void,
      | AgentActivityRowDeletePersistenceError
      | AccountAccess.AccountAccessError
      | RelayEnvironmentOwnerMismatchError
    >;
    readonly listForUser: (input: {
      readonly userId: string;
    }) => Effect.Effect<
      ReadonlyArray<RelayAgentActivityState>,
      AgentActivityRowListPersistenceError
    >;
    readonly getForUserThread: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly threadId: string;
    }) => Effect.Effect<RelayAgentActivityState | null, AgentActivityRowListPersistenceError>;
  }
>()("goat-relay/agentActivity/AgentActivityRows") {}

const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const encodeRelayAgentActivityStateJson = Schema.encodeEffect(
  Schema.fromJsonString(RelayAgentActivityStateSchema),
);

const decodeRelayAgentActivityState = Schema.decodeUnknownOption(RelayAgentActivityStateSchema);

export const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const access = yield* AccountAccess.AccountAccess;
  const tx = yield* AccountTransactions.AccountTransactions;
  const guard = Effect.fn("AgentActivityRows.guard")(function* (
    input: { userId: string; accountEpoch: number; environmentPublicKey: string },
    environmentId: string,
  ) {
    yield* access.requireAllowed(input);
    const [owner] = yield* db.$client<{
      valid: boolean;
    }>`SELECT EXISTS(SELECT 1 FROM relay_environment_owners WHERE user_id=${input.userId} AND environment_public_key=${input.environmentPublicKey} AND environment_id=${environmentId} AND account_epoch=${input.accountEpoch} AND state='active') AS valid`.pipe(
      Effect.mapError(
        () =>
          new RelayAuthorizationUnavailableError({
            code: "authorization_unavailable",
            traceId: "relay",
          }),
      ),
    );
    if (!owner?.valid)
      return yield* new RelayEnvironmentOwnerMismatchError({
        code: "environment_owner_mismatch",
        traceId: "relay",
      });
  });

  return AgentActivityRows.of({
    upsert: Effect.fn("relay.agent_activity_rows.upsert")(function* (input) {
      return yield* tx
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* guard(input, input.state.environmentId);
            yield* Effect.annotateCurrentSpan({
              "relay.environment_id": input.state.environmentId,
              "relay.thread_id": input.state.threadId,
            });
            const now = yield* DateTime.now;
            const stateJson = yield* encodeRelayAgentActivityStateJson(input.state).pipe(
              Effect.flatMap(decodeJsonString),
              Effect.map(Function.cast<unknown, RelayAgentActivityState>),
              Effect.mapError(
                (cause) =>
                  new AgentActivityRowUpsertPersistenceError({
                    environmentId: input.state.environmentId,
                    threadId: input.state.threadId,
                    cause,
                  }),
              ),
            );
            yield* db
              .insert(relayAgentActivityRows)
              .values({
                ownerUserId: input.userId,
                accountEpoch: input.accountEpoch,
                environmentId: input.state.environmentId,
                environmentPublicKey: input.environmentPublicKey,
                threadId: input.state.threadId,
                stateJson,
                updatedAt: input.state.updatedAt,
                createdAt: DateTime.formatIso(now),
              })
              .onConflictDoUpdate({
                target: [
                  relayAgentActivityRows.environmentId,
                  relayAgentActivityRows.environmentPublicKey,
                  relayAgentActivityRows.threadId,
                ],
                set: {
                  ownerUserId: input.userId,
                  accountEpoch: input.accountEpoch,
                  stateJson,
                  updatedAt: input.state.updatedAt,
                },
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentActivityRowUpsertPersistenceError({
                      environmentId: input.state.environmentId,
                      threadId: input.state.threadId,
                      cause,
                    }),
                ),
              );
          }),
        )
        .pipe(
          Effect.mapError((e) =>
            e._tag === "SqlError"
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : e,
          ),
        );
    }),

    remove: Effect.fn("relay.agent_activity_rows.remove")(function* (input) {
      return yield* tx
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* guard(input, input.environmentId);
            yield* Effect.annotateCurrentSpan({
              "relay.environment_id": input.environmentId,
              "relay.thread_id": input.threadId,
            });
            yield* db
              .delete(relayAgentActivityRows)
              .where(
                and(
                  eq(relayAgentActivityRows.ownerUserId, input.userId),
                  eq(relayAgentActivityRows.accountEpoch, input.accountEpoch),
                  eq(relayAgentActivityRows.environmentId, input.environmentId),
                  eq(relayAgentActivityRows.environmentPublicKey, input.environmentPublicKey),
                  eq(relayAgentActivityRows.threadId, input.threadId),
                ),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new AgentActivityRowDeletePersistenceError({
                      environmentId: input.environmentId,
                      threadId: input.threadId,
                      cause,
                    }),
                ),
              );
          }),
        )
        .pipe(
          Effect.mapError((e) =>
            e._tag === "SqlError"
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : e,
          ),
        );
    }),

    pruneTerminal: Effect.fn("relay.agent_activity_rows.prune_terminal")(function* (input) {
      yield* Effect.annotateCurrentSpan({
        "relay.agent_activity_prune.before": input.updatedBefore,
      });
      yield* db
        .delete(relayAgentActivityRows)
        .where(
          and(
            sql`${relayAgentActivityRows.stateJson} ->> 'phase' IN ('completed', 'failed')`,
            lt(relayAgentActivityRows.updatedAt, input.updatedBefore),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new AgentActivityRowPruneTerminalPersistenceError({
                updatedBefore: input.updatedBefore,
                cause,
              }),
          ),
        );
    }),

    listForUser: Effect.fn("relay.agent_activity_rows.list_for_user")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayAgentActivityRows.ownerUserId, input.userId),
            eq(relayAgentActivityRows.accountEpoch, relayEnvironmentLinks.accountEpoch),
            sql`EXISTS(SELECT 1 FROM relay_account_access a WHERE a.user_id=${input.userId} AND a.status='allowed' AND a.account_epoch=${relayAgentActivityRows.accountEpoch})`,
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayEnvironmentLinks.liveActivitiesEnabled, true),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) =>
            rows.flatMap((row) => Option.toArray(decodeRelayAgentActivityState(row.stateJson))),
          ),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),

    getForUserThread: Effect.fn("relay.agent_activity_rows.get_for_user_thread")(function* (input) {
      return yield* db
        .select({ stateJson: relayAgentActivityRows.stateJson })
        .from(relayAgentActivityRows)
        .innerJoin(
          relayEnvironmentLinks,
          and(
            eq(relayEnvironmentLinks.environmentId, relayAgentActivityRows.environmentId),
            eq(
              relayEnvironmentLinks.environmentPublicKey,
              relayAgentActivityRows.environmentPublicKey,
            ),
          ),
        )
        .where(
          and(
            eq(relayEnvironmentLinks.userId, input.userId),
            eq(relayAgentActivityRows.ownerUserId, input.userId),
            eq(relayAgentActivityRows.accountEpoch, relayEnvironmentLinks.accountEpoch),
            sql`EXISTS(SELECT 1 FROM relay_account_access a WHERE a.user_id=${input.userId} AND a.status='allowed' AND a.account_epoch=${relayAgentActivityRows.accountEpoch})`,
            isNull(relayEnvironmentLinks.revokedAt),
            eq(relayAgentActivityRows.environmentId, input.environmentId),
            eq(relayAgentActivityRows.threadId, input.threadId),
          ),
        )
        .orderBy(desc(relayAgentActivityRows.updatedAt))
        .pipe(
          Effect.map((rows) => {
            for (const row of rows) {
              const decoded = decodeRelayAgentActivityState(row.stateJson);
              if (Option.isSome(decoded)) {
                return decoded.value;
              }
            }
            return null;
          }),
          Effect.mapError(
            (cause) =>
              new AgentActivityRowListPersistenceError({
                userId: input.userId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(AgentActivityRows, make);
