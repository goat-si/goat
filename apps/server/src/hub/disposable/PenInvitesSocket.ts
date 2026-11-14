// @effect-diagnostics nodeBuiltinImport:off -- bound-invite ops run on Pen's control socket.
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { guardErrors } from "@goat/shared/errorGuards";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { lineReader } from "../../pen/penHandshake.ts";
import * as Settings from "../../serverSettings.ts";
import {
  PenInviteUnknown,
  PenInvites,
  type PenInviteRef,
  type PenInviteState,
  type PenInviteStatus,
} from "./PenInvites.ts";

// One answer line; a status reply carries a few small fields, ls every member with host keys.
const LINE_CAP = 1 << 20;
const OP_TIMEOUT = "10 seconds";

const Status = Schema.Struct({ features: Schema.optional(Schema.Array(Schema.String)) });
const Ls = Schema.Struct({ members: Schema.Array(Schema.Struct({ signPub: Schema.String })) });
const Minted = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.Number,
  id: Schema.String,
  mintId: Schema.String,
});
const Cancelled = Schema.Struct({
  t: Schema.Literal("invite-cancel"),
  inviteId: Schema.optional(Schema.String),
  mintId: Schema.optional(Schema.String),
  state: Schema.Literals(["cancelled", "burned", "expired", "absent"]),
});
const InviteStatus = Schema.Struct({
  t: Schema.Literal("invite-status"),
  inviteId: Schema.optional(Schema.String),
  mintId: Schema.optional(Schema.String),
  state: Schema.Literals(["live", "cancelled", "expired", "burned", "burned-unsaved", "absent"]),
  expiresAt: Schema.optional(Schema.Number),
  nonce: Schema.optional(Schema.String),
  admit: Schema.optional(Schema.String),
  member: Schema.optional(Schema.Boolean),
});
const Acked = Schema.Struct({
  t: Schema.Literal("invite-ack"),
  inviteId: Schema.optional(Schema.String),
  mintId: Schema.optional(Schema.String),
  state: Schema.Literals(["acked", "absent"]),
});
const decode = <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  Schema.decodeUnknownOption(Schema.fromJsonString(schema));
const decodeStatus = decode(Status);
const decodeLs = decode(Ls);
const decodeMinted = decode(Minted);
const decodeCancelled = decode(Cancelled);
const decodeInviteStatus = decode(InviteStatus);
const decodeAcked = decode(Acked);

const unknown = (reason: string) => new PenInviteUnknown({ reason });
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** What one invite.status reply says, or unknown when it is not what Pen promises for its state. */
const stateOf = (
  reply: typeof InviteStatus.Type,
): Effect.Effect<PenInviteState, PenInviteUnknown> => {
  switch (reply.state) {
    case "live":
      return reply.expiresAt === undefined
        ? Effect.fail(unknown("live without expiry"))
        : Effect.succeed({ state: "live", expiresAtMs: reply.expiresAt });
    case "burned":
      return reply.nonce === undefined
        ? Effect.fail(unknown("burned without nonce"))
        : Effect.succeed({
            state: "burned",
            nonce: reply.nonce,
            ...(reply.admit === undefined ? {} : { admit: reply.admit }),
            ...(reply.member === undefined ? {} : { member: reply.member }),
          });
    case "burned-unsaved":
      return reply.nonce === undefined
        ? Effect.fail(unknown("burned without nonce"))
        : Effect.succeed({ state: "burned-unsaved", nonce: reply.nonce });
    default:
      return Effect.succeed({ state: reply.state });
  }
};

type Connect = (path: string, onError: () => void) => NodeNet.Socket;

