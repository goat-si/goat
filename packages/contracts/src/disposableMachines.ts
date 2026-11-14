import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Disposable machines are cloud VMs a provisioner admits to the owner's Pen mesh and links as
 * Remote Link Children in one attach, and removes in one detach. They differ from kept machines
 * only by how they joined: a disposable record proves the bound invite that admitted their key.
 */

export const DISPOSABLE_NAME_RULE_DEFAULT = "^[a-z][a-z0-9-]{0,30}$";
export const DISPOSABLE_CAP_DEFAULT = 10;
export const DISPOSABLE_SWITCH_DAYS = 30;

/** A machine name longer than Pen's longest node name never matches. */
export const DISPOSABLE_NAME_MAX = 32;
const NAME_CHAR = /^[a-z0-9_.-]$/u;
/** Pen's node name (ident.ValidName): 1 to 32 of a-z 0-9 - _ ., starting with a letter or digit. */
export const isPenNodeName = (name: string) => /^[a-z0-9][a-z0-9_.-]{0,31}$/u.test(name);

type Piece = {
  readonly accepts: (char: string) => boolean;
  readonly kind: "one" | "maybe" | "many";
};

/**
 * The name rule is a person's pattern matched against names a provisioner chooses, so it is kept
 * to a subset with no groups or alternation (letters, digits, - _ . and \. literals, `.`, [..]
 * classes, quantifiers ? * + {n} {n,} {n,m} up to 64) and matched in linear time below; a full
 * regular expression could backtrack for minutes on a chosen name. ^ and $ are implied.
 */
const parseNameRule = (rule: string): ReadonlyArray<Piece> | undefined => {
  const body = rule.replace(/^\^/u, "").replace(/(?<!\\)\$$/u, "");
  const pieces: Array<Piece> = [];
  let at = 0;
  while (at < body.length) {
    let accepts: (char: string) => boolean;
    const char = body[at] ?? "";
    if (char === "[") {
      const close = body.indexOf("]", at + 2);
      if (close < 0) return undefined;
      const inside = body.slice(at + 1, close);
      const ranges: Array<readonly [string, string]> = [];
      for (let index = 0; index < inside.length; index += 1) {
        const from = inside[index] ?? "";
        if (!NAME_CHAR.test(from)) return undefined;
        const to = inside[index + 2];
        if (inside[index + 1] === "-" && to !== undefined && NAME_CHAR.test(to)) {
          if (to < from) return undefined;
          ranges.push([from, to]);
          index += 2;
        } else ranges.push([from, from]);
      }
      accepts = (c) => ranges.some(([from, to]) => c >= from && c <= to);
      at = close + 1;
    } else if (char === "\\") {
      const literal = body[at + 1] ?? "";
      if (!/^[.\-_]$/u.test(literal)) return undefined;
      accepts = (c) => c === literal;
      at += 2;
    } else if (char === ".") {
      accepts = () => true;
      at += 1;
    } else if (NAME_CHAR.test(char)) {
      accepts = (c) => c === char;
      at += 1;
    } else return undefined;
    let min = 1;
    let max: number = 1;
    const quantifier = /^(?:[?*+]|\{(\d{1,2})(?:(,)(\d{1,2})?)?\})/u.exec(body.slice(at));
    if (quantifier !== null) {
      const [text, low, comma, high] = quantifier;
      if (text === "?") [min, max] = [0, 1];
      else if (text === "*") [min, max] = [0, Infinity];
      else if (text === "+") [min, max] = [1, Infinity];
      else {
        min = Number(low);
        max = comma === undefined ? min : high === undefined ? Infinity : Number(high);
      }
      if (min > 64 || (max !== Infinity && (max > 64 || max < min))) return undefined;
      at += text.length;
    }
    for (let copy = 0; copy < min; copy += 1) pieces.push({ accepts, kind: "one" });
    if (max === Infinity) pieces.push({ accepts, kind: "many" });
    else for (let copy = min; copy < max; copy += 1) pieces.push({ accepts, kind: "maybe" });
    if (pieces.length > 512) return undefined;
  }
  return pieces;
};

