// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off globalTimers:off - a plain Node script that drives a GOAT server over MCP; no Effect runtime.
/**
 * Runs the goat_eval measurement campaign (docs/operations/agent-surface-eval.md).
 *
 *   node scripts/agent-surface/eval/run.ts --campaign <campaign.json> --dry-run
 *   GOAT_EVAL_ENDPOINT=http://127.0.0.1:<port>/mcp GOAT_EVAL_AUTHORIZATION="Bearer ..." \
 *     node scripts/agent-surface/eval/run.ts --campaign <campaign.json> [--tasks a,b] \
 *     [--include-manual] --live > runs.jsonl
 *
 * Without --live it validates the task set and the campaign and prints the schedule. With
 * --live each scheduled run launches a fresh thread on the eval server, waits for it, reads its
 * timeline, and prints one JSON row. Nothing is averaged here; report.ts does that.
 */
import * as NodeFS from "node:fs";

import {
  type Arm,
  type Campaign,
  CampaignError,
  type Cleanup,
  type Json,
  type JsonObject,
  type ObservedListing,
  type RunMetrics,
  type RunRow,
  type Task,
  type TimelineItem,
  answerInstruction,
  extractAnswer,
  listingMatches,
  nextUncountedRun,
  pendingChecks,
  render,
  runMetrics,
  sameModel,
  schedule,
  sumMetrics,
  validateCampaign,
  validateTaskSet,
} from "./core.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);
/** Later runs of one eval thread a run may take to answer, after its launched run. */
const MAX_FOLLOWUP_RUNS = 4;
/** How long the runner watches a quiet thread for a run that a delivery is about to start. */
const SETTLE_MS = 5000;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Client {
  readonly call: (name: string, args: JsonObject) => Promise<JsonObject>;
  /** Tool names tools/list gives this client, under the server's current listing. */
  readonly list: () => Promise<ReadonlyArray<string>>;
}

const connect = async (endpoint: string, authorization: string): Promise<Client> => {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 1;
  const post = async (method: string, params: JsonObject, id?: number) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
        ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(id === undefined ? {} : { id }) }),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    if (!response.ok) throw new Error(method + ": HTTP " + response.status);
    const text = await response.text();
    const payloads = (response.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as JsonObject)
      : text.trim() === ""
        ? []
        : [JSON.parse(text) as JsonObject];
    return payloads.find((payload) => payload["id"] === id);
  };
  const rpc = async (method: string, params: JsonObject) => {
    const id = nextId++;
    const message = await post(method, params, id);
    if (message === undefined) throw new Error(method + ": no response");
    if (message["error"] !== undefined)
      throw new Error(method + ": " + JSON.stringify(message["error"]));
    return message["result"] as JsonObject;
  };
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goat-agent-surface-eval", version: "1" },
  });
  protocolVersion = typeof init["protocolVersion"] === "string" ? init["protocolVersion"] : null;
  await post("notifications/initialized", {});
  return {
    call: async (name, args) => {
      const result = await rpc("tools/call", { name, arguments: args });
      const content = result["content"] as ReadonlyArray<{ type: string; text?: string }>;
      const text = content?.find((item) => item.type === "text")?.text ?? "";
      if (result["isError"] === true) throw new Error(name + ": " + text.slice(0, 300));
      return (
        (result["structuredContent"] as JsonObject | undefined) ?? (JSON.parse(text) as JsonObject)
      );
    },
    list: async () =>
      asObjects((await rpc("tools/list", {}))["tools"]).map((tool) => String(tool["name"])),
  };
};

interface Context {
  readonly client: Client;
  readonly campaign: Campaign;
  readonly task: Task;
  readonly tag: string;
  readonly residents: Residents;
  /** Threads a fixture has started for this run, recorded as each launch returns. */
  readonly owned: Array<string>;
}
type Fixture = Readonly<Record<string, string>>;

