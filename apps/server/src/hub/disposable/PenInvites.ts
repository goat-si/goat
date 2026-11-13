import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

/**
 * The hub Pen's bound-invite operations (design lanes P1 to P4), as attach uses them. The socket
 * client reads Pen's control socket; tests use a fake of the same contract. Every answer here is
 * what Pen saved: an op whose answer is lost or unreadable fails with PenInviteUnknown, and the
 * caller treats the effect as unknown.
 */

/** The features GOAT requires before minting (design section 5, P1 to P4). */
export const PEN_ATTACH_FEATURES = [
  "invite.subject/1",
  "invite.cancel/1",
  "invite.mint/1",
  "invite.status/1",
] as const;

export interface PenSubject {
  readonly signPub: string;
  readonly noisePub: string;
  readonly name: string;
}

export interface PenMinted {
  readonly inviteId: string;
  /** Bearer token; returned to the provisioner once, never written to a record or a log. */
  readonly token: string;
  readonly expiresAtMs: number;
}

export type PenInviteRef = { readonly inviteId: string } | { readonly mintId: string };

/** An invite's state as Pen saved it (pen-protocol CONTRACT "Bound invites"). */
export type PenInviteState =
  | { readonly state: "live"; readonly expiresAtMs: number }
  | { readonly state: "cancelled" }
  | { readonly state: "expired" }
  /**
   * Used by a join whose card repeats `nonce`. With `admit`, the admit is in Pen's saved record set;
   * without it, the burn was saved and no admit followed.
   */
  | {
      readonly state: "burned";
      readonly nonce: string;
      readonly admit?: string;
      readonly member?: boolean;
    }
  /** Burned while Pen holds records it has not saved: ask again later. */
  | { readonly state: "burned-unsaved"; readonly nonce: string }
  /** No entry or fence. */
  | { readonly state: "absent" };

/** A status answer, with the invite id Pen names once the mint made an invite. */
export type PenInviteStatus = PenInviteState & { readonly inviteId?: string };

export class PenInviteUnknown extends Data.TaggedError("PenInviteUnknown")<{
  readonly reason: string;
}> {}

export class PenInvites extends Context.Service<
  PenInvites,
  {
    /** Pen's features; undefined when Pen cannot be asked. */
    readonly features: Effect.Effect<ReadonlySet<string> | undefined>;
    /** The signing keys of the hub's Pen view; undefined when unreadable. */
    readonly members: Effect.Effect<ReadonlySet<string> | undefined>;
    readonly mint: (input: {
      readonly subject: PenSubject;
      readonly mintId: string;
      readonly expiresAtMs: number;
    }) => Effect.Effect<PenMinted, PenInviteUnknown>;
    readonly cancel: (
      ref: PenInviteRef,
    ) => Effect.Effect<"cancelled" | "burned" | "expired" | "absent", PenInviteUnknown>;
    readonly status: (ref: PenInviteRef) => Effect.Effect<PenInviteStatus, PenInviteUnknown>;
    /** Lets Pen forget a terminal entry or a fence GOAT has recorded. */
    readonly ack: (ref: PenInviteRef) => Effect.Effect<"acked" | "absent", PenInviteUnknown>;
  }
>()("goat/hub/disposable/PenInvites") {}