/** The names disposable members may carry. It bounds names; it never grants a class. */
export const DisposableNameRule = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.makeFilter((rule: string) =>
    parseNameRule(rule) === undefined
      ? "Use letters, digits, - _ . and \\., [a-z] classes and counts such as {0,30}."
      : true,
  ),
);

/** Whether a machine name matches the rule as a whole, in time linear in name and rule. */
export const matchesDisposableNameRule = (rule: string, name: string) => {
  const pieces = parseNameRule(rule);
  if (pieces === undefined || name.length > DISPOSABLE_NAME_MAX) return false;
  const close = (states: ReadonlySet<number>) => {
    const out = new Set(states);
    for (let index = 0; index < pieces.length; index += 1)
      if (out.has(index) && pieces[index]?.kind !== "one") out.add(index + 1);
    return out;
  };
  let states = close(new Set([0]));
  for (const char of name) {
    const next = new Set<number>();
    for (const index of states) {
      const piece = pieces[index];
      if (piece === undefined || !piece.accepts(char)) continue;
      next.add(piece.kind === "many" ? index : index + 1);
    }
    states = close(next);
    if (states.size === 0) return false;
  }
  return states.has(pieces.length);
};

const DisposableCap = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
const DisposableProvisioners = Schema.Array(ThreadId).check(Schema.isMaxLength(32));

/**
 * Hub setting "Attach disposable machines": a person's standing consent that the threads named
 * here, and a person in Settings, may admit up to `cap` machines to the Pen mesh until
 * `expiresAt`. The server replaces `grantId` on every change, so an attach step admitted
 * under one consent never commits under another.
 */
export const HubDisposableMachinesSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  provisioners: DisposableProvisioners.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  cap: DisposableCap.pipe(Schema.withDecodingDefault(Effect.succeed(DISPOSABLE_CAP_DEFAULT))),
  nameRule: DisposableNameRule.pipe(
    Schema.withDecodingDefault(Effect.succeed(DISPOSABLE_NAME_RULE_DEFAULT)),
  ),
  /** Set by the server to 30 days ahead when the switch turns on without one. */
  expiresAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  grantId: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HubDisposableMachinesSettings = typeof HubDisposableMachinesSettings.Type;

const SWITCH_OFF: HubDisposableMachinesSettings = {
  enabled: false,
  provisioners: [],
  cap: DISPOSABLE_CAP_DEFAULT,
  nameRule: DISPOSABLE_NAME_RULE_DEFAULT,
  expiresAt: null,
  grantId: null,
};
/**
 * The switch as saved settings read it: a block this version cannot read (a later version widened
 * a limit, then a downgrade) reads as off, and the next write saves it off, instead of failing the
 * whole settings file.
 */
// A union keeps the strict member for encoding, so the sparse settings writer still works.
export const HubDisposableMachinesSaved = Schema.Union([
  HubDisposableMachinesSettings,
  Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.toType(HubDisposableMachinesSettings),
      SchemaTransformation.transform<HubDisposableMachinesSettings, unknown>({
        decode: () => SWITCH_OFF,
        encode: (value) => value,
      }),
    ),
  ),
]);

/** Changes the named fields; `grantId` is the server's alone. */
export const HubDisposableMachinesPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  provisioners: Schema.optionalKey(DisposableProvisioners),
  cap: Schema.optionalKey(DisposableCap),
  nameRule: Schema.optionalKey(DisposableNameRule),
  expiresAt: Schema.optionalKey(Schema.NullOr(IsoDateTime)),
});
export type HubDisposableMachinesPatch = typeof HubDisposableMachinesPatch.Type;