const asObjects = (value: Json | undefined): ReadonlyArray<JsonObject> =>
  Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

const FIXTURES: Readonly<Record<string, (context: Context) => Promise<Fixture>>> = {
  none: async () => ({}),
  // The "[eval" prefix keeps threads a run starts out of the read control's fixture.
  titleTag: async ({ task, tag }) => ({
    "fixture.title": "[eval-fixture] fx-" + tag,
    "fixture.message": String(task.fixture["message"]),
  }),
  static: async ({ task }) =>
    Object.fromEntries(
      Object.entries(task.fixture).flatMap(([key, value]) =>
        key !== "kind" && typeof value === "string" ? [["fixture." + key, value]] : [],
      ),
    ),
  existingThread: async ({ client, campaign }) => {
    // Runs add eval threads at the top of the list, so the oldest page holds the stable one.
    let thread: JsonObject | undefined;
    let cursor: Json | undefined;
    do {
      const listed = await client.call("goat_thread_list", {
        projectId: campaign.projectId,
        statuses: ["completed"],
        // A delegated child can be listed yet refuse goat_thread_read, which turns the
        // one-call control into a retry.
        includeSubagents: false,
        limit: 100,
        ...(cursor === undefined ? {} : { cursor }),
      });
      thread = asObjects(listed["threads"]).find(
        (item) => typeof item["title"] === "string" && !item["title"].startsWith("[eval"),
      );
      cursor = listed["nextCursor"] ?? undefined;
    } while (thread === undefined && cursor !== undefined);
    if (thread === undefined) throw new Error("the eval project has no completed thread to read");
    await client.call("goat_thread_read", { threadId: String(thread["threadId"]), limit: 1 });
    return {
      "fixture.threadId": String(thread["threadId"]),
      "fixture.title": String(thread["title"]),
    };
  },
  runningThreads: async ({ client, campaign, task, tag, owned }) => {
    const count = Number(task.fixture["count"]);
    const titleTag = "fx-" + tag;
    const ids: Array<string> = [];
    for (let index = 0; index < count; index++) {
      const launched = await client.call("goat_thread_launch", {
        title: "[eval-fixture] " + titleTag + " " + (index + 1),
        projectId: campaign.projectId,
        message: String(task.fixture["message"]),
        modelSelection: { ...campaign.fixtureModel },
        notifyOnCompletion: false,
      });
      ids.push(String(launched["threadId"]));
      owned.push(String(launched["threadId"]));
    }
    return { "fixture.titleTag": titleTag, "fixture.threadIds": ids.join(",") };
  },
};

interface CheckInput extends Context {
  readonly answer: JsonObject;
  readonly fixture: Fixture;
  readonly metrics: RunMetrics;
}

const latestRun = async (client: Client, threadId: string) => {
  const read = await client.call("goat_thread_read", { threadId, limit: 1, runLimit: 1 });
  return asObjects(read["recentRuns"])[0] ?? null;
};

