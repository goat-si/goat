import { entry } from "../entry.ts";

const target = { url: "https://github.com/sample-tools/goat/pull/42" };
const access =
  "Pass url, or repository and number (host defaults to the matching project's forge). Uses that project's credential without account pinning. Plan-mode threads and read-only credentials cannot write. Outside MCP clients need source-control:write and live reauthorization; read-only and reduced operate grants cannot write. ";
const retry =
  "The same principal, path and clientRequestId replays a stored receipt or reports unknown_outcome. Only completed reservations expire after 24 hours; unsettled ones remain. Outside clients are keyed by session, so a new session with the same key can post again. ";
const generative =
  "clientRequestId is required. On unknown_outcome, read pull_request.activity first, then pull_request.review_thread only with a returned nextCommentsCursor. Absence from truncated activity (commentsTruncated or commentsOmitted) is not proof nothing was posted. Never resend with a new key; tell the user if the outcome cannot be confirmed. ";

const write = <const Verb extends string>(
  verb: Verb,
  summary: string,
  description: string,
  reconcile: "pull_request.read" | "pull_request.activity",
  options: {
    readonly keyRequired?: true;
    readonly capability?: "pr.open" | "pr.merge";
    readonly guide?: string;
  } = {},
) =>
  entry({
    resource: "pull_request",
    verb,
    name: `goat_pull_request_${verb}` as const,
    toolkit: "pullRequests",
    summary,
    description,
    guide:
      access +
      retry +
      (options.keyRequired ? generative : `Read ${reconcile} to reconcile the result. `) +
      (options.guide ?? ""),
    effect: "write",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    capability: options.capability ?? "pr.open",
    idempotency: "key",
    reconcile,
    ...(options.keyRequired ? ({ keyRequired: true } as const) : {}),
    annotations: { idempotentHint: !options.keyRequired, openWorldHint: true },
  });

export const pullRequestWriteEntries = {
  "pull_request.update": write(
    "update",
    "Edit a pull request",
    "Update a pull request's title or body. Reconcile with pull_request.read.",
    "pull_request.read",
  ),
  "pull_request.comment": {
    parameters: { url: "Full pull request URL.", body: "Markdown comment body." },
    ...write(
      "comment",
      "Comment on a pull request",
      "Post a pull request comment. clientRequestId is required; retry with the same key. Reconcile unknown outcomes with pull_request.activity, then tell the user if unconfirmed.",
      "pull_request.activity",
      { keyRequired: true },
    ),
    examples: [
      {
        title: "Post a comment once",
        args: {
          ...target,
          body: "Checked the regression.",
          clientRequestId: "comment-regression-1",
        },
      },
    ],
  },
  "pull_request.comment_update": write(
    "comment_update",
    "Edit a pull request comment",
    "Update a conversation or review comment by commentId and kind. Read pull_request.activity for ids and reconciliation.",
    "pull_request.activity",
  ),
  "pull_request.review_submit": write(
    "review_submit",
    "Submit a pull request review",
    "Submit a verdict, body and inline comments. clientRequestId is required. GitLab may post only part of a review; reconcile with pull_request.activity and report unconfirmed outcomes.",
    "pull_request.activity",
    {
      keyRequired: true,
      guide:
        "GitLab sends a review as several requests and can partly post it. Its approve-only verdict is not visible in activity, so activity cannot confirm that approval. Do not treat unknown_outcome or a partially posted review as complete. If confirmation is unavailable, tell the user; do not submit again with a new key.",
    },
  ),
  "pull_request.thread_reply": write(
    "thread_reply",
    "Reply to a review thread",
    "Reply to a review thread. clientRequestId is required. Reconcile with pull_request.activity first; review_thread needs the cursor returned there.",
    "pull_request.activity",
    { keyRequired: true },
  ),
  "pull_request.thread_resolve": write(
    "thread_resolve",
    "Resolve or reopen a review thread",
    "Set resolved true or false on a review thread. Reconcile with pull_request.activity first; continue review_thread only with its returned cursor.",
    "pull_request.activity",
  ),
  "pull_request.react": write(
    "react",
    "Set a pull request reaction",
    "Add or remove a reaction with reacted. Omit subjectId to react to the pull request itself. Reconcile with pull_request.activity.",
    "pull_request.activity",
  ),
  "pull_request.labels": write(
    "labels",
    "Add or remove pull request labels",
    "Apply or remove the named labels with applied; other labels stay as they are. Reconcile with pull_request.read.",
    "pull_request.read",
  ),
  "pull_request.reviewers": write(
    "reviewers",
    "Request or withdraw pull request reviewers",
    "Request or withdraw the named reviewers with requested. Reconcile with pull_request.read.",
    "pull_request.read",
  ),
  "pull_request.action": write(
    "action",
    "Change pull request state",
    "Mark ready or draft, reopen, update the branch, or disable auto-merge. Reconcile with pull_request.read. Merge and close have separate tools requiring pr.merge.",
    "pull_request.read",
    {
      guide: "delete-branch, revert and approve-workflows are not exposed here.",
    },
  ),
  "pull_request.merge": write(
    "merge",
    "Request a pull request merge",
    "Request merge or enable auto-merge with auto:true. Requires pr.merge. The receipt says accepted; it does not prove merged. Read pull_request.read for state and autoMerge.",
    "pull_request.read",
    {
      capability: "pr.merge",
      guide:
        "Merge acts on the host's current head. For exact-head merges, use branch protection. The host may queue the merge; accepted never means merged.",
    },
  ),
  "pull_request.close": write(
    "close",
    "Close a pull request",
    "Close a pull request. Requires pr.merge. Read pull_request.read to confirm; reopen with pull_request.action action:reopen.",
    "pull_request.read",
    { capability: "pr.merge" },
  ),
} as const;
