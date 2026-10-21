/**
 * What GOAT Bot can look up before it answers: its own memory (notes, journal, GOAT memory) and
 * the record of the work it started. These are the pure parts: who may see a task, which tasks a
 * query means, and how each result is cut to size. ChannelReceptionService runs the reads.
 *
 * @module channelBotRecall
 */
import type {
  ChannelConversationId,
  ChannelRequester,
  ChannelTask,
  ChannelTaskPullRequest,
} from "@goat/contracts";
import { channelEvidenceLabels } from "@goat/shared/channelEvidence";

/** Each read result is cut to this many characters before a pass sees it. */
export const RECALL_RESULT_CHARS = 4_000;
/** At most this many tasks answer one work read. */
export const RECALL_TASK_LIMIT = 5;
/** How many of the owner's newest tasks a work read searches. */
export const RECALL_TASK_SCAN = 200;
/** How many of a thread's newest messages a thread read returns. */
export const RECALL_THREAD_MESSAGES = 6;
/** How many of a thread's newest runs a thread read loads messages from. */
export const RECALL_THREAD_RUNS = 3;
const RECALL_MESSAGE_CHARS = 700;
const RECALL_FIELD_CHARS = 600;
/** At most this many memory lines or items answer one memory read. */
export const RECALL_MEMORY_LINES = 12;
/** How many of the newest visible tasks the journal shows, and its size in characters. */
export const JOURNAL_ENTRIES = 15;
export const JOURNAL_CHARS = 3_000;
const JOURNAL_RESULT_CHARS = 160;

/**
 * Whether a requester may see a task in GOAT Bot's answers. Everyone sees the work of the
 * conversation they are in. A person also sees work they asked for elsewhere, and all of the
 * owner's work when they may read GOAT's threads anyway. Agents over MCP see only their own
 * conversation, because their conversations are scoped to the agent.
 */
export const canSeeTask = (
  viewer: ChannelRequester,
  task: ChannelTask,
  conversationId: ChannelConversationId,
): boolean => {
  if (viewer.ownerId !== task.requester.ownerId) return false;
  if (task.conversationId === conversationId) return true;
  if (viewer.originKind === "mcp") return false;
  return (
    viewer.principalId === task.requester.principalId ||
    viewer.grantedScopes.includes("orchestration:read")
  );
};

const cut = (text: string, chars: number) =>
  text.length <= chars ? text : text.slice(0, chars - 1).trimEnd() + "…";

export const pullRequestLabel = (pr: ChannelTaskPullRequest) =>
  pr.repository + "#" + pr.number + " (" + (pr.state ?? "state unknown") + ")";

/** English filler that would otherwise match every task; other languages rarely collide. */
const FILLER = new Set(
  "the and for with what that this did does was were has have had about from into what's when where which who how why is it its are any all our you your can".split(
    " ",
  ),
);

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}#_./-]+/u)
    .filter((word) => word.length >= 2 && !FILLER.has(word));

/**
 * A pull request named in a query: a URL or "owner/repo#123" names its repository, while a bare
 * "#123" or "123" names only the number and may match several repositories.
 */