/** Each check returns why the run is wrong, or nothing when the server agrees with the answer. */
const CHECKS: Readonly<Record<string, (input: CheckInput) => Promise<ReadonlyArray<string>>>> = {
  answerTitle: async ({ answer, fixture }) =>
    answer["title"] === fixture["fixture.title"] ? [] : ["the title does not match the thread"],
  threadLaunchedAsAsked: async ({ client, campaign, answer, fixture }) => {
    const title = fixture["fixture.title"];
    const listed = await client.call("goat_thread_list", {
      projectId: campaign.projectId,
      titleContains: String(title),
      limit: 100,
    });
    const launched = asObjects(listed["threads"]).filter((thread) => thread["title"] === title);
    // A second launch is a duplicated side effect even when the answer looks right.
    const [only] = launched;
    if (launched.length !== 1 || only === undefined)
      return [launched.length + " threads titled " + title + ", expected 1"];
    const threadId = String(only["threadId"]);
    if (answer["threadId"] !== threadId)
      return ["reported " + JSON.stringify(answer["threadId"]) + ", launched " + threadId];
    // Its first run is the one the agent started; a later wake-up would be judged otherwise.
    const read = await client.call("goat_thread_read", { threadId, limit: 1, runLimit: 20 });
    const run = asObjects(read["recentRuns"]).find((candidate) => candidate["ordinal"] === 1);
    const failures: Array<string> = [];
    const [first] = asObjects(
      (await client.call("goat_thread_read", { threadId, view: "activity", limit: 1 }))["items"],
    );
    if (first?.["type"] !== "user_message" || first["text"] !== fixture["fixture.message"])
      failures.push(threadId + " started with " + JSON.stringify(first?.["text"] ?? null));
    const ranOn = String(run?.["providerInstanceId"]) + "/" + String(run?.["model"]);
    const asked = campaign.fixtureModel.instanceId + "/" + campaign.fixtureModel.model;
    if (ranOn !== asked) failures.push(threadId + " ran on " + ranOn + ", asked " + asked);
    const status = String(run?.["status"]);
    if (!TERMINAL.has(status)) failures.push(threadId + " is still " + status);
    if (answer["status"] !== status)
      failures.push("reported " + JSON.stringify(answer["status"]) + ", server says " + status);
    return failures;
  },
  answerMatchesFixtureThreads: async ({ client, answer, fixture }) => {
    const expected = (fixture["fixture.threadIds"] ?? "").split(",");
    const reported = asObjects(answer["threads"]);
    const failures: Array<string> = [];
    const reportedIds = reported.map((item) => String(item["threadId"]));
    if (reportedIds.length !== expected.length || !expected.every((id) => reportedIds.includes(id)))
      failures.push(
        "reported " + JSON.stringify(reportedIds) + ", started " + JSON.stringify(expected),
      );
    for (const id of expected) {
      const run = await latestRun(client, id);
      const status = String(run?.["status"]);
      if (!TERMINAL.has(status)) failures.push(id + " is still " + status);
      const claimed = reported.find((item) => item["threadId"] === id)?.["status"];
      if (claimed !== status)
        failures.push(id + " reported " + JSON.stringify(claimed) + ", server says " + status);
    }
    return failures;
  },
  reviewsMatchRequestedModels: async ({ client, campaign, answer, metrics }) => {
    const requested = campaign.reviewModels
      .map((model) => model.instanceId + "/" + model.model)
      .sort();
    const reviews = asObjects(answer["reviews"]);
    const failures: Array<string> = [];
    // A repeated launch is a duplicated side effect even when the answer looks right.
    if (metrics.subagents !== requested.length)
      failures.push(
        metrics.subagents + " delegated tasks started, " + requested.length + " requested",
      );
    const ran: Array<string> = [];
    for (const review of reviews) {
      const run = await latestRun(client, String(review["childThreadId"]));
      if (run === null) {
        failures.push("no child thread " + JSON.stringify(review["childThreadId"]));
        continue;
      }
      const childThreadId = String(review["childThreadId"]);
      if (run["status"] !== "completed")
        failures.push(childThreadId + " ended " + String(run["status"]) + ", not completed");
      const child = { instanceId: String(run["providerInstanceId"]), model: String(run["model"]) };
      if (!sameModel(String(review["model"]), child))
        failures.push(
          childThreadId +
            " reported model " +
            JSON.stringify(review["model"]) +
            ", ran " +
            String(run["model"]),
        );
      if (typeof review["verdict"] !== "string" || review["verdict"].trim() === "")
        failures.push(childThreadId + " reported no verdict");
      ran.push(String(run["providerInstanceId"]) + "/" + String(run["model"]));
    }
    if (JSON.stringify(ran.sort()) !== JSON.stringify(requested))
      failures.push(
        "reviews ran on " + JSON.stringify(ran) + ", requested " + JSON.stringify(requested),
      );
    return failures;
  },
};

