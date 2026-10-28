// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off globalDate:off globalTimers:off - a plain Node script that drives agents and reads this Mac; no Effect runtime.
/**
 * Runs the computer use eval on this Mac; usage is in docs/operations/computer-use-eval.md.
 * GOAT arms launch threads on the installed GOAT behind GOAT_EVAL_ENDPOINT or the calling
 * thread's GOAT_ACP_MCP_ENDPOINT; the other arms run codex exec. Runs share one screen, so
 * they are sequential.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { answerInstruction, extractAnswer, type JsonObject } from "../agent-surface/eval/core.ts";
import {
  ARMS,
  type ArmSpec,
  COMMON_RULES,
  ORACLES,
  type RunRow,
  type Task,
  type TimelineEntry,
  type Transcript,
  codexTranscript,
  goatTranscript,
  judge,
  metricsOf,
  renderReport,
  validateTaskSet,
} from "./core.ts";
import {
  WITNESSES,
  chromeTabCount,
  documentsSince,
  sampleUntil,
  windowInventory,
} from "./macos.ts";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const list = (name: string) => argument(name)?.split(",").filter(Boolean);

interface Client {
  readonly call: (path: string, args: JsonObject) => Promise<JsonObject>;
}

/** A GOAT MCP session; every capability goes through goat_call so the core listing suffices. */
const connect = async (endpoint: string, authorization: string): Promise<Client> => {
  let sessionId: string | null = null;
  let nextId = 1;
  const post = async (method: string, params: JsonObject, id?: number) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
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
    const message = await post(method, params, nextId++);
    if (message === undefined) throw new Error(method + ": no response");
    if (message["error"] !== undefined)
      throw new Error(method + ": " + JSON.stringify(message["error"]));
    return message["result"] as JsonObject;
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "goat-computer-use-eval", version: "1" },
  });
  await post("notifications/initialized", {});
  return {
    call: async (path, args) => {
      const result = await rpc("tools/call", { name: "goat_call", arguments: { path, args } });
      const content = result["content"] as ReadonlyArray<{ type: string; text?: string }>;
      const body =
        (result["structuredContent"] as JsonObject | undefined) ??
        (JSON.parse(content?.find((item) => item.type === "text")?.text ?? "{}") as JsonObject);
      if (result["isError"] === true || body["status"] !== "ok")
        throw new Error(path + ": " + JSON.stringify(body["error"] ?? body).slice(0, 300));
      return body["value"] as JsonObject;
    },
  };
};

const asObjects = (value: unknown): ReadonlyArray<JsonObject> =>
  Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject =>
          typeof item === "object" && item !== null && !Array.isArray(item),
      )
    : [];

interface Options {
  readonly model: string;
  readonly effort: string;
  readonly instanceId: string;
}

interface Ran {
  readonly transcript: Transcript;
  readonly wallMs: number | null;
  readonly ref: string;
  readonly notes: ReadonlyArray<string>;
}

/** Tool results can be long; the evidence check needs all of a result, up to this much. */
const MAX_ITEM_CHARS = 200_000;

const readRun = async (
  client: Client,
  threadId: string,
  runId: string,
): Promise<ReadonlyArray<TimelineEntry>> => {
  const items: Array<TimelineEntry> = [];
  let afterPosition: number | null = null;
  for (;;) {
    const page = await client.call("thread.read", {
      threadId,
      view: "activity",
      limit: 100,
      maxCharsPerItem: 4000,
      ...(afterPosition === null ? {} : { afterPosition }),
    });
    for (const item of asObjects(page["items"])) {
      if (item["runId"] !== runId) continue;
      let text = typeof item["text"] === "string" ? item["text"] : "";
      let offset: number | null = item["textTruncated"] === true ? text.length : null;
      while (offset !== null && text.length < MAX_ITEM_CHARS) {
        const [part] = asObjects(
          (
            await client.call("thread.read", {
              threadId,
              view: "activity",
              itemId: String(item["itemId"]),
              textOffset: offset,
            })
          )["items"],
        );
        text += typeof part?.["text"] === "string" ? part["text"] : "";
        offset = typeof part?.["nextTextOffset"] === "number" ? part["nextTextOffset"] : null;
      }
      items.push({
        itemId: String(item["itemId"]),
        type: String(item["type"]),
        status: String(item["status"]),
        text,
      });
    }
    if (typeof page["nextPosition"] !== "number") return items;
    afterPosition = page["nextPosition"];
  }
};

