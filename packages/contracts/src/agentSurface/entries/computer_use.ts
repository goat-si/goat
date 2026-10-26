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
      "Ask a person to admit this thread to apps or the whole screen until expiry. With cua-driver tools attached, wait for the answer in this turn; otherwise end the turn for admission. Admission covers this thread until expiry. Default background-only; foreground:true requests desktop focus with apps omitted. Person-directed full-access turns need no request.",
    guide:
      "The tools are cua-driver, reached through GOAT's proxy. A person-directed turn can attach them without an admission handoff, within its app scope. Any turn in full access uses every app without a request, whoever or whatever started it. A person-directed full-access turn also gets foreground input without a request, including on approval wakes; other full-access turns ask for foreground input. A call to another app's window is refused with appNotAllowed; an app-scoped control cannot act on the whole desktop. Ask with apps set to the bundle_id list_apps reports for background access to those apps. Unattended origins include GOAT Bot and channel tasks, scheduled or webhook-triggered work, and threads launched or messaged by unattended threads; outside full access such turns need an approved admission before any tool attaches. All attachments still require an enabled and available driver, a supported provider, a non-plan interaction mode and write access. Background admission does not permit focus changes. Use foreground:true with apps omitted to request whole-desktop permission to bring apps forward and take keyboard or pointer focus for the exact stated purpose until expiry. An apps list, even empty, is refused with foreground:true. Opaque scripts and batches also require foreground authority. Tell the person before foreground input that it can briefly take and return the screen for the approved purpose. Pause, Stop, takeover, turn end or control replacement revokes foreground authority. After pause or Stop, full-access foreground returns automatically only on the next turn; respect the interruption in this turn. Other turns need a new foreground approval. GOAT never sends a focus-restoring command when authority is released. Only driver 0.37.0 restoration inside one native foreground primitive already dispatched under live approval is excepted: macOS foreground-assist or browser-typing reactivation, and Windows keyboard foreground drain. No later script step, GOAT cleanup or agent-issued restoration is exempt. Never restore focus yourself over a newer human choice. A person using a GOAT client with orchestration:operate and settings:write answers the request; a chat-channel reply cannot grant admission. With cua-driver tools attached, the call waits up to 10 minutes, never past expiry: approval returns kind available so this turn can continue. Refusals say declined, cancelled, expired, superseded (a newer request replaced it), or interrupted (computer use stopped, paused or ended). At the wait limit it returns needs_human with waitTimedOut:true; end the turn and GOAT wakes it after a later answer. Without tools attached, unattended work keeps the ask-and-end flow and receives tools on a later admitted turn. A person can end admission early, press Stop, stop every thread on the host, or take the screen over: refusals say userStoppedSession or userIntervened, and after any refusal observe again before acting. A call already sent to the driver when control is interrupted returns code interrupted. If its effect is unverifiable, it may already have changed the computer: observe the window before deciding what to do next and never resend that action unchanged. An interrupted read needs a fresh read before acting. Under approved apps, launch_app works only on macOS and only with an approved bundle_id. Threads admitted to different apps hold admission at once. A request naming an app another thread holds, or asking for the whole screen while another thread holds any app (or the reverse), is refused naming the holder and the apps in the way; ask for other apps or after it ends. While another thread holds apps on the host, calls that bring a window forward, move the pointer or use foreground delivery are refused with targetRefused (detail screen_shared): act in the background or through an element. The expiry begins when the request is created, so approval does not restart the requested duration.",
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