const readTimeline = async (client: Client, threadId: string, runId: string) => {
  const items: Array<TimelineItem> = [];
  let afterPosition: number | null = null;
  for (;;) {
    const page = await client.call("goat_thread_read", {
      threadId,
      view: "activity",
      limit: 100,
      maxCharsPerItem: 2000,
      ...(afterPosition === null ? {} : { afterPosition }),
    });
    for (const item of asObjects(page["items"]))
      if (item["runId"] === runId)
        items.push({
          itemId: String(item["itemId"]),
          type: String(item["type"]),
          status: String(item["status"]),
          text: typeof item["text"] === "string" ? item["text"] : null,
          textTruncated: item["textTruncated"] === true,
        });
    if (typeof page["nextPosition"] !== "number") return items;
    afterPosition = page["nextPosition"];
  }
};

const fullText = async (client: Client, threadId: string, item: TimelineItem) => {
  let text = item.text ?? "";
  let textOffset: number | null = item.textTruncated ? text.length : null;
  while (textOffset !== null) {
    const page = await client.call("goat_thread_read", {
      threadId,
      // Offsets index the text the item was read with.
      view: "activity",
      itemId: item.itemId,
      textOffset,
    });
    const [part] = asObjects(page["items"]);
    text += typeof part?.["text"] === "string" ? part["text"] : "";
    textOffset = typeof part?.["nextTextOffset"] === "number" ? part["nextTextOffset"] : null;
  }
  return text;
};

const rowHead = (
  campaignId: string,
  campaign: Campaign,
  task: Task,
  arm: Arm,
  step: { readonly pair: number; readonly slot: number },
) => ({
  kind: "run" as const,
  campaignId,
  taskSetVersion: campaign.taskSetVersion,
  task: task.id,
  arm: arm.id,
  providerInstanceId: arm.modelSelection.instanceId,
  model: arm.modelSelection.model,
  listing: arm.listing,
  pair: step.pair,
  slot: step.slot,
});

/** Item statuses after which a delegated child will not deliver anything more. */
const SETTLED_ITEM = new Set(["completed", "failed", "cancelled", "interrupted", "declined"]);

/** Delegated children of the thread that have not finished, from every run's activity. */
const unfinishedTasks = async (client: Client, threadId: string) => {
  const ids: Array<string> = [];
  let afterPosition: number | null = null;
  for (;;) {
    const page = await client.call("goat_thread_read", {
      threadId,
      view: "activity",
      limit: 100,
      maxCharsPerItem: 1,
      ...(afterPosition === null ? {} : { afterPosition }),
    });
    for (const item of asObjects(page["items"]))
      if (item["type"] === "subagent" && !SETTLED_ITEM.has(String(item["status"])))
        ids.push(String(item["subagentId"] ?? item["itemId"]));
    if (typeof page["nextPosition"] !== "number") return ids;
    afterPosition = page["nextPosition"];
  }
};

/** Waits for one run to end. Returns why the run cannot count as finished, or null. */
const waitForRun = async (
  client: Client,
  task: Task,
  threadId: string,
  runId: string,
  deadline: number,
): Promise<string | null> => {
  const ignoreRequestIds: Array<string> = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "deadline of " + task.deadlineMs + " ms passed";
    const waited = await client.call("goat_thread_wait", {
      threadId,
      runId,
      timeoutMs: Math.min(remaining, 300000),
      ignoreRequestIds,
    });
    const pending = Array.isArray(waited["pendingRequestIds"])
      ? waited["pendingRequestIds"].map(String)
      : [];
    if (pending.length > 0 && !task.manual)
      return "the agent asked a question in an automatic task";
    ignoreRequestIds.push(...pending);
    if (waited["timedOut"] !== true && pending.length === 0) return null;
  }
};

/**
 * The thread's next run after the ones already counted: one it has started or queued, or one a
 * delegated child's delivery is about to start. Null once the thread is quiet with nothing
 * pending, so no answer is coming; "deadline" when the task's time ran out first.
 */
