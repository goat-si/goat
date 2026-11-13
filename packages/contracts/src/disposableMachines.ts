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
export const DISPOSABLE_NAME_MAX = 63;
const NAME_CHAR = /^[a-z0-9_.-]$/u;

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
  "invited",
  "admitted",
  "attaching",
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
