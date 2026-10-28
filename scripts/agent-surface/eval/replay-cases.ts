import type { ReplayCase } from "./replay.ts";

export const REPLAY_VERSION = 3;
const pr = "https://github.com/example/replay-fixture/pull/124";
const threadId = "11111111-1111-4111-8111-111111111111";

export const replayCases: ReadonlyArray<ReplayCase> = [
  {
    id: "review-round-creates-new-task",
    upstreamId: "review-round-uses-thread-send",
    role: "top",
    experience:
      "A second review round continued the old child thread and lost its task relationship.",
    priorTurns: [
      {
        role: "user",
        text: "Get a delegated review of the cache migration. Repeat after fixing findings.",
      },
      {
        role: "assistant",
        text: "Round one found that the cache migration discards version-four entries. That is now fixed.",
        calls: [
          {
            tool: "goat_task_read",
            input: { taskId: "review-1" },
            result: {
              taskId: "review-1",
              childThreadId: threadId,
              status: "completed",
              summary: "The cache migration discards version-four entries.",
            },
          },
        ],
      },
    ],
    prompt:
      "Run round two with a new delegated review task. Include the cache finding and the fix.",
    expect: {
      calls: [{ tool: "task.create", args: { role: "review", task: "~cache" } }],
      notCalls: ["thread.send"],
    },
  },
  {
    id: "async-delegate-ends-turn",
    upstreamId: "async-delegate-then-end-turn",
    role: "top",
    experience: "An agent polled after starting async work even though GOAT delivers completion.",
    priorTurns: [],
    prompt:
      "Start a GOAT delegated research task to compare the two cache designs, then wait for its automatic delivery.",
    expect: {
      calls: [{ tool: "task.create", args: { mode: "async" } }],
      notCalls: ["task.read", "thread.wait"],
      endsTurnAfter: "task.create",
      shellMustNot: ["\\bsleep\\b", "inotifywait|fswatch"],
    },
  },
  {
    id: "delegate-uses-managed-worktree",
    upstreamId: "worktree-add-for-parallel-pr-delegates",
    role: "top",
    experience: "A parent created an unmanaged worktree for a child implementation lane.",
    priorTurns: [],
    prompt:
      "Delegate the cache fix to a GOAT child with its own isolated checkout. GOAT should manage the checkout.",
    expect: {
      calls: [{ tool: "task.create", args: { isolation: "worktree" } }],
      callsMustNot: [
        { tool: "task.create", args: { task: "~git worktree add" } },
        { tool: "task.create", args: { task: "~git clone" } },
      ],
      notCalls: ["thread.launch"],
      shellMustNot: ["git\\s+worktree\\s+add", "git\\s+clone"],
    },
  },
  {
    id: "child-links-without-watching",
    upstreamId: "child-pushes-existing-pr-links",
    role: "delegated-child",
    experience:
      "A delegated implementation child watched checks instead of reporting to its parent.",
    priorTurns: [
      {
        role: "assistant",
        text: `The authorized fix was pushed to ${pr}, head abcdef1234567890. No checks have run yet.`,
      },
    ],
    prompt:
      "Link the PR you pushed and report its URL, head and check state to your parent. Do not wait for CI.",
    expect: {
      calls: [{ tool: "pull_request.link", args: { url: pr } }],
      notCalls: ["pull_request.watch"],
      shellMustNot: [
        "\\bsleep\\b",
        "gh pr checks[^\\n]*--watch",
        "gh run watch",
        "\\buntil\\b[^\\n]*\\bgh (pr|run|api)\\b",
        "\\bfor \\w+ in [^\\n]*;\\s*do[^\\n]*\\bgh pr checks\\b",
        "pr-wait",
      ],
      textMust: ["https://github\\.com/example/replay-fixture/pull/124", "abcdef1234567890"],
    },
  },
  {
    id: "review-only-does-not-link-pr",
    upstreamId: "review-child-links-reviewed-pr",
    role: "delegated-child",
    experience: "A reviewer linked a PR it only read, making the thread appear to own that work.",
    priorTurns: [
      {
        role: "assistant",
        text: `I read the diff of ${pr}. The cache key includes the version and the migration preserves entries. No findings.`,
      },
    ],
    prompt:
      "Finish your read-only review with a verdict. Do not push or take ownership of this PR.",
    expect: {
      notCalls: ["pull_request.link", "pull_request.watch", "pull_request.list"],
      shellMustNot: ["git\\s+push", "gh pr (create|merge)"],
      textMust: ["[Nn]o findings|PASS"],
    },
  },
  {
    id: "thread-read-returns-link",
    upstreamId: "thread-mention-without-link-after-read",
    role: "top",
    experience: "An agent mentioned a thread it read without a clickable GOAT thread link.",
    priorTurns: [],
    prompt: `Read the latest messages of thread ${threadId}, summarize them, and link the thread. Read at most twenty items.`,
    expect: {
      calls: [{ tool: "thread.read", args: { threadId, limit: "<=20" } }],
      textMust: [`goat-thread://v1/${threadId}`],
    },
  },
  {
    id: "preview-before-render",
    upstreamId: "render-without-html-preview",
    role: "top",
    experience:
      "An agent published an inline visualization without first checking the HTML preview.",
    priorTurns: [],
    prompt:
      "Make an inline HTML diagram of the cache flow. Check the preview before publishing it in this conversation.",
    expect: {
      calls: [{ tool: "html.preview" }, { tool: "html.render" }],
      order: ["html.preview", "html.render"],
      maxCalls: { "html.render": 1 },
      shellMustNot: ["http\\.server", "npx (serve|http-server)"],
    },
  },
];