const nextRun = async (
  client: Client,
  threadId: string,
  counted: ReadonlySet<string>,
  deadline: number,
): Promise<string | null | "deadline"> => {
  let quiet = 0;
  for (;;) {
    if (Date.now() >= deadline) return "deadline";
    const read = await client.call("goat_thread_read", { threadId, limit: 1, runLimit: 20 });
    const next = nextUncountedRun(
      asObjects(read["recentRuns"]).flatMap((run) =>
        typeof run["runId"] === "string" && typeof run["ordinal"] === "number"
          ? [{ runId: run["runId"], ordinal: run["ordinal"] }]
          : [],
      ),
      counted,
    );
    if (next !== null) return next;
    const queued = (await client.call("goat_thread_status", { threadId }))["queuedRunId"];
    if (typeof queued === "string" && !counted.has(queued)) return queued;
    // A delivery lands a moment after its child settles, so quiet must hold for a while.
    quiet = (await unfinishedTasks(client, threadId)).length > 0 ? 0 : quiet + 1;
    if (quiet > 1) return null;
    await pause(SETTLE_MS);
  }
};

/**
 * Stops the eval thread the way GOAT's Stop does: its queue is held and the tasks it delegated
 * stop, so a later delivery cannot start a run nobody measures.
 */
const STOP_CONFIRM_MS = 60000;

/**
 * Stops the run's threads the way GOAT's Stop does, then waits until each is terminal and the
 * eval thread has no unfinished delegated task: an accepted interrupt can still be stopping.
 */
const stopThreads = async (
  client: Client,
  threadId: string | null,
  fixtures: ReadonlyArray<string>,
): Promise<Cleanup> => {
  const unfinished =
    threadId === null ? [] : await unfinishedTasks(client, threadId).catch(() => []);
  const threads = [...(threadId === null ? [] : [threadId]), ...fixtures];
  const result = (stopped: boolean, error: string | null): Cleanup => ({
    unfinishedTasks: unfinished,
    ...(fixtures.length === 0 ? {} : { fixtureThreads: [...fixtures] }),
    stopped,
    error,
  });
  try {
    for (const id of threads)
      await client.call("goat_thread_interrupt", { threadId: id, stopCascade: true });
    const until = Date.now() + STOP_CONFIRM_MS;
    for (;;) {
      const running: Array<string> = [];
      for (const id of threads)
        if ((await client.call("goat_thread_status", { threadId: id }))["terminal"] !== true)
          running.push(id);
      if (threadId !== null && (await unfinishedTasks(client, threadId)).length > 0)
        running.push(threadId + " (delegated tasks)");
      if (running.length === 0) return result(true, null);
      if (Date.now() >= until) return result(false, "still running: " + running.join(", "));
      await pause(2000);
    }
  } catch (error) {
    return result(false, String(error).slice(0, 300));
  }
};

/**
 * Puts the server on the arm's listing when the campaign names its settings file, then reads
 * tools/list as this client sees it. The server reloads the file on change, so the listing is
 * read again until it matches or a few seconds pass.
 */
/**
 * Resident tools the campaign's core arms name, and which of them the runner's own client cannot
 * see: a tool that needs a calling thread is hidden from it in every listing, so an arm that
 * names one cannot have its listing checked.
 */
interface Residents {
  readonly visible: ReadonlyArray<string>;
  readonly invisible: ReadonlyArray<string>;
}

const residentsOf = async (client: Client, campaign: Campaign): Promise<Residents> => {
  const named = [
    ...new Set(
      campaign.arms.flatMap((arm) => (arm.listing?.mode === "core" ? arm.listing.resident : [])),
    ),
  ];
  const visible: Array<string> = [];
  const invisible: Array<string> = [];
  for (const name of named) {
    const described = await client.call("goat_describe", { path: name });
    const entry = asObjects([described["entry"] ?? null])[0];
    const available = asObjects([entry?.["available"] ?? null])[0];
    (available?.["now"] === true ? visible : invisible).push(name);
  }
  return { visible, invisible };
};