const runGoat = async (
  client: Client,
  task: Task,
  prompt: string,
  options: Options,
  title: string,
): Promise<Ran> => {
  const launched = await client.call("thread.launch", {
    scratch: true,
    title,
    runtimeMode: "full-access",
    modelSelection: {
      instanceId: options.instanceId,
      model: options.model,
      options: [
        { id: "reasoningEffort", value: options.effort },
        { id: "serviceTier", value: "default" },
      ],
    },
    notifyOnCompletion: false,
    message: prompt,
  });
  const threadId = String(launched["threadId"]);
  const runId = String(launched["runId"]);
  const deadline = Date.now() + task.deadlineMs;
  const notes: Array<string> = [];
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      notes.push("deadline of " + task.deadlineMs + " ms passed; the run was interrupted");
      await client
        .call("thread.interrupt", { threadId, stopCascade: true })
        .catch((error: unknown) => notes.push("interrupt failed: " + String(error)));
      break;
    }
    const waited = await client.call("thread.wait", {
      threadId,
      runId,
      timeoutMs: Math.min(remaining, 240000),
    });
    if (Array.isArray(waited["pendingRequestIds"]) && waited["pendingRequestIds"].length > 0) {
      notes.push("the agent asked for input; the run was interrupted");
      await client
        .call("thread.interrupt", { threadId, stopCascade: true })
        .catch((error: unknown) => notes.push("interrupt failed: " + String(error)));
      break;
    }
    if (waited["timedOut"] !== true) break;
  }
  const read = await client.call("thread.read", { threadId, limit: 1, runLimit: 5 });
  const run = asObjects(read["recentRuns"]).find((candidate) => candidate["runId"] === runId);
  const wallMs = Date.parse(String(run?.["completedAt"])) - Date.parse(String(run?.["startedAt"]));
  if (run?.["status"] !== "completed") notes.push("run ended " + String(run?.["status"]));
  return {
    transcript: goatTranscript(await readRun(client, threadId, runId)),
    wallMs: Number.isFinite(wallMs) ? wallMs : null,
    ref: threadId,
    notes,
  };
};

const runCodex = (task: Task, prompt: string, options: Options): Promise<Ran> =>
  new Promise((resolve, reject) => {
    const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cu-eval-"));
    const started = Date.now();
    const child = NodeChildProcess.spawn(
      "codex",
      [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "-C",
        cwd,
        "-m",
        options.model,
        "-c",
        'model_reasoning_effort="' + options.effort + '"',
        prompt,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const notes: Array<string> = [];
    let buffer = "";
    const events: Array<JsonObject> = [];
    const timer = setTimeout(() => {
      notes.push("deadline of " + task.deadlineMs + " ms passed; codex exec was stopped");
      child.kill("SIGTERM");
    }, task.deadlineMs);
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines)
        if (line.startsWith("{")) {
          try {
            events.push(JSON.parse(line) as JsonObject);
          } catch {
            notes.push("an unreadable event line");
          }
        }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      NodeFS.rmSync(cwd, { recursive: true, force: true });
      if (code !== 0 && code !== null) notes.push("codex exec exited " + code);
      const thread = events.find((event) => event["type"] === "thread.started");
      resolve({
        transcript: codexTranscript(events),
        wallMs: Date.now() - started,
        ref: "codex " + String(thread?.["thread_id"] ?? "?"),
        notes,
      });
    });
  });

const WATCHED_OWNERS = new Set([
  "Calculator",
  "Finder",
  "TextEdit",
  "KakaoTalk",
  "Google Chrome",
  "Aside",
  "Safari",
]);

interface Snapshot {
  readonly windows: ReadonlyArray<{ id: number; owner: string; title: string }>;
  readonly chromeTabs: number | null;
  readonly asideTabs: ReadonlyArray<string> | null;
}

const asideTabs = (): Promise<ReadonlyArray<string>> =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      "aside",
      ["repl", "console.log(JSON.stringify((await listBrowserTabs()).map((t) => t.targetId)))"],
      { timeout: 60000 },
      (error, stdout) => {
        if (error !== null) return reject(error);
        const line = stdout.split("\n").find((candidate) => candidate.startsWith("["));
        if (line === undefined) return reject(new Error("aside repl printed no tab list"));
        resolve(JSON.parse(line) as ReadonlyArray<string>);
      },
    ),
  );

const snapshot = async (arm: ArmSpec, task: Task): Promise<Snapshot> => ({
  windows: await windowInventory(),
  chromeTabs: task.surface === "web" ? await chromeTabCount() : null,
  asideTabs: arm.id.startsWith("aside") ? await asideTabs() : null,
});

