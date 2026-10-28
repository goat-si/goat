import { entry } from "../entry.ts";
import { SCREEN_TARGET_API } from "../../screenTargetApi.ts";

export const screenEntries = {
  "surface.screen_run": entry({
    resource: "surface",
    verb: "screen_run",
    name: "goat_screen_run",
    toolkit: "screen",
    summary: "Run one bounded JavaScript cell against available screen targets.",
    description:
      "Run one bounded JavaScript cell against available GOAT browser tabs or admitted desktop apps. Input: code, an optional one-line title for the timeline row, optional reset and lowering-only limits. Returns receipts and availability; images are separate content blocks.",
    guide: `Call with {code:string, title?:string, reset?:boolean, limits?:Partial<ScreenRunLimits>}. title is one line (≤80 chars) saying what the cell does, such as "Terminal: run the tests"; it titles the cell's timeline row, so never put typed text, passwords or secrets in it. A mention is only a binding hint, never permission; browser and desktop admission are checked separately for each effect. If a dispatched input has an unknown outcome, re-observe before deciding whether to act again; do not replay the cell blindly.

${SCREEN_TARGET_API}`,
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