const applyListing = async (
  client: Client,
  campaign: Campaign,
  arm: Arm,
  residents: Residents,
): Promise<{ readonly observed: ObservedListing; readonly mismatch: string | null }> => {
  if (campaign.listingSettings !== null && arm.listing !== null) {
    const path = campaign.listingSettings;
    const current: unknown = JSON.parse(NodeFS.readFileSync(path, "utf8"));
    const settings = typeof current === "object" && current !== null ? current : {};
    const next = { ...settings, agentToolListing: arm.listing.mode };
    NodeFS.writeFileSync(path + ".eval-tmp", JSON.stringify(next, null, 2) + "\n");
    NodeFS.renameSync(path + ".eval-tmp", path);
  }
  for (let attempt = 0; ; attempt++) {
    const names = await client.list();
    const observed = { tools: names.length, names: names.length <= 12 ? names : null };
    const unseen =
      arm.listing?.mode === "core"
        ? arm.listing.resident.filter((name) => residents.invisible.includes(name))
        : [];
    if (unseen.length > 0)
      return {
        observed,
        mismatch:
          unseen.join(", ") +
          " cannot be seen by the runner's client, so arm " +
          arm.id +
          "'s listing cannot be checked",
      };
    const matches = arm.listing === null || listingMatches(arm.listing, names, residents.visible);
    if (matches) return { observed, mismatch: null };
    if (attempt >= 10)
      return {
        observed,
        mismatch: "tools/list served " + names.length + " tools, not arm " + arm.id + "'s listing",
      };
    await pause(1000);
  }
};

interface Followed {
  readonly counted: ReadonlyArray<{ readonly runId: string; readonly items: Array<TimelineItem> }>;
  readonly answerText: string | null;
  readonly failures: ReadonlyArray<string>;
}

/**
 * An agent that delegates may end its run and answer in a later one, which a delegated child's
 * delivery starts, so a run is the launched run and every later one until the answer.
 */
const follow = async (
  client: Client,
  task: Task,
  threadId: string,
  launchedRunId: string,
): Promise<Followed> => {
  const failures: Array<string> = [];
  const deadline = Date.now() + task.deadlineMs;
  const counted: Array<{ readonly runId: string; readonly items: Array<TimelineItem> }> = [];
  let runId = launchedRunId;
  let answerText: string | null = null;
  for (;;) {
    const unfinished = await waitForRun(client, task, threadId, runId, deadline);
    const items: Array<TimelineItem> = [];
    for (const item of await readTimeline(client, threadId, runId))
      // Result bytes come from the whole result, not the activity view's first page.
      items.push(
        item.type === "dynamic_tool" && item.textTruncated
          ? { ...item, text: await fullText(client, threadId, item), textTruncated: false }
          : item,
      );
    counted.push({ runId, items });
    const final = items.filter((item) => item.type === "assistant_message").at(-1);
    answerText = final === undefined ? null : await fullText(client, threadId, final);
    if (unfinished !== null) {
      failures.push(unfinished);
      break;
    }
    if (answerText !== null && /^\s*EVAL_JSON /m.test(answerText)) break;
    const next = await nextRun(
      client,
      threadId,
      new Set(counted.map((run) => run.runId)),
      deadline,
    );
    if (next === null) break;
    if (next === "deadline") {
      failures.push("deadline of " + task.deadlineMs + " ms passed");
      break;
    }
    if (counted.length > MAX_FOLLOWUP_RUNS) {
      failures.push("followup_cap");
      break;
    }
    runId = next;
  }
  return { counted, answerText, failures };
};

