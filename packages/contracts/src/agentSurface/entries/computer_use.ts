import { entry } from "../entry.ts";

export const computerUseEntries = {
  "computer_use.request": entry({
    resource: "computer_use",
    verb: "request",
    name: "goat_computer_use_request",
    toolkit: "computerUse",
    summary:
      "Ask a person to admit this thread to apps or the screen of this host until a set time.",
    description:
      "Ask a person to admit this thread to the apps it names, or the whole screen of this host, until an expiry. End this turn after asking. Admission covers the thread’s turns until expiry. Default background-only; foreground:true asks for whole-desktop focus authority with apps omitted.",
    guide:
      "The tools are cua-driver, reached through GOAT's proxy. A person-directed turn can attach them without an admission handoff, within its app scope. A call to another app's window is refused with appNotAllowed; an app-scoped control cannot act on the whole desktop. Ask with apps set to the bundle_id list_apps reports for background access to those apps. Unattended origins include GOAT Bot and channel tasks, scheduled or webhook-triggered work, and threads launched or messaged by unattended threads; such turns need an approved admission before any tool attaches. All attachments still require an enabled and available driver, a supported provider, a non-plan interaction mode and write access. Background admission does not permit focus changes. Use foreground:true with apps omitted to request whole-desktop permission to bring apps forward and take keyboard or pointer focus for the exact stated purpose until expiry. An apps list, even empty, is refused with foreground:true. Opaque scripts and batches also require this approval. Pause, Stop, takeover or control replacement revokes foreground authority; ask again. Never restore focus over a newer human choice. The request returns a needs_human handoff for a person using a GOAT client with orchestration:operate and settings:write; a chat-channel reply cannot grant admission. A person can end admission early, press Stop, stop every thread on the host, or take the screen over: refusals say userStoppedSession or userIntervened, and after any refusal observe again before acting. A call already sent to the driver when control is interrupted returns code interrupted. If its effect is unverifiable, it may already have changed the computer: observe the window before deciding what to do next and never resend that action unchanged. An interrupted read needs a fresh read before acting. Under approved apps, launch_app works only on macOS and only with an approved bundle_id. Threads admitted to different apps hold admission at once. A request naming an app another thread holds, or asking for the whole screen while another thread holds any app (or the reverse), is refused naming the holder and the apps in the way; ask for other apps or after it ends. While another thread holds apps on the host, calls that bring a window forward, move the pointer or use foreground delivery are refused with targetRefused (detail screen_shared): act in the background or through an element. The expiry begins when the request is created, so approval does not restart the requested duration.",
    effect: "write",
    capability: "none",
    capabilityReason: "Asks a person, who decides whether to admit the thread.",
    idempotencyReason:
      "Pending requests with the same purpose, duration and delivery mode reuse this thread’s existing computer-use handoff; background requests reuse an admission that covers their apps; foreground requests also require live approval for that exact purpose.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
} as const;
