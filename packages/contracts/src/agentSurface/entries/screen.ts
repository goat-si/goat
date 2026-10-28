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
      "Call with {code:string, reset?:boolean, limits?:Partial<ScreenRunLimits>}. Discover available targets inside the cell, bind a tab or app by its live identity, await each effect, and inspect the journal. A mention is only a binding hint, never permission. Browser and desktop admission are checked separately for each effect. If a dispatched input has an unknown outcome, re-observe before deciding whether to act again; do not replay the cell blindly. Cell API: screen.discover() -> {apps, windows, tabs}; screen.tab('<tabId>' | '<url>' | {tabId|url|mentionId}); screen.openTab({url}); screen.app({appId}). A tab has observe({interactiveOnly?, mode:'diff'?, scope?, screenshot?}) returning {elements:[{ref, role, name}], indexedText}; click({ref} | {point}); typeText({ref?, text}); setValue({ref, text}); pressKey({key, modifiers?}); scroll({ref?, deltaX?, deltaY?}); drag({sourceRef, targetRef}); select({ref, values}); waitFor({ref? | text? | urlIncludes? | loadState?}); read(); status(); claim(); navigate(url); back(); forward(); reload(); close(); keep(reason). Refs stay valid across in-page actions until the next observe or a navigation. Your own tabs need no claim(); claim() takes an unclaimed tab. A failed call throws a ScreenError {code, message, effectStarted, nextStep, safety} you can catch; later calls in that cell do not run, so observe in a new cell. screen.values persists between cells.",
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
