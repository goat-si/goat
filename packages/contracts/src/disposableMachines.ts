import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Disposable machines are cloud VMs a provisioner admits to the owner's Pen mesh and links as
 * Remote Link Children in one attach, and removes in one detach. They differ from kept machines
 * only by how they joined: a disposable record proves the bound invite that admitted their key.
 */

export const DISPOSABLE_NAME_RULE_DEFAULT = "^[a-z][a-z0-9-]{0,30}$";
export const DISPOSABLE_CAP_DEFAULT = 10;
export const DISPOSABLE_SWITCH_DAYS = 30;

const compiles = (rule: string) => {
  try {
    return new RegExp(rule, "u") instanceof RegExp;
  } catch {
    return "Expected a regular expression.";
  }
};

/** The names disposable members may carry. It bounds names; it never grants a class. */
export const DisposableNameRule = Schema.String.check(
  Schema.isMaxLength(200),
  Schema.makeFilter(compiles),
);

/** Whether a machine name matches the rule as a whole. */
export const matchesDisposableNameRule = (rule: string, name: string) => {
  try {
    return new RegExp(`^(?:${rule})$`, "u").test(name);
  } catch {
    return false;
  }
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

export const DisposableMachineProvisioner = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
  /** A person in Settings; their session is kept on the hub, never sent to clients. */
  Schema.Struct({ kind: Schema.Literal("person") }),
]);
export type DisposableMachineProvisioner = typeof DisposableMachineProvisioner.Type;

/**
 * A hub node's class when a disposable record matches it. Absent means kept. `conflict` blocks
 * every destructive step and automatic action until a person resolves it; `conflicts` says why.
 */
export const HubNodeMachineClass = Schema.Struct({
  class: Schema.Literals(["disposable", "conflict"]),
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