const pullRequestIn = (
  query: string,
): { readonly number: number; readonly repository?: string } | undefined => {
  const url = /([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/u.exec(query);
  if (url !== null) return { repository: url[1]!.toLowerCase(), number: Number(url[2]) };
  const named = /([\w.-]+\/[\w.-]+)#(\d+)\b/u.exec(query);
  if (named !== null) return { repository: named[1]!.toLowerCase(), number: Number(named[2]) };
  const bare = /#(\d+)\b/u.exec(query) ?? /^\s*(\d+)\s*$/u.exec(query);
  return bare === null ? undefined : { number: Number(bare[1]) };
};

/**
 * The tasks a query means, best first: an exact task id, then a pull request number or URL the
 * task linked, then the tasks sharing the most words with the query. An empty or generic query
 * returns the newest tasks.
 */
export const matchTasks = (
  tasks: ReadonlyArray<ChannelTask>,
  query: string,
  limit = RECALL_TASK_LIMIT,
): ReadonlyArray<ChannelTask> => {
  const trimmed = query.trim();
  const exact = tasks.filter((task) => task.taskId === trimmed);
  if (exact.length > 0) return exact;
  const pr = pullRequestIn(trimmed);
  if (pr !== undefined) {
    const linked = tasks.filter((task) =>
      (task.observed?.pullRequests ?? []).some(
        (linkedPr) =>
          linkedPr.number === pr.number &&
          (pr.repository === undefined || linkedPr.repository.toLowerCase() === pr.repository),
      ),
    );
    // A question about a repository's pull request is not about other work sharing its words.
    if (linked.length > 0 || pr.repository !== undefined) return linked.slice(0, limit);
  }
  const wanted = new Set(words(trimmed));
  if (wanted.size === 0) return tasks.slice(0, limit);
  return tasks
    .map((task, index) => {
      const haystack = new Set(
        words(
          [
            task.title,
            task.instruction,
            task.resultSummary ?? "",
            task.host ?? "",
            ...(task.observed?.pullRequests ?? []).map((pr) => pr.repository + " " + pr.url),
          ].join(" "),
        ),
      );
      let score = 0;
      for (const word of wanted) if (haystack.has(word)) score += 1;
      return { task, index, score };
    })
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((entry) => entry.task);
};

/** One task as GOAT Bot reads it back: what was asked, where it ran, and how it ended. */
export const taskDigest = (task: ChannelTask): string => {
  const prs = (task.observed?.pullRequests ?? []).map(pullRequestLabel);
  const lines = [
    "task " + task.taskId + " [" + task.status + "] " + task.title,
    "  asked by " + task.requester.displayName + " on " + task.createdAt.slice(0, 16),
    ...(task.host === undefined && task.worker?.host === undefined
      ? []
      : ["  runs on " + (task.worker?.host ?? task.host)]),
    "  request: " + cut(task.instruction.replace(/\s+/gu, " "), RECALL_FIELD_CHARS),
    ...(task.resultSummary === undefined || task.resultSummary.trim() === ""
      ? []
      : ["  result: " + cut(task.resultSummary, RECALL_FIELD_CHARS)]),
    ...(task.completionReport === "missing"
      ? ["  the worker ended without filing a final report"]
      : []),
    ...(prs.length === 0 ? [] : ["  pull requests: " + prs.join(", ")]),
    ...channelEvidenceLabels(task.observed?.result).map((label) => "  " + label),
    ...task.openQuestions.map((question) => "  open question: " + question.text),
    ...(task.completedAt === undefined ? [] : ["  ended " + task.completedAt.slice(0, 16)]),
  ];
  return lines.join("\n");
};

/**
 * GOAT Bot's journal as one requester may see it: one line per task, newest first, from the
 * ledger. Built per requester so it never shows work `canSeeTask` hides, and never written to
 * a file, so it cannot drift from the ledger or lose an entry in a crash.
 */
export const journalFor = (
  tasks: ReadonlyArray<ChannelTask>,
  entries = JOURNAL_ENTRIES,
  chars = JOURNAL_CHARS,
) => {
  const lines: Array<string> = [];
  let used = 0;
  for (const task of tasks
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, entries)) {
    const prs = (task.observed?.pullRequests ?? []).map(pullRequestLabel);
    const line =
      "- " +
      task.updatedAt.slice(0, 16).replace("T", " ") +
      " [" +
      task.status +
      "] " +
      task.title +
      (task.requester.displayName === "" ? "" : " (for " + task.requester.displayName + ")") +
      (task.resultSummary === undefined || task.resultSummary.trim() === ""
        ? ""
        : " — " + cut(task.resultSummary.replace(/\s+/gu, " ").trim(), JOURNAL_RESULT_CHARS)) +
      (prs.length === 0 ? "" : " — " + prs.join(", ")) +
      (task.observed?.result === undefined
        ? ""
        : " — " + channelEvidenceLabels(task.observed.result).join("; "));
    if (used + line.length + 1 > chars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
};

/** Lines of the notes and journal that share a word with the query, newest first. */
export const matchMemoryLines = (text: string, query: string, limit = RECALL_MEMORY_LINES) => {
  const wanted = words(query);
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const matched =
    wanted.length === 0
      ? lines
      : lines.filter((line) => {
          const lower = line.toLowerCase();
          return wanted.some((word) => lower.includes(word));
        });
  return matched.toReversed().slice(0, limit);
};

export interface RecallMessage {
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly createdAt: string;
}

/**
 * The newest messages of a thread that fit in `budget` characters, shown oldest first. Messages
 * are taken from the newest backward, so the latest answer is the last thing cut.
 */
export const threadDigest = (
  title: string,
  messages: ReadonlyArray<RecallMessage>,
  budget: number = RECALL_RESULT_CHARS,
) => {
  const rendered = messages
    .filter((message) => message.role !== "system" && message.text.trim() !== "")
    .slice(-RECALL_THREAD_MESSAGES)
    .map(
      (message) =>
        "- " +
        message.createdAt.slice(0, 16) +
        " " +
        (message.role === "user" ? "request" : "agent") +
        ": " +
        cut(message.text.replace(/\s+/gu, " ").trim(), RECALL_MESSAGE_CHARS),
    );
  const kept: Array<string> = [];
  let used = 80 + title.length;
  for (const line of rendered.toReversed()) {
    if (used + line.length + 1 > budget) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  return [
    "thread " + JSON.stringify(title) + ", newest " + kept.length + " messages:",
    ...kept,
  ].join("\n");
};

/** A read result cut to RECALL_RESULT_CHARS, keeping its start. */
export const boundRecall = (text: string) => cut(text, RECALL_RESULT_CHARS);
