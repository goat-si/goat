import * as Schema from "effect/Schema";

/**
 * Present in a server's state directory while its automation must not act: the server runs no
 * scheduled tasks, channel bots, goal or fleet dispatch, and keeps out of hub and link membership,
 * until a person resumes it. The desktop writes one into a nightly copy of stable's state, because
 * that copy keeps stable's environment identity and automation and both apps may run at once.
 */
export const AUTOMATION_HOLD_FILE_NAME = "automation-hold.json";

export const AutomationHoldReason = Schema.Literals(["channel-copy"]);
export type AutomationHoldReason = typeof AutomationHoldReason.Type;

export const AutomationHold = Schema.Struct({
  reason: AutomationHoldReason,
  heldAt: Schema.String,
});
export type AutomationHold = typeof AutomationHold.Type;

const AutomationHoldJson = Schema.fromJsonString(AutomationHold);

export const encodeAutomationHold = (hold: AutomationHold): string =>
  `${Schema.encodeSync(AutomationHoldJson)(hold)}\n`;

export const decodeAutomationHold = Schema.decodeUnknownSync(AutomationHoldJson);

export class AutomationResumeError extends Schema.TaggedError<AutomationResumeError>()(
  "AutomationResumeError",
  { detail: Schema.String },
) {
  override get message() {
    return `Could not resume automation: ${this.detail}`;
  }
}
