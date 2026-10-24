import { entry } from "../entry.ts";

export const pullRequestEntries = {
  "pull_request.link": entry({
    resource: "pull_request",
    verb: "link",
    name: "link_pull_request",
    toolkit: "pullRequests",
    summary: "Link pull request to thread",
    description:
      "Register every pull request you open or work on with this thread so GOAT tracks it; for a stack, link every layer. New agent links normally start an automatic watch; use goat_pull_request_watch to make the watch explicit.",
    guide:
      "Provide its URL or its repository and number. Linking an existing visible link succeeds with alreadyLinked=true. The thread displays tracked status and can settle when its linked work merges, subject to settlement settings and remaining open links. Automatic watches are enabled by default and do not keep the thread in the user’s Working list.",
    effect: "write",
    capability: "pr.open",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "Linking a pull request that is already linked succeeds with alreadyLinked and changes nothing.",
    annotations: {
      title: "Link pull request to thread",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "pull_request.unlink": entry({
    resource: "pull_request",
    verb: "unlink",
    name: "unlink_pull_request",
    toolkit: "pullRequests",
    summary: "Unlink pull request from thread",
    description:
      "Remove a pull request link from this thread. This does not close the pull request.",
    guide:
      "Provide its URL or its repository and number. Use this to remove an accidental link after closing a mistakenly opened pull request. A target absent from the thread succeeds with wasLinked=false. Stack members may remain internally marked as dismissed so stack synchronization does not show them again.",
    effect: "destructive",
    capability: "pr.open",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "Unlinking a pull request that is not linked succeeds with wasLinked false and changes nothing.",
    annotations: {
      title: "Unlink pull request from thread",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "pull_request.list": entry({
    resource: "pull_request",
    verb: "list",
    name: "list_thread_pull_requests",
    toolkit: "pullRequests",
    summary: "List thread pull requests",
    description:
      "List a thread’s linked pull requests with their last known host state and stack order from bottom to top.",
    guide:
      "Omit threadId to read this thread. Register each pull request and stack layer with goat_pull_request_link immediately after creating it. These are stored snapshots, so the response does not fetch fresh host status.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List thread pull requests",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "pull_request.watch": entry({
    resource: "pull_request",
    verb: "watch",
    name: "watch_pull_request",
    toolkit: "pullRequests",
    summary: "Watch pull request",
    description:
      "Watch a pull request for this thread, linking it if needed, and wake on policy-selected news. Handle existing comments first, then end your turn; do not poll. Recheck merge readiness after waking. Call goat_pull_request_unwatch when handing work back to the user.",
    guide:
      "This makes the watch explicit and keeps the thread in the user’s Working list; automatic watches started on create or agent-link do not. GOAT sweeps watches every two minutes but may reuse unchanged host data, delaying a fresh activity read. react starts a turn, keep_as_context records context for a later wake without starting a turn, and ignore drops the update. Defaults wake on failing checks, a passing required-check gate (or all checks when none are marked required), and other people’s comments or reviews. By default bot comments are ignored (the policy botRemarks), unless the login is listed in Settings under Bots that count as people. Conflicts do not wake threads idle for more than three days by default. A fresh watch starts its remark watermark at the watch start; a repeated call that already has a watch preserves its progress, and edits to older comments can count as new activity. A wake reports news rather than deciding to merge. Watches end on merge or close, thread settlement or archival, user Stop, explicit unwatch, eight consecutive non-rate-limit read failures, or ten consecutive comment-only wakes with no check, conflict, or push progress. Rate limits delay reads rather than count as failures. Unsettle and unarchive the thread before starting a new watch. Subagents cannot watch; their parent owns the pull request.",
    effect: "write",
    capability: "pr.open",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason: "Watching a pull request this thread already watches keeps the one watch.",
    annotations: {
      title: "Watch pull request",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
  "pull_request.unwatch": entry({
    resource: "pull_request",
    verb: "unwatch",
    name: "unwatch_pull_request",
    toolkit: "pullRequests",
    summary: "Stop watching pull request",
    description:
      "Stop an automatic or explicit pull request watch for this thread while keeping the pull request linked.",
    guide:
      "Provide its URL or its repository and number. Use this when returning the work to the user.",
    effect: "write",
    capability: "pr.open",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason: "Unwatching a pull request with no watch changes nothing.",
    annotations: {
      title: "Stop watching pull request",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