const runOnce = async (
  context: Context,
  arm: Arm,
  step: { readonly pair: number; readonly slot: number },
  campaignId: string,
): Promise<RunRow> => {
  const { client, campaign, task, tag } = context;
  const row = rowHead(campaignId, campaign, task, arm, step);
  const unrun = (why: string): RunRow => ({
    ...row,
    threadId: null,
    ok: false,
    failures: [],
    // The arm never ran, so this run says nothing about it.
    contamination: [why],
    metrics: null,
    wallMs: null,
    at: new Date().toISOString(),
  });
  const listing = await applyListing(client, campaign, arm, context.residents);
  if (listing.mismatch !== null)
    return { ...unrun(listing.mismatch), observedListing: listing.observed };
  let fixture: Fixture;
  try {
    fixture = await FIXTURES[task.fixture.kind]!(context);
  } catch (error) {
    // A fixture that failed partway may have started threads; they are stopped before moving on.
    return {
      ...unrun("fixture: " + String(error)),
      cleanup: await stopThreads(client, null, context.owned),
    };
  }
  const vars = {
    ...campaign.values,
    ...fixture,
    projectId: campaign.projectId,
    tag,
    reviewModels: campaign.reviewModels
      .map((model) => model.instanceId + " / " + model.model)
      .join(", "),
    fixtureModel: campaign.fixtureModel.instanceId + " / " + campaign.fixtureModel.model,
  };
  const launched = await client.call("goat_thread_launch", {
    title: "[eval] " + tag,
    // Scratch threads are refused where an environment disables them; the project is always
    // there, and the "[eval" title prefix keeps these threads out of every fixture.
    projectId: campaign.projectId,
    message: render(task.prompt, vars) + answerInstruction(task.answerKeys),
    modelSelection: { ...arm.modelSelection },
    notifyOnCompletion: false,
  });
  const threadId = String(launched["threadId"]);
  // Once the thread exists it is stopped whatever happens next, and its id stays in the row.
  const followed = await follow(client, task, threadId, String(launched["runId"])).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const cleanup = await stopThreads(client, threadId, context.owned);
  const broken = (error: unknown): RunRow => ({
    ...row,
    threadId,
    ok: false,
    failures: [],
    // A harness or transport error says nothing about the arm, so it is listed, not counted.
    contamination: ["runner: " + String(error)],
    metrics: null,
    wallMs: null,
    at: new Date().toISOString(),
    cleanup,
    observedListing: listing.observed,
  });
  if (!followed.ok) return broken(followed.error);
  const { counted, answerText } = followed.value;
  try {
    const failures = [...followed.value.failures];
    const metrics = sumMetrics(counted.map((run) => runMetrics(run.items, arm)));
    const read = await client.call("goat_thread_read", { threadId, limit: 1, runLimit: 20 });
    const runs = counted.map(({ runId: id }) =>
      asObjects(read["recentRuns"]).find((candidate) => candidate["runId"] === id),
    );
    for (const [index, run] of runs.entries())
      if (run?.["status"] !== "completed")
        failures.push("run " + (index + 1) + " ended " + String(run?.["status"]));
    const startedAt = Date.parse(String(runs[0]?.["startedAt"]));
    const completedAt = Date.parse(String(runs.at(-1)?.["completedAt"]));
    const answer = extractAnswer(answerText, task.answerKeys);
    if (!answer.ok) failures.push(answer.why);
    else
      for (const check of task.checks)
        // A check that cannot read what the answer points at is judging a wrong answer.
        failures.push(
          ...(await CHECKS[check]!({ ...context, answer: answer.value, fixture, metrics }).catch(
            (error: unknown) => [check + ": " + String(error)],
          )),
        );
    return {
      ...row,
      threadId,
      ok: failures.length === 0,
      failures,
      contamination: metrics.violations,
      metrics,
      wallMs: Number.isFinite(completedAt - startedAt) ? completedAt - startedAt : null,
      at: new Date().toISOString(),
      followupRuns: counted.length - 1,
      cleanup,
      observedListing: listing.observed,
    };
  } catch (error) {
    return broken(error);
  }
};

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  const campaignPath = argument("--campaign");
  if (campaignPath === undefined) {
    console.error("usage: run.ts --campaign <file.json> [--tasks a,b] [--include-manual] [--live]");
    return 2;
  }
  const implemented = {
    fixtures: new Set(Object.keys(FIXTURES)),
    checks: new Set(Object.keys(CHECKS)),
  };
  const taskSet = validateTaskSet(
    JSON.parse(NodeFS.readFileSync(new URL("./tasks.json", import.meta.url), "utf8")),
    implemented,
  );
  const only = argument("--tasks")?.split(",");
  const includeManual = process.argv.includes("--include-manual");
  const unknown = (only ?? []).filter((id) => !taskSet.tasks.some((task) => task.id === id));
  if (unknown.length > 0) throw new CampaignError("no such task: " + unknown.join(", "));
  const selected = taskSet.tasks.filter(
    (task) => (only === undefined || only.includes(task.id)) && (includeManual || !task.manual),
  );
  for (const task of selected) {
    const pending = pendingChecks(task, implemented);
    if (pending.length > 0)
      throw new CampaignError(task.id + " cannot run: no implementation for " + pending.join(", "));
  }
  const campaign = validateCampaign(
    JSON.parse(NodeFS.readFileSync(campaignPath, "utf8")),
    taskSet,
    selected,
  );
  const steps = schedule(selected, campaign);
  if (!process.argv.includes("--live")) {
    for (const task of taskSet.tasks.filter((task) => !selected.includes(task)))
      console.log(
        JSON.stringify({
          kind: "skipped",
          task: task.id,
          manual: task.manual,
          needs: task.needs,
          pending: pendingChecks(task, implemented),
        }),
      );
    for (const step of steps) console.log(JSON.stringify({ kind: "plan", ...step }));
    return 0;
  }
  const endpoint = process.env.GOAT_EVAL_ENDPOINT;
  const authorization = process.env.GOAT_EVAL_AUTHORIZATION;
  // No fallback to GOAT_ACP_MCP_*: runs launched with a thread credential would count against
  // that thread's lanes and run under its ceiling, which is a different experiment.
  if (endpoint === undefined || authorization === undefined) {
    console.error("--live needs GOAT_EVAL_ENDPOINT and GOAT_EVAL_AUTHORIZATION for a dev server");
    return 2;
  }
  const client = await connect(endpoint, authorization);
  const campaignId = "c" + Date.now().toString(36);
  const residents = await residentsOf(client, campaign);
  for (const step of steps) {
    const task = selected.find((candidate) => candidate.id === step.taskId)!;
    const arm = campaign.arms.find((candidate) => candidate.id === step.armId)!;
    const tag = campaignId + "-" + task.id + "-" + step.pair + "-" + arm.id;
    const owned: Array<string> = [];
    const row = await runOnce(
      { client, campaign, task, tag, residents, owned },
      arm,
      step,
      campaignId,
    ).catch(
      // A harness or transport error says nothing about the arm, so it is listed, not counted.
      async (error: unknown): Promise<RunRow> => ({
        ...rowHead(campaignId, campaign, task, arm, step),
        threadId: null,
        ok: false,
        failures: [],
        contamination: ["runner: " + String(error)],
        metrics: null,
        wallMs: null,
        at: new Date().toISOString(),
        // Fixture threads may already run when the eval thread's launch fails.
        cleanup: await stopThreads(client, null, owned),
      }),
    );
    console.log(JSON.stringify(row));
    // A thread that may still be running would overlap the next run and its listing.
    if (row.cleanup?.stopped === false) {
      console.error("stopping the campaign: thread " + row.threadId + " could not be stopped");
      return 1;
    }
  }
  return 0;
};

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof CampaignError ? error.message : error);
  return 1;
});
