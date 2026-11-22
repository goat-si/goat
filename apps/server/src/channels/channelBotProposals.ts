// @effect-diagnostics-next-line nodeBuiltinImport:off -- proposal IDs and request hashes use Node crypto.
import * as NodeCrypto from "node:crypto";
import {
  BotProposalCard,
  BotProposalFields,
  ChannelGatewayError,
  type ChannelCreateBotInput,
  type ChannelProposeBotInput,
  type ChannelResolveBotProposalInput,
  type ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ChannelBotTimeline } from "./ChannelBotTimeline.ts";
import type { ChannelLedger } from "./ChannelLedger.ts";

const Stored = Schema.fromJsonString(
  Schema.Struct({ ...BotProposalCard.fields, requestHash: Schema.String }),
);
const encodeFields = Schema.encodeSync(Schema.fromJsonString(BotProposalFields));
const decode = Schema.decodeUnknownSync(Stored);
const encode = Schema.encodeSync(Stored);
const keyPrefix = (ownerId: string) => "bot-proposal:" + encodeURIComponent(ownerId) + ":";
const fail = (reason: ChannelGatewayError["reason"]) => new ChannelGatewayError({ reason });
const isGatewayError = Schema.is(ChannelGatewayError);
const mapFailure = (error: unknown) => (isGatewayError(error) ? error : fail("persistence_failed"));

export interface BotProposalCreate {
  readonly id: string;
  readonly instructions: string;
  readonly commit: Effect.Effect<void, ChannelGatewayError>;
}

export function botProposalOperations(deps: {
  sql: SqlClient.SqlClient;
  ledger: ChannelLedger["Service"];
  timeline: ChannelBotTimeline["Service"];
  serial: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>;
  requireHome: Effect.Effect<void, ChannelGatewayError>;
  create: (
    input: ChannelCreateBotInput,
    owner: { ownerId: string },
    proposal: {
      id: string;
      instructions: string;
      commit: Effect.Effect<void, ChannelGatewayError>;
    },
  ) => Effect.Effect<unknown, ChannelGatewayError>;
}) {
  const { sql, ledger, timeline } = deps;
  const render = (threadId: ThreadId, card: BotProposalCard) =>
    timeline
      .record({
        threadId,
        revision: card.status,
        record: {
          recordKey: "bot-proposal:" + card.proposalId,
          entry: { type: "event", text: "Bot proposal: " + card.fields.name, botProposal: card },
        },
      })
      .pipe(Effect.asVoid);

  const propose = Effect.fn("ChannelBotMembers.propose")(
    function* (input: ChannelProposeBotInput, owner: { ownerId: string }, namespace: string) {
      yield* deps.requireHome;
      if (input.templateId !== undefined) return yield* fail("invalid_input");
      const main = yield* ledger.getBot(owner.ownerId);
      if (main === undefined) return yield* fail("not_found");
      const at = yield* DateTime.now;
      const now = DateTime.formatIso(at);
      const prefix = keyPrefix(owner.ownerId);
      const upper = prefix.slice(0, -1) + ";";
      const requestHash = NodeCrypto.createHash("sha256")
        .update(encodeURIComponent(namespace) + ":" + encodeURIComponent(input.clientRequestId))
        .digest("hex");
      const fields = {
        name: input.name,
        avatar: input.avatar,
        purpose: input.purpose,
        instructions: input.instructions,
        why: input.why,
      };
      const stored = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM channel_runtime_state WHERE key > ${prefix} AND key < ${upper}
        AND json_extract(value_json, '$.expiresAt') <= ${now}`;
          const matches = yield* sql<{ value_json: string }>`SELECT value_json
        FROM channel_runtime_state WHERE key > ${prefix} AND key < ${upper}
        AND json_extract(value_json, '$.requestHash') = ${requestHash} LIMIT 1`;
          if (matches[0] !== undefined) {
            const existing = decode(matches[0].value_json);
            if (encodeFields(existing.fields) !== encodeFields(fields)) {
              return yield* fail("idempotency_conflict");
            }
            return existing;
          }
          const counts = yield* sql<{ count: number }>`SELECT count(*) AS count
        FROM channel_runtime_state WHERE key > ${prefix} AND key < ${upper}`;
          if ((counts[0]?.count ?? 0) >= 50) return yield* fail("bot_limit");
          const proposal = {
            proposalId: NodeCrypto.randomBytes(32).toString("hex"),
            expiresAt: DateTime.formatIso(DateTime.add(at, { days: 7 })),
            fields,
            requestHash,
            status: "pending" as const,
          };
          yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
        VALUES (${prefix + proposal.proposalId}, ${encode(proposal)}, ${now})`;
          return proposal;
        }),
      );
      const { requestHash: _, ...card } = stored;
      yield* render(main.bot.threadId, card);
      return { proposalId: card.proposalId };
    },
    Effect.mapError(mapFailure),
    deps.serial,
  );

  const resolveProposal = Effect.fn("ChannelBotMembers.resolveProposal")(
    function* (
      input: ChannelResolveBotProposalInput,
      owner: { ownerId: string },
      authorize: Effect.Effect<void, ChannelGatewayError>,
    ) {
      yield* authorize;
      yield* deps.requireHome;
      const key = keyPrefix(owner.ownerId) + input.proposalId;
      const rows = yield* sql<{ value_json: string }>`SELECT value_json
      FROM channel_runtime_state WHERE key = ${key}`;
      if (rows[0] === undefined) return yield* fail("not_found");
      const { requestHash, ...card } = decode(rows[0].value_json);
      const at = DateTime.formatIso(yield* DateTime.now);
      const status = input.accept ? "accepted" : "dismissed";
      if (card.status !== "pending" && card.status !== status) return yield* fail("not_found");
      if (card.status === "pending" && card.expiresAt <= at) return yield* fail("not_found");
      const main = yield* ledger.getBot(owner.ownerId);
      if (main === undefined) return yield* fail("not_found");
      const next: BotProposalCard = { ...card, status };
      const commit = sql`UPDATE channel_runtime_state
      SET value_json = ${encode({ ...next, requestHash })}, updated_at = ${at} WHERE key = ${key}`.pipe(
        Effect.asVoid,
        Effect.mapError(mapFailure),
      );
      if (input.accept) {
        const { name, avatar, purpose, instructions } = card.fields;
        yield* deps.create(
          { name, avatar, purpose, defaultModelSelection: null, clientRequestId: card.proposalId },
          owner,
          { id: card.proposalId, instructions, commit },
        );
      } else if (card.status === "pending") {
        yield* commit;
      }
      yield* render(main.bot.threadId, next);
    },
    Effect.mapError(mapFailure),
    deps.serial,
  );

  return { propose, resolveProposal };
}
