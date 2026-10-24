import * as Schema from "effect/Schema";

/** Why a browser tab refused an agent's request; each has the message the agent reads. */
export const PreviewAutomationControlReason = Schema.Literals([
  "agentMismatch",
  "humanControl",
  "tabRequired",
  "closed",
  "interrupted",
  "dialogPending",
  "tabLimit",
  "privateMode",
  "stopped",
]);
export type PreviewAutomationControlReason = typeof PreviewAutomationControlReason.Type;

const MESSAGES: Readonly<Record<PreviewAutomationControlReason, string>> = {
  agentMismatch: "This browser tab belongs to another agent session or a human. Open your own tab.",
  humanControl: "A human controls this browser tab. Wait until they release control.",
  tabRequired:
    'Multiple browser tabs belong to this session. Pass a tabId from goat_call {path:"preview.open"} or from the tabs listed by goat_call {path:"preview.status"}.',
  dialogPending:
    'A browser dialog is pending. Read goat_call {path:"preview.status"} and resolve it with goat_call {path:"preview.dialog"}.',
  tabLimit:
    'Too many server browser tabs are open. Close one with goat_call {path:"preview.close"}, or reuse a tabId from goat_call {path:"preview.status"} tabs.',
  closed: 'Tab closed. Call goat_call {path:"preview.open"}.',
  privateMode:
    "A password, one-time code or passkey prompt has focus, so this tab is private until a person leaves it. Do not retry now; take a fresh snapshot after they finish.",
  stopped:
    "A person stopped agent control of this browser tab. Do not continue in it until they hand it back.",
  interrupted: "Browser control changed. Take a fresh snapshot before trying again.",
};

export const previewControlMessage = (reason: PreviewAutomationControlReason | undefined) =>
  reason === undefined ? undefined : MESSAGES[reason];
