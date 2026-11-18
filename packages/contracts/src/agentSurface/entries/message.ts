import { entry } from "../entry.ts";

export const messageEntries = {
  "message.show": entry({
    resource: "message",
    verb: "show",
    name: "goat_message_show",
    toolkit: "message",
    summary: "Show the user a mid-turn message",
    description:
      "Show Markdown in the calling thread before the turn ends. Use for text the user must read in full mid-turn. Put ordinary progress updates and final replies in assistant text.",
    effect: "write",
    capability: "none",
    capabilityReason: "Returns text to render in the calling thread's own tool result.",
    listing: "prompt",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Show the user a mid-turn message",
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
} as const;