/** What the run left open, measured before anything is cleaned up. */
const leftoversOf = async (
  client: Client | null,
  arm: ArmSpec,
  task: Task,
  before: Snapshot,
  after: Snapshot,
  outputs: ReadonlyArray<string>,
  final: JsonObject,
) => {
  const known = new Set(before.windows.map((window) => window.id));
  const left = after.windows
    .filter((window) => !known.has(window.id) && WATCHED_OWNERS.has(window.owner))
    .map(
      (window) => window.owner + " window " + JSON.stringify(window.title) + " (" + window.id + ")",
    );
  if (
    before.chromeTabs !== null &&
    after.chromeTabs !== null &&
    after.chromeTabs > before.chromeTabs
  )
    left.push(after.chromeTabs - before.chromeTabs + " Chrome tab(s)");
  if (before.asideTabs !== null && after.asideTabs !== null)
    for (const id of after.asideTabs)
      if (!before.asideTabs.includes(id)) left.push("Aside tab " + id);
  if (
    task.witness === "calculator" &&
    typeof final["display"] === "string" &&
    final["display"].replace(/[^\d]/gu, "") !== "0"
  )
    left.push("Calculator display left at " + final["display"]);
  const notes: Array<string> = [];
  if (client !== null && arm.driver === "goat" && task.surface === "web") {
    const ids = new Set(
      outputs.flatMap((output) =>
        [...output.matchAll(/"tabId"\s*:\s*"([^"]+)"/gu)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        ),
      ),
    );
    for (const tabId of ids)
      try {
        const status = await client.call("preview.status", { tabId });
        if (status["tabId"] === tabId)
          left.push("GOAT tab " + tabId + " " + String(status["url"] ?? ""));
      } catch (error) {
        notes.push(
          "GOAT tab " + tabId + " is not live to the runner: " + String(error).slice(0, 120),
        );
      }
  }
  return { left, notes };
};

const promptFor = (task: Task, arm: ArmSpec) =>
  task.prompt +
  "\n\n" +
  arm.instruction +
  "\n" +
  COMMON_RULES +
  answerInstruction(task.answerKeys) +
  ' The status value is "done", "failed" or "skipped".';

const runStep = async (
  client: Client | null,
  task: Task,
  arm: ArmSpec,
  options: Options,
  base: Omit<RunRow, "task" | "surface" | "arm" | "at" | "status">,
): Promise<RunRow> => {
  const head = {
    ...base,
    task: task.id,
    surface: task.surface,
    arm: arm.id,
    at: new Date().toISOString(),
  };
  if (!arm.surfaces.includes(task.surface))
    return {
      ...head,
      status: "unsupported",
      error: arm.id + " has no " + task.surface + " surface",
    };
  const witness = task.witness === null ? undefined : WITNESSES[task.witness];
  const read = witness === undefined ? null : witness(task.expect);
  const before = await snapshot(arm, task);
  const baseline = read === null ? {} : await read();
  const sampler = read === null ? null : sampleUntil(read, 700);
  const startedMs = Date.now();
  let ran: Ran;
  try {
    if (arm.driver === "goat") {
      if (client === null) throw new Error("no GOAT endpoint for a GOAT arm");
      ran = await runGoat(
        client,
        task,
        promptFor(task, arm),
        options,
        "[cu-eval] " + task.id + " · " + arm.id,
      );
    } else ran = await runCodex(task, promptFor(task, arm), options);
  } catch (error) {
    await sampler?.stop();
    return { ...head, status: "error", error: String(error) };
  }
  const samples = (await sampler?.stop()) ?? [];
  const final: JsonObject =
    read === null
      ? {}
      : {
          ...(await read()),
          ...(task.oracle === "textEditDiscard" ? { savedFiles: documentsSince(startedMs) } : {}),
        };
  const after = await snapshot(arm, task);
  const outputs = ran.transcript.steps
    .filter((step) => step.kind === "tool")
    .map((step) => step.output);
  const answer = extractAnswer(ran.transcript.finalText, task.answerKeys);
  const judgeBy = ORACLES[task.oracle];
  if (judgeBy === undefined) return { ...head, status: "error", error: "no oracle " + task.oracle };
  const oracle = judgeBy({ task, baseline, samples, final, toolOutputs: outputs });
  const verdict = judge(task, answer.ok ? answer.value : null, oracle);
  const leftovers = await leftoversOf(client, arm, task, before, after, outputs, final);
  const contended = outputs.some((output) => /\b(app_busy|target_busy)\b/u.test(output));
  const witnessErrors = samples.some((sample) => sample.value["witnessError"] !== undefined)
    ? ["the observer failed to read at least once"]
    : [];
  return {
    ...head,
    status: "ran",
    contended,
    claimed: verdict.claimed,
    answerError: answer.ok ? null : answer.why,
    actual: oracle.actual,
    outcome: verdict.outcome,
    misreport: verdict.misreport,
    valueErrors: verdict.valueErrors,
    violations: oracle.violations,
    leftovers: leftovers.left,
    notes: [
      ...ran.notes,
      ...oracle.notes,
      ...leftovers.notes,
      ...(contended ? ["another thread held the app or the desktop"] : []),
      ...witnessErrors,
    ],
    metrics: metricsOf(ran.transcript.steps, arm),
    tokens: ran.transcript.tokens,
    wallMs: ran.wallMs,
    ref: ran.ref,
  };
};

