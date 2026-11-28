import { entry } from "../entry.ts";

export const handoffEntries = {
  "handoff.create": entry({
    resource: "handoff",
    verb: "create",
    name: "request_secret",
    toolkit: "orchestrator",
    summary: "Request a secret from the user",
    description:
      "Ask for one standalone secret per private card; never combine separate secrets. Use kind login or card for those structured handoffs. Returns a one-use secretRef. With wait:false, collect the answer using the same clientRequestId before the turn ends. Keep secrets out of chat and never invent them.",
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
  "handoff.withdraw": entry({
    resource: "handoff",
    verb: "withdraw",
    name: "goat_handoff_withdraw",
    toolkit: "orchestrator",
    summary: "Withdraw an open approval this thread asked for",
    description:
      "Withdraw an approval this thread asked for that a person has not answered yet. A thread holds one open approval at a time: while one is open, asking for another is refused with the open one's handoffId. Withdraw it to ask for something else, or end the turn and wait for the answer.",
    guide:
      "Only the asking thread can withdraw its approval, and only while it is pending or opened. The card ends as cancelled by the agent, so the thread gets no wake for it and the person can no longer approve it. Computer use and browser tab requests keep their own flows and cannot be withdrawn here. An approval a person already answered stays as it is: an approved one remains usable for its change until that change succeeds once or the approval expires.",
    effect: "write",
    capability: "none",
    capabilityReason: "Ends only a request this thread made; it grants nothing.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "Withdrawing ends the card once; a repeat finds it already ended and changes nothing.",
    annotations: { title: "Withdraw an approval", idempotentHint: true, openWorldHint: false },
  }),
} as const;
