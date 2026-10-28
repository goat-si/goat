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
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Link a pull request to this thread",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
    ],
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
    examples: [{ title: "List this thread's linked pull requests", args: {} }],
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
  "pull_request.read": entry({
    resource: "pull_request",
    verb: "read",
    name: "goat_pull_request_read",
    toolkit: "pullRequests",
    summary: "Read a pull request's current state from its host",
    description:
      "Read one pull request fresh from its host: title, body, state, mergeability, branches, reviewers, labels, checks and merge options. The repository must be a project checkout here. For check results alone use goat_pull_request_checks.",
    guide:
      "Pass url, or repository and number (host defaults to the matching project's). The pull request need not be linked to a thread. This asks the host each time, as the pull request view in the app does, with the project's own credential. goat_pull_request_watch wakes a thread on changes instead of reading repeatedly.",
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Read a pull request by URL",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
      {
        title: "Read a pull request by repository and number",
        args: { repository: "goat-si/goat", number: 2028 },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Read pull request",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "pull_request.checks": entry({
    resource: "pull_request",
    verb: "checks",
    name: "goat_pull_request_checks",
    toolkit: "pullRequests",
    summary: "Read a pull request's checks from its host",
    description:
      "Read a pull request's state and each check's status and conclusion fresh from its host. checks is null when the host reports none. The repository must be a project checkout here.",
    guide:
      "Pass url, or repository and number (host defaults to the matching project's). This asks the host each time, as the app's checks list does, with the project's own credential. To wait for checks to finish, use goat_pull_request_watch and end the turn instead of reading in a loop.",
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Read the checks on a pull request",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Read pull request checks",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "pull_request.activity": entry({
    resource: "pull_request",
    verb: "activity",
    name: "goat_pull_request_activity",
    toolkit: "pullRequests",
    summary: "Read a pull request's comments, review threads and commits from its host",
    description:
      "Read a pull request's conversation from its host: comments, review threads with their first comments, commits and reactions. Responses stay within 256 KiB; the *Omitted counts say what was left out.",
    guide:
      "Pass url, or repository and number (host defaults to the one project holding the repository). The host may already cut long conversations (commentsTruncated, reviewThreadsTruncated); this read then keeps the leading reviewers, comments, review threads, commits and reactions that fit 256 KiB together, in that order, and counts the rest in reviewersOmitted, commentsOmitted, reviewThreadsOmitted, commitsOmitted and reactionsOmitted. Continue one review thread with goat_pull_request_review_thread and its nextCommentsCursor.",
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Read the conversation on a pull request",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Read pull request activity", idempotentHint: true, openWorldHint: true },
  }),
  "pull_request.review_thread": entry({
    resource: "pull_request",
    verb: "review_thread",
    name: "goat_pull_request_review_thread",
    toolkit: "pullRequests",
    summary: "Read more comments of one pull request review thread",
    description:
      "Read the next page of comments in one review thread, from the nextCommentsCursor goat_pull_request_activity returned for it. Responses stay within 256 KiB; commentsOmitted counts comments left out of this page.",
    guide:
      "Pass url, or repository and number (host defaults to the one project holding the repository). Pass the thread's id and the cursor from goat_pull_request_activity, then nextCursor for the page after. When commentsOmitted is above zero, those comments of this page are not returned by any later page.",
    parameters: {
      url: "The pull request's URL, such as https://github.com/owner/repo/pull/12.",
      threadId: "The review thread's id from goat_pull_request_activity.",
      cursor:
        "nextCommentsCursor from goat_pull_request_activity, or nextCursor from the previous page.",
    },
    examples: [
      {
        title: "Read the rest of a review thread",
        args: {
          url: "https://github.com/goat-si/goat/pull/2028",
          threadId: "<reviewThreadId>",
          cursor: "<nextCommentsCursor>",
        },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Read pull request review thread",
      idempotentHint: true,
      openWorldHint: true,
    },
  }),
  "pull_request.file": entry({
    resource: "pull_request",
    verb: "file",
    name: "goat_pull_request_file",
    toolkit: "pullRequests",
    summary: "Read one changed file of a pull request before and after",
    description:
      "Read one changed file's contents before and after a pull request, or one of its commits. Each side is cut at 256 KiB; oldTruncated and newTruncated say when.",
    guide:
      "Pass url, or repository and number (host defaults to the one project holding the repository). Name the file as the pull request's diff does: changeType, oldPath and newPath (the same path unless renamed). Files outside the pull request's changes are refused.",
    parameters: {
      url: "The pull request's URL, such as https://github.com/owner/repo/pull/12.",
      commit: "A commit of the pull request to read instead of its whole change.",
      changeType:
        "change, new, deleted, rename-pure or rename-changed, as the diff lists the file.",
      oldPath: "The path before the change; the same as newPath unless renamed.",
      newPath: "The path after the change.",
    },
    examples: [
      {
        title: "Read a changed file",
        args: {
          url: "https://github.com/goat-si/goat/pull/2028",
          changeType: "change",
          oldPath: "apps/server/src/mcp/ToolAdmission.ts",
          newPath: "apps/server/src/mcp/ToolAdmission.ts",
        },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Read pull request file", idempotentHint: true, openWorldHint: true },
  }),
  "pull_request.search": entry({
    resource: "pull_request",
    verb: "search",
    name: "goat_pull_request_search",
    toolkit: "pullRequests",
    summary: "Search pull requests across this environment's projects",
    description:
      "Search pull requests in this environment's project repositories by state, involvement, filters or text, as the Pull requests view does. Returns up to limit rows per repository (default 10, at most 50).",
    guide:
      "Omit projectId to search every project. limit applies to each repository. When truncated is true, pass nextCursors back with the same arguments for the next page; repositories without a cursor are done. Each row's text is cut to 1 KiB of JSON and its lists to 20 items (rowsClipped), keeping ids, URLs, repositories and branches whole; read one with goat_pull_request_read for all of it. A page over 256 KiB is refused rather than cut, so narrow with projectId, query or filters, or lower limit. errors lists repositories that could not be read.",
    parameters: {
      state: "open, closed, merged or all.",
      involvement: "all (default), reviewing or authored, for the signed-in account.",
      filters:
        "{draft?, review?, checks?, labels?, excludedLabels?, author?} as the Pull requests view filters.",
      projectId: "One project to search. Default: every project.",
      query: "Text to match in titles.",
      limit: "Rows per repository, 1 to 50. Default 10.",
      cursors: "nextCursors from the previous result, with the same arguments.",
    },
    examples: [
      {
        title: "Find open pull requests that need my review",
        args: { state: "open", involvement: "reviewing" },
      },
      {
        title: "Search one project's pull requests by title",
        args: { state: "all", projectId: "<projectId>", query: "migration" },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Search pull requests", idempotentHint: true, openWorldHint: true },
  }),
  "pull_request.stats": entry({
    resource: "pull_request",
    verb: "stats",
    name: "goat_pull_request_stats",
    toolkit: "pullRequests",
    summary: "Read line counts for pull requests",
    description:
      "Read additions, deletions and changed files for up to 25 pull requests in one call.",
    guide:
      "Each entry takes url, or repository and number, like goat_pull_request_read. Repositories that are not a project here are refused.",
    parameters: {
      pullRequests: "1 to 25 pull requests, each {url} or {repository, number, host?}.",
    },
    examples: [
      {
        title: "Read line counts for two pull requests",
        args: {
          pullRequests: [
            { url: "https://github.com/goat-si/goat/pull/2028" },
            { url: "https://github.com/goat-si/goat/pull/2055" },
          ],
        },
      },
    ],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "Read pull request stats", idempotentHint: true, openWorldHint: true },
  }),
  "pull_request.filter_options": entry({
    resource: "pull_request",
    verb: "filter_options",
    name: "goat_pull_request_filter_options",
    toolkit: "pullRequests",
    summary: "List the labels or authors pull request search can filter by",
    description:
      "List the labels or authors found in this environment's project repositories, for goat_pull_request_search filters. At most 100; truncated says when more exist.",
    guide: "Omit projectId for every project. query narrows by name.",
    parameters: {
      kind: "labels or authors.",
      projectId: "One project. Default: every project.",
      query: "Text the names must contain.",
    },
    examples: [{ title: "List label names to filter by", args: { kind: "labels" } }],
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "List pull request filter options",
      idempotentHint: true,
      openWorldHint: true,
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
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Be woken on checks, reviews or conflicts",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
    ],
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
    parameters: { url: "The pull request's URL, such as https://github.com/owner/repo/pull/12." },
    examples: [
      {
        title: "Stop watching a merged pull request",
        args: { url: "https://github.com/goat-si/goat/pull/2028" },
      },
    ],
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