/** Applies a patch field by field. A `grantId` in it is ignored: only the server stamps one. */
export const patchDisposableMachines = (
  current: HubDisposableMachinesSettings,
  patch: HubDisposableMachinesPatch | undefined,
): HubDisposableMachinesSettings =>
  patch === undefined ? current : { ...current, ...patch, grantId: current.grantId };

/**
 * Record states. A record in a final state no longer holds its keys unique; a key still in Pen
 * keeps its cap slot whatever the state. The wire carries states as text so an older client still
 * shows the node.
 */
export const DISPOSABLE_MACHINE_STATES = [
  "reserved",
  "invited",
  "admitted",
  "attaching",
  "linked",
  "left_pen",
  "attached",
  "failed",
  "unknown",
  "paused",
  "detaching",
  "pending_release",
  "purged",
  "retired",
  "returned",
  "destroyed",
  "kept",
] as const;
export type DisposableMachineState = (typeof DISPOSABLE_MACHINE_STATES)[number];
export const DISPOSABLE_FINAL_STATES: ReadonlySet<DisposableMachineState> = new Set([
  "failed",
  "purged",
  "destroyed",
  "kept",
]);

/**
 * Who vouched for the machine: kind "thread" with its threadId, or "person" (their session stays on
 * the hub). Kinds are text so a newer kind never makes an older client drop the node.
 */
export const DisposableMachineProvisioner = Schema.Struct({
  kind: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  threadId: Schema.optionalKey(ThreadId),
});
export type DisposableMachineProvisioner = typeof DisposableMachineProvisioner.Type;

/**
 * A hub node's class when a disposable record matches it. Absent means kept. `disposable` or
 * `conflict` today, as text so a newer class never drops the node; a client shows a class it does
 * not know as a conflict. `conflict` blocks every destructive step and automatic action.
 */
export const HubNodeMachineClass = Schema.Struct({
  class: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  attachId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  state: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  stateSince: IsoDateTime,
  provisioner: DisposableMachineProvisioner,
  /** The admitted key has not been confirmed gone from the hub's Pen view. */
  penMember: Schema.Boolean,
  conflicts: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(60))).check(
    Schema.isMaxLength(16),
  ),
});
export type HubNodeMachineClass = typeof HubNodeMachineClass.Type;

/** A Pen key as the protocol writes it: 43 base64url characters for 32 bytes. */
export const DisposablePenKey = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u));
/** A Pen member name; the switch's name rule narrows it further. */
export const DisposableMachineName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u),
);
const RequestKey = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const DisposableAttachId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * Starts one attach: GOAT mints a Pen invite bound to these keys and name. Once Pen admits the
 * machine, GOAT checks its route, reaches it with the hub machine key and links it to OpenCodex as a
 * lightweight Child. An agent caller must be a thread the switch names.
 */
export const HubMachineAttachInput = Schema.Struct({
  name: DisposableMachineName,
  signPub: DisposablePenKey,
  noisePub: DisposablePenKey,
  label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(120))),
  /** The cloud run that built the machine, kept for the record only. */
  cloudRunId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  clientRequestId: RequestKey,
});
export type HubMachineAttachInput = typeof HubMachineAttachInput.Type;

/** Cancels the open invite and mints another for the same keys, when the first admitted nobody. */
export const HubMachineReissueInput = Schema.Struct({
  attachId: DisposableAttachId,
  clientRequestId: RequestKey,
});
export type HubMachineReissueInput = typeof HubMachineReissueInput.Type;

export const HubMachineListInput = Schema.Struct({
  attachId: Schema.optionalKey(DisposableAttachId),
});
export type HubMachineListInput = typeof HubMachineListInput.Type;

/**
 * Detaches an admitted machine: GOAT removes its OpenCodex link and the lightweight Child with a
 * journalled purge, and the record ends purged. `force` (a person only) removes the link without
 * the machine, leaving a tombstone GOAT cleans once the machine answers. The machine stays a Pen
 * member until a person removes it with pen revoke.
 */