const make = Effect.fn("PenInvitesSocket.make")(function* (connect: Connect) {
  const settings = yield* Settings.ServerSettingsService;

  /** Sends one op to the confirmed Pen's control socket and reads its one answer line. */
  const ask = Effect.fn("PenInvitesSocket.ask")(function* (op: Record<string, unknown>) {
    const pen = (yield* settings.getSettings.pipe(
      Effect.mapError(() => unknown("settings unreadable")),
    )).pen;
    if (pen === null) return yield* unknown("no confirmed Pen");
    const path = NodePath.join(pen.stateDir, "control.sock");
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* Effect.acquireRelease(
          Effect.callback<NodeNet.Socket, PenInviteUnknown>((resume) => {
            const connection = connect(path, () =>
              resume(Effect.fail(unknown("control socket unreachable"))),
            );
            connection.once("connect", () => resume(Effect.succeed(connection)));
            // The op timeout interrupts a connect that never completes; this closes its socket.
            return Effect.sync(() => connection.destroy());
          }),
          (connection) => Effect.sync(() => connection.destroy()),
          // Without this the acquire runs uninterruptibly and the timeout cannot reach the connect.
          { interruptible: true },
        );
        const reader = lineReader(socket);
        socket.write(encodeLine(op) + "\n");
        const line = yield* reader.read(LINE_CAP).pipe(Effect.mapError(() => unknown("no answer")));
        return line.toString("utf8");
      }),
    ).pipe(
      Effect.timeoutOrElse({
        duration: OP_TIMEOUT,
        orElse: () => Effect.fail(unknown("timed out")),
      }),
    );
  });

  const answer = <A>(decoded: Option.Option<A>, what: string) =>
    Effect.fromOption(decoded).pipe(
      Effect.mapError(() => unknown(what + " unreadable or refused")),
    );
  const named = (ref: PenInviteRef) =>
    "mintId" in ref ? { mintId: ref.mintId } : { inviteId: ref.inviteId };
  /**
   * Pen repeats the id each op names (CONTRACT "Bound invites"); an answer that names another
   * invite, or none, says nothing about this one.
   */
  const about =
    (ref: PenInviteRef, what: string) =>
    <A extends { readonly inviteId?: string | undefined; readonly mintId?: string | undefined }>(
      reply: A,
    ) =>
      ("mintId" in ref ? reply.mintId === ref.mintId : reply.inviteId === ref.inviteId)
        ? Effect.succeed(reply)
        : Effect.fail(unknown(what + " answered another invite"));

  return PenInvites.of({
    features: ask({ op: "status" }).pipe(
      Effect.map((line) => Option.getOrUndefined(decodeStatus(line))?.features),
      Effect.map((features) => (features === undefined ? new Set<string>() : new Set(features))),
      Effect.orElseSucceed(() => undefined),
    ),
    members: ask({ op: "ls" }).pipe(
      Effect.map((line) =>
        Option.getOrUndefined(
          Option.map(decodeLs(line), (ls) => new Set(ls.members.map((m) => m.signPub))),
        ),
      ),
      Effect.orElseSucceed(() => undefined),
      Effect.withSpan("PenInvites.members"),
    ),
    mint: Effect.fn("PenInvites.mint")(function* ({ subject, mintId, expiresAtMs }) {
      return yield* ask({ op: "invite", subject, mintId, expiresAt: expiresAtMs }).pipe(
        Effect.flatMap((line) => answer(decodeMinted(line), "invite")),
        Effect.flatMap((minted) =>
          minted.mintId === mintId
            ? Effect.succeed({
                inviteId: minted.id,
                token: minted.token,
                expiresAtMs: minted.expiresAt,
              })
            : Effect.fail(unknown("invite answered another mint")),
        ),
      );
    }),
    cancel: Effect.fn("PenInvites.cancel")(function* (ref) {
      return yield* ask({ op: "invite.cancel", ...named(ref) }).pipe(
        Effect.flatMap((line) => answer(decodeCancelled(line), "invite.cancel")),
        Effect.flatMap(about(ref, "invite.cancel")),
        Effect.map((reply) => reply.state),
      );
    }),
    status: Effect.fn("PenInvites.status")(function* (ref) {
      return yield* ask({ op: "invite.status", ...named(ref) }).pipe(
        Effect.flatMap((line) => answer(decodeInviteStatus(line), "invite.status")),
        Effect.flatMap(about(ref, "invite.status")),
        Effect.flatMap((reply) =>
          stateOf(reply).pipe(
            Effect.map((state): PenInviteStatus =>
              reply.inviteId === undefined ? state : { ...state, inviteId: reply.inviteId },
            ),
          ),
        ),
      );
    }),
    ack: Effect.fn("PenInvites.ack")(function* (ref) {
      return yield* ask({ op: "invite.ack", ...named(ref) }).pipe(
        Effect.flatMap((line) => answer(decodeAcked(line), "invite.ack")),
        Effect.flatMap(about(ref, "invite.ack")),
        Effect.map((reply) => reply.state),
      );
    }),
  });
});

/** Opens the control socket with `connect`; tests pass one that never completes. */
export const layerConnecting = (connect: Connect) => Layer.effect(PenInvites, make(connect));

export const layer = layerConnecting((path, onError) =>
  guardErrors(NodeNet.createConnection(path), onError),
);
