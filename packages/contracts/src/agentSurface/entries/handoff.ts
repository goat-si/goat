import { entry } from "../entry.ts";

export const handoffEntries = {
  "handoff.create": entry({
    resource: "handoff",
    verb: "create",
    name: "request_secret",
    toolkit: "orchestrator",
    summary: "Request a secret from the user",
    description:
      "Ask for a secret through a private card in this thread, returning only a one-use secretRef. With wait:false, collect the answer using the same clientRequestId before the turn ends. Keep secrets out of chat and never invent them.",
    guide:
      "The card accepts tokens, API keys, signing secrets and passwords. By default the call waits for an answer; wait:false normally returns a pending needs_human handoff immediately, but falls back to waiting if the card has no handoff. An active run owned by this MCP provider session is required. A saved value stays in the server secret store and never appears in the tool result or transcript. Pass the reference to a tool that consumes it, such as goat_schedule_create’s signature.secretRef. For a sign-in page, set origin and pass a single-secret ref to goat_preview_fill_secret. For a username and password, request kind login and pass its ref to goat_preview_fill_login; login refs are bound to the requesting thread and origin. For a payment card, request kind card with origin and pass its ref to goat_preview_fill_card. Successful consumption deletes the saved value; unused references expire after 24 hours. A person cannot answer a pending request once its run has ended.",
    parameters: { placeholder: "Hint shown in the empty field, such as whsec_..." },
    examples: [
      {
        title: "Ask the user for a webhook signing secret",
        args: {
          label: "GitHub webhook secret",
          reason:
            "Signs GitHub's webhook deliveries. Copy it from the repository's Settings → Webhooks.",
        },
      },
    ],
    effect: "write",
    capability: "none",
    capabilityReason: "Asks a person for a secret; the person decides.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["secret"],
    idempotency: "domain",
    idempotencyReason:
      "clientRequestId names the request's card, so a repeat collects the same request's answer instead of asking again.",
    annotations: {
      title: "Request a secret from the user",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
