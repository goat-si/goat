// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off - a plain Node script that drives a GOAT server over MCP; no Effect runtime.
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
  type Json,
  type JsonObject,
  type RunMetrics,
  type RunRow,
  type Task,
  type TimelineItem,
  answerInstruction,
  extractAnswer,
  pendingChecks,
  render,
  runMetrics,
  schedule,
  validateCampaign,
  validateTaskSet,
} from "./core.ts";

const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

interface Client {
  readonly call: (name: string, args: JsonObject) => Promise<JsonObject>;
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
  };
};

interface Context {
  readonly client: Client;
  readonly campaign: Campaign;
  readonly task: Task;
  readonly tag: string;
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
  titleTag: async ({ tag }) => ({ "fixture.title": "[eval-fixture] fx-" + tag }),
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
  runningThreads: async ({ client, campaign, task, tag }) => {
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
    const run = await latestRun(client, threadId);
    const failures: Array<string> = [];
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
      if (review["model"] !== run["model"])
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

const runOnce = async (
  context: Context,
  arm: Arm,
  step: { readonly pair: number; readonly slot: number },
  campaignId: string,
): Promise<RunRow> => {
  const { client, campaign, task, tag } = context;
  const row = rowHead(campaignId, campaign, task, arm, step);
  let fixture: Fixture;
  try {
    fixture = await FIXTURES[task.fixture.kind]!(context);
  } catch (error) {
    // The arm never ran, so this run says nothing about it.
    return {
      ...row,
      threadId: null,
      ok: false,
      failures: [],
      contamination: ["fixture: " + String(error)],
      metrics: null,
      wallMs: null,
      at: new Date().toISOString(),
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
  // A completion notice can wake the thread into a later run, so the launched run is measured.
  const runId = String(launched["runId"]);
  const failures: Array<string> = [];
  const deadline = Date.now() + task.deadlineMs;
  let ignoreRequestIds: Array<string> = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      failures.push("deadline of " + task.deadlineMs + " ms passed");
      await client.call("goat_thread_interrupt", { threadId }).catch(() => undefined);
      break;
    }
    const waited = await client.call("goat_thread_wait", {
      threadId,
      runId,
      timeoutMs: Math.min(remaining, 300000),
      ignoreRequestIds,
    });
    const pending = Array.isArray(waited["pendingRequestIds"])
      ? waited["pendingRequestIds"].map(String)
      : [];
    if (pending.length > 0 && !task.manual) {
      failures.push("the agent asked a question in an automatic task");
      await client.call("goat_thread_interrupt", { threadId }).catch(() => undefined);
      break;
    }
    ignoreRequestIds = [...ignoreRequestIds, ...pending];
    if (waited["timedOut"] !== true && pending.length === 0) break;
  }
  const items: Array<TimelineItem> = [];
  for (const item of await readTimeline(client, threadId, runId))
    // Result bytes come from the whole result, not the activity view's first page.
    items.push(
      item.type === "dynamic_tool" && item.textTruncated
        ? { ...item, text: await fullText(client, threadId, item), textTruncated: false }
        : item,
    );
  const metrics = runMetrics(items, arm);
  const read = await client.call("goat_thread_read", { threadId, limit: 1, runLimit: 20 });
  const run = asObjects(read["recentRuns"]).find((candidate) => candidate["runId"] === runId);
  const startedAt = Date.parse(String(run?.["startedAt"]));
  const completedAt = Date.parse(String(run?.["completedAt"]));
  if (run?.["status"] !== "completed") failures.push("the run ended " + String(run?.["status"]));
  const final = items.filter((item) => item.type === "assistant_message").at(-1);
  const answer = extractAnswer(
    final === undefined ? null : await fullText(client, threadId, final),
    task.answerKeys,
  );
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
  };
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
  for (const step of steps) {
    const task = selected.find((candidate) => candidate.id === step.taskId)!;
    const arm = campaign.arms.find((candidate) => candidate.id === step.armId)!;
    const tag = campaignId + "-" + task.id + "-" + step.pair + "-" + arm.id;
    const row = await runOnce({ client, campaign, task, tag }, arm, step, campaignId).catch(
      // A harness or transport error says nothing about the arm, so it is listed, not counted.
      (error: unknown): RunRow => ({
        ...rowHead(campaignId, campaign, task, arm, step),
        threadId: null,
        ok: false,
        failures: [],
        contamination: ["runner: " + String(error)],
        metrics: null,
        wallMs: null,
        at: new Date().toISOString(),
      }),
    );
    console.log(JSON.stringify(row));
  }
  return 0;
};

process.exitCode = await main().catch((error: unknown) => {
  console.error(error instanceof CampaignError ? error.message : error);
  return 1;
});
