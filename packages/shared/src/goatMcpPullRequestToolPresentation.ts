import { tool } from "./goatMcpToolDefinition.ts";

export const pullRequestToolDefinitions = {
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Unwatching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started writing", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  goat_pull_request_read: tool(
    ["Read", "Reading", "Read", "a pull request"],
    "read-pr",
    "pull-request",
  ),
  goat_pull_request_checks: tool(
    ["Check", "Checking", "Checked", "pull request checks"],
    "read-pr-checks",
    "pull-request",
  ),
  goat_pull_request_activity: tool(
    ["Read", "Reading", "Read", "pull request activity"],
    "read-pr",
    "pull-request",
  ),
  goat_pull_request_review_thread: tool(
    ["Read", "Reading", "Read", "a review thread"],
    "read-pr",
    "pull-request",
  ),
  goat_pull_request_file: tool(
    ["Read", "Reading", "Read", "a pull request file"],
    "read-pr",
    "pull-request",
  ),
  goat_pull_request_stats: tool(
    ["Read", "Reading", "Read", "pull request line counts"],
    "read-pr",
    "pull-request",
  ),
  goat_pull_request_search: tool(
    ["Search", "Searching", "Searched", "pull requests"],
    "search-prs",
    "pull-request",
  ),
  goat_pull_request_filter_options: tool(
    ["List", "Listing", "Listed", "pull request filters"],
    "search-prs",
    "pull-request",
  ),
  goat_pull_request_update: tool(
    ["Update", "Updating", "Accepted changes to", "a pull request"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_comment: tool(
    ["Comment on", "Commenting on", "Accepted a comment on", "a pull request"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_comment_update: tool(
    ["Edit", "Editing", "Accepted changes to", "a pull request comment"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_review_submit: tool(
    ["Submit", "Submitting", "Accepted submission of", "a pull request review"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_thread_reply: tool(
    ["Reply to", "Replying to", "Accepted a reply to", "a review thread"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_thread_resolve: tool(
    ["Set resolution of", "Setting resolution of", "Accepted resolution of", "a review thread"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_react: tool(
    ["Set", "Setting", "Accepted", "a pull request reaction"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_labels: tool(
    ["Set", "Setting", "Accepted changes to", "pull request labels"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_reviewers: tool(
    ["Set", "Setting", "Accepted changes to", "pull request reviewers"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_action: tool(
    ["Change", "Changing", "Accepted changes to", "pull request state"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_merge: tool(
    ["Request merge of", "Requesting merge of", "Accepted merge request for", "a pull request"],
    "write-pr",
    "pull-request",
  ),
  goat_pull_request_close: tool(
    ["Close", "Closing", "Accepted closure of", "a pull request"],
    "write-pr",
    "pull-request",
  ),
};
