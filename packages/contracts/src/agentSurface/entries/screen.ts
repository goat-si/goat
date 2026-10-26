import { entry } from "../entry.ts";

export const screenEntries = {
  "surface.screen_run": entry({
    resource: "surface",
    verb: "screen_run",
    name: "goat_screen_run",
    toolkit: "screen",
    summary: "Run one bounded JavaScript cell against available screen targets.",
    description:
      "Run one bounded JavaScript cell against available GOAT browser tabs or admitted desktop apps. Input: code, optional reset and lowering-only limits. Returns receipts and availability; images are separate content blocks.",
    guide:
      "Call with {code:string, reset?:boolean, limits?:Partial<ScreenRunLimits>}. Discover available targets inside the cell, bind a tab or app by its live identity, await each effect, and inspect the journal. A mention is only a binding hint, never permission. Browser and desktop admission are checked separately for each effect. If a dispatched input has an unknown outcome, re-observe before deciding whether to act again; do not replay the cell blindly.",
    listing: "core",
    effect: "write",
    capability: "none",
    capabilityReason:
      "A live GOAT thread and each target's preview or computer-use admission bound the cell.",
    idempotencyReason:
      "A cell may contain input; after an unknown outcome inspect receipts and re-observe before acting again.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      title: "Run screen code",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