const EMPTY = {
  contended: false,
  error: null,
  claimed: null,
  answerError: null,
  actual: null,
  outcome: null,
  misreport: null,
  valueErrors: [],
  violations: [],
  leftovers: [],
  notes: [],
  metrics: null,
  tokens: null,
  wallMs: null,
  ref: null,
} as const;

const main = async () => {
  const reportPath = argument("--report");
  if (reportPath !== undefined) {
    const campaign = argument("--campaign");
    const rows = NodeFS.readFileSync(reportPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunRow)
      .filter((row) => campaign === undefined || row.campaignId === campaign);
    process.stdout.write(renderReport(rows));
    return;
  }
  const taskSet = validateTaskSet(
    JSON.parse(NodeFS.readFileSync(new URL("tasks.json", import.meta.url), "utf8")),
    {
      witnesses: new Set(Object.keys(WITNESSES)),
      oracles: new Set(Object.keys(ORACLES)),
    },
  );
  const taskIds = list("--tasks");
  const armIds = list("--arms");
  const tasks = taskSet.tasks.filter((task) => taskIds === undefined || taskIds.includes(task.id));
  const arms = ARMS.filter((arm) => armIds === undefined || armIds.includes(arm.id));
  for (const id of [...(taskIds ?? []), ...(armIds ?? [])])
    if (!tasks.some((task) => task.id === id) && !arms.some((arm) => arm.id === id))
      throw new Error("unknown task or arm " + id);
  const repeat = Number(argument("--repeat") ?? "1");
  // Arms rotate per task so no arm always runs first on a freshly reset screen.
  const steps = Array.from({ length: repeat }, () =>
    tasks.flatMap((task, index) => {
      const shift = index % arms.length;
      return [...arms.slice(shift), ...arms.slice(0, shift)].map((arm) => ({ task, arm }));
    }),
  ).flat();
  if (!process.argv.includes("--live")) {
    for (const step of steps)
      console.log(
        step.task.id.padEnd(26) +
          step.arm.id +
          (step.arm.surfaces.includes(step.task.surface) ? "" : "  (unsupported)"),
      );
    return;
  }
  const out = argument("--out");
  if (out === undefined) throw new Error("--live needs --out <runs.jsonl>");
  const endpoint = process.env["GOAT_EVAL_ENDPOINT"] ?? process.env["GOAT_ACP_MCP_ENDPOINT"];
  const authorization =
    process.env["GOAT_EVAL_AUTHORIZATION"] ?? process.env["GOAT_ACP_MCP_AUTHORIZATION"];
  const client = arms.some((arm) => arm.driver === "goat")
    ? endpoint !== undefined && authorization !== undefined
      ? await connect(endpoint, authorization)
      : null
    : null;
  if (client === null && arms.some((arm) => arm.driver === "goat"))
    throw new Error("GOAT arms need GOAT_EVAL_ENDPOINT and GOAT_EVAL_AUTHORIZATION");
  const goatVersion =
    client === null
      ? null
      : String(
          (
            (await client.call("host.status", {}))["hosts"] as ReadonlyArray<JsonObject> | undefined
          )?.[0]?.["serverVersion"] ?? "unknown",
        );
  const options: Options = {
    model: argument("--model") ?? "gpt-6.1-sol",
    effort: argument("--effort") ?? "high",
    instanceId: argument("--instance") ?? "codex",
  };
  const base = {
    ...EMPTY,
    kind: "run" as const,
    campaignId: argument("--campaign") ?? new Date().toISOString().slice(0, 16),
    goatVersion,
    taskSetVersion: taskSet.version,
    model: options.model,
  };
  for (const step of steps) {
    for (let attempt = 0; ; attempt += 1) {
      const row = await runStep(client, step.task, step.arm, options, base);
      NodeFS.appendFileSync(out, JSON.stringify(row) + "\n");
      console.error(
        [
          row.task,
          row.arm,
          row.status,
          row.contended ? "contended" : "",
          row.outcome ?? "",
          row.misreport ?? "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
      // Leftovers stay for the operator: the runner has no admitted way to close another surface's windows.
      if (row.leftovers.length > 0) console.error("  cleanup needed: " + row.leftovers.join("; "));
      if (!row.contended || attempt >= CONTENDED_RETRIES) break;
      await new Promise((resolve) => setTimeout(resolve, LEASE_WAIT_MS));
    }
  }
};

/** A GOAT app lease lasts 60 s after its holder's last input (ComputerUseAppLeases). */
const LEASE_WAIT_MS = 65_000;
const CONTENDED_RETRIES = 1;

await main();