export const HubMachineDetachInput = Schema.Struct({
  attachId: DisposableAttachId,
  clientRequestId: RequestKey,
  force: Schema.optionalKey(Schema.Boolean),
});
export type HubMachineDetachInput = typeof HubMachineDetachInput.Type;

/**
 * A person frees the slot of an attach whose invite Pen lost or used without a saved admit. The
 * machine may still have joined Pen; if so, a person removes it with pen revoke.
 */
export const HubMachineReleaseInput = Schema.Struct({
  attachId: DisposableAttachId,
  clientRequestId: RequestKey,
});
export type HubMachineReleaseInput = typeof HubMachineReleaseInput.Type;

/** One attach step as the caller sees it; texts are GOAT's own, never a machine's output. */
export const HubMachineStep = Schema.Struct({
  step: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  outcome: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type HubMachineStep = typeof HubMachineStep.Type;

/** An OpenSSH ed25519 public key line; the comment is GOAT's own. */
export const DisposableMachineKey = Schema.String.check(
  Schema.isPattern(/^ssh-ed25519 [A-Za-z0-9+/]{68}(?: [A-Za-z0-9._@-]{1,64})?$/u),
);

export const HubMachineStatus = Schema.Struct({
  attachId: DisposableAttachId,
  name: DisposableMachineName,
  nodeId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  state: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  step: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(40))),
  steps: Schema.Array(HubMachineStep).check(Schema.isMaxLength(32)),
  message: Schema.String.check(Schema.isMaxLength(500)),
  nextAction: Schema.NullOr(Schema.String.check(Schema.isMaxLength(300))),
  /** disposable, conflict or kept today; a client treats a value it does not know as conflict. */
  class: TrimmedNonEmptyString.check(Schema.isMaxLength(40)),
  /** The admitted key has not been confirmed gone from the hub's Pen view. */
  penMember: Schema.Boolean,
  provisioner: DisposableMachineProvisioner,
  stateSince: IsoDateTime,
  /**
   * The hub's machine key while the attach is open: the provisioner adds this public line to the
   * machine user's authorized_keys, and GOAT and the Home reach the machine with it alone.
   */
  machineKey: Schema.optionalKey(DisposableMachineKey),
  /**
   * Only in the answer that minted it: the token the machine joins with. The attach service never
   * keeps it, and a replay answers without it; an agent caller's tool output, which carries it, is
   * kept in that thread's history and its provider's transcript.
   */
  invite: Schema.optionalKey(
    Schema.Struct({
      token: Schema.String.check(Schema.isMaxLength(4096)),
      expiresAt: IsoDateTime,
    }),
  ),
});
export type HubMachineStatus = typeof HubMachineStatus.Type;

export const HubMachineList = Schema.Struct({ machines: Schema.Array(HubMachineStatus) });
export type HubMachineList = typeof HubMachineList.Type;

/** The reasons this version sends; the wire carries any short string, so a newer one still decodes. */
export const HubMachinesErrorReason = Schema.Literals([
  "invalid_request",
  "not_found",
  "switch_off",
  "switch_expired",
  "provisioner_refused",
  "delegation_lost",
  "cap_reached",
  "name_rule",
  "key_in_use",
  "pen_unsupported",
  "opencodex_unsupported",
  "conflict",
  "unknown_outcome",
  "storage_failed",
  "person_required",
  "hold_unsupported",
  "pen_unavailable",
]);
export type HubMachinesErrorReason = typeof HubMachinesErrorReason.Type;

/** Safe to show: fixed texts only, never a token or a machine's output. */
export class HubMachinesError extends Schema.TaggedError<HubMachinesError>()("HubMachinesError", {
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  detail: Schema.String.check(Schema.isMaxLength(1000)),
}) {
  override get message(): string {
    return this.detail;
  }
}
