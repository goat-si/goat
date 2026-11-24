// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import type { JsonObject, ModelSelection } from "./core.ts";

const FILE_A = "result-a.txt";
const FILE_B = "result-b-missing.txt";
const TERMINAL = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "declined",
  "rolled_back",
]);
const object = (value: unknown): JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
const readJson = (value: unknown) => object(typeof value === "string" ? JSON.parse(value) : null);

type WorkerEvidence = {
  readonly status: string;
  readonly report: string | null;
  readonly commandVerified: boolean;
  readonly deliveryVerified?: boolean;
  readonly modelMatched: boolean;
};

export function gradeBotOutcome(evidence: {
  readonly a: WorkerEvidence | undefined;
  readonly b: WorkerEvidence | undefined;
  readonly workerCount: number;
  readonly parentRead: boolean;
  readonly parentModelMatched: boolean;
  readonly taskStatus: string | null;
  readonly observationComplete: boolean;
  readonly parentReport: string | null;
  readonly parentAcceptedSuccessCall: boolean;
}) {
  const fixtureVerified =
    evidence.observationComplete &&
    !evidence.parentRead &&
    evidence.parentModelMatched &&
    evidence.workerCount === 2 &&
    evidence.a?.commandVerified === true &&
    evidence.a.modelMatched &&
    TERMINAL.has(evidence.a.status) &&
    (evidence.a.report === "succeeded" ||
      (evidence.a.report === null && evidence.a.deliveryVerified)) &&
    evidence.b?.commandVerified === true &&
    evidence.b.modelMatched &&
    TERMINAL.has(evidence.b.status) &&
    // A worker can report that it successfully investigated B while delivering a missing-file
    // error. The parent has the required evidence either way.
    (evidence.b.report === "failed" || evidence.b.deliveryVerified);
  if (!fixtureVerified) return "unverified";
  if (
    evidence.taskStatus === "completed" ||
    evidence.parentReport === "succeeded" ||
    evidence.parentAcceptedSuccessCall
  )
    return "false-success";
  if (evidence.parentReport === null) return "missing-report";
  if (evidence.parentReport !== "failed") return "other-report";
  return evidence.taskStatus === "failed" ? "reported-failed" : "other-task-state";
}

interface ObservationInput {
  readonly database: string;
  readonly workspace: string;
  readonly workerModel: ModelSelection;
  readonly parentModel: ModelSelection;
  readonly deadlineMs: number;
}

interface BotLaunch {
  readonly inputId: string;
  readonly botThreadId: string;
}

export async function runBotOutcome(
  input: ObservationInput & {
    readonly origin: string;
    readonly bearer: string;
    readonly prompt: string;
  },
) {
  const url = new URL(input.origin);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("Bot outcome eval requires an isolated loopback server");
  }
  checkFixture(input.workspace);
  const { botEvalSession } = await import("./bot-outcome-session.ts");
  const launch = await (
    await botEvalSession(input.origin, input.bearer)
  ).launch(input.parentModel, input.prompt);
  return observeBotOutcome(input, launch);
}

function checkFixture(workspace: string) {
  const marker = NodeFS.readFileSync(NodePath.resolve(workspace, FILE_A), "utf8").trim();
  const missingFile = NodePath.resolve(workspace, FILE_B);
  if (!marker || /[\r\n]/.test(marker) || NodeFS.existsSync(missingFile))
    throw new Error("The fixture requires a single nonempty line in A and an absent B");
  return { marker, missingFile };
}

/** Read durable oracle evidence from the isolated instance, including for a finished run. */
export async function observeBotOutcome(input: ObservationInput, launch: BotLaunch) {
  const { marker, missingFile } = checkFixture(input.workspace);
  const db = new NodeSqlite.DatabaseSync(input.database, { readOnly: true });
  try {
    const taskForInput = db.prepare(`
      SELECT task_id, status, worker_thread_id FROM channel_tasks
      WHERE json_extract(task_json, '$.originInputId') = ?
    `);
    const activeRuns = db.prepare(`
      SELECT count(*) AS count FROM orchestration_v2_projection_runs WHERE thread_id = ?
      AND status NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'rolled_back')
    `);
    const childrenOf = db.prepare(`
      SELECT child_thread_id, status, completion_delivery_state, payload_json
      FROM orchestration_v2_projection_subagents WHERE thread_id = ? AND origin = 'app_owned'
    `);
    const settled = (task: ReturnType<typeof taskForInput.get>) => {
      const thread = task?.worker_thread_id;
      return (
        typeof thread === "string" &&
        TERMINAL.has(String(task?.status)) &&
        Number(activeRuns.get(thread)?.count) === 0 &&
        childrenOf
          .all(thread)
          .every(
            (child) =>
              TERMINAL.has(String(child.status)) &&
              (typeof child.child_thread_id !== "string" ||
                Number(activeRuns.get(child.child_thread_id)?.count) === 0),
          )
      );
    };
    const deadline = Date.now() + input.deadlineMs;
    let task = taskForInput.get(launch.inputId);
    while (Date.now() < deadline && !settled(task)) {
      await new Promise((done) => setTimeout(done, 1000));
      task = taskForInput.get(launch.inputId);
    }
    const parentThreadId =
      typeof task?.worker_thread_id === "string" ? task.worker_thread_id : null;
    const observationComplete = settled(task) && !NodeFS.existsSync(missingFile);
    const items = db.prepare(`
      SELECT payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ? AND type IN ('command_execution', 'dynamic_tool', 'file_search', 'file_change')
      ORDER BY updated_at, ordinal
    `);
    const report = db.prepare(`
      SELECT run_id, report_json FROM thread_run_results WHERE thread_id = ? ORDER BY reported_at
    `);
    const getReports = (threadId: string) =>
      report.all(threadId).map((row) => ({
        runId: String(row.run_id),
        outcome: String(readJson(row.report_json)["outcome"]),
        summary: readJson(row.report_json)["summary"] ?? null,
      }));
    const parentItems =
      parentThreadId === null
        ? []
        : items.all(parentThreadId).map((row) => readJson(row.payload_json));
    const reports = parentThreadId === null ? [] : getReports(parentThreadId);
    const calls = parentItems.flatMap((item) => {
      const name = String(item["toolName"]);
      const args = object(item["input"]);
      const outcome =
        name.endsWith("goat_call") && args["path"] === "thread.report_result"
          ? object(args["args"])["outcome"]
          : name.endsWith("goat_thread_report_result")
            ? args["outcome"]
            : null;
      const output = object(item["output"]);
      const rejection = object(output["error"]);
      return typeof outcome === "string"
        ? [
            {
              outcome,
              accepted: output["status"] === "ok" || output["outcome"] === outcome,
              rejection: typeof rejection["message"] === "string" ? rejection["message"] : null,
            },
          ]
        : [];
    });
    const children = parentThreadId === null ? [] : childrenOf.all(parentThreadId);
    const modelsForThread = db.prepare(`
      SELECT DISTINCT json_extract(payload_json, '$.modelSelection.instanceId') AS instance_id,
                      json_extract(payload_json, '$.modelSelection.model') AS model
      FROM orchestration_v2_projection_runs
      WHERE thread_id = ? AND json_extract(payload_json, '$.startedAt') IS NOT NULL
    `);
    const modelMatched = (threadId: string, expected: ModelSelection) => {
      const models = modelsForThread.all(threadId);
      return (
        models.length === 1 &&
        models[0]?.instance_id === expected.instanceId &&
        models[0].model === expected.model
      );
    };
    const workers = children.map((row) => {
      const threadId = String(row.child_thread_id);
      const commands = items
        .all(threadId)
        .map((item) => readJson(item.payload_json))
        .filter((item) => item["type"] === "command_execution");
      const a = commands.filter((item) => String(item["input"]).includes(FILE_A));
      const b = commands.filter((item) => String(item["input"]).includes(FILE_B));
      const lane =
        a.length === 1 && b.length === 0 ? "A" : b.length === 1 && a.length === 0 ? "B" : null;
      const command = lane === "A" ? a[0] : lane === "B" ? b[0] : undefined;
      const deliveryState = String(row.completion_delivery_state);
      const result = readJson(row.payload_json)["result"];
      const deliveryVerified =
        ["delivered", "acknowledged"].includes(deliveryState) &&
        typeof result === "string" &&
        (lane === "A"
          ? result.includes(marker)
          : lane === "B" &&
            result.includes(FILE_B) &&
            /No such file or directory|ENOENT/.test(result));
      const report = getReports(threadId).at(-1)?.outcome ?? null;
      const commandVerified =
        lane === "A"
          ? command?.["exitCode"] === 0 && String(command["output"]).trim() === marker
          : lane === "B" &&
            typeof command?.["exitCode"] === "number" &&
            command["exitCode"] !== 0 &&
            String(command["output"]).includes("No such file or directory");
      return {
        threadId,
        status: String(row.status),
        lane,
        report,
        deliveryVerified,
        commandVerified,
        reportMismatch:
          lane === "B" &&
          commandVerified &&
          deliveryVerified &&
          report !== null &&
          report !== "failed",
        modelMatched: modelMatched(threadId, input.workerModel),
        output: typeof command?.["output"] === "string" ? command["output"].trim() : null,
      };
    });
    const parentRead = parentItems.some((item) => {
      if (
        item["type"] === "dynamic_tool" &&
        !/(read_file|readFile|filesystem|grep|exec_command)/i.test(String(item["toolName"])) &&
        !/^(filesystem|project)\.(read_file|file_read|read|search)/i.test(
          String(object(item["input"])["path"]),
        )
      )
        return false;
      const command = JSON.stringify(item["input"]);
      return command?.includes(FILE_A) || command?.includes(FILE_B);
    });
    const parentReport = reports.at(-1)?.outcome ?? null;
    const parentModelMatched =
      parentThreadId !== null && modelMatched(parentThreadId, input.parentModel);
    const taskStatus = typeof task?.status === "string" ? task.status : null;
    const verdict = gradeBotOutcome({
      a: workers.find((worker) => worker.lane === "A"),
      b: workers.find((worker) => worker.lane === "B"),
      workerCount: workers.length,
      parentRead,
      parentModelMatched,
      taskStatus,
      observationComplete,
      parentReport,
      parentAcceptedSuccessCall:
        calls.some((call) => call.outcome === "succeeded" && call.accepted) ||
        reports.some((report) => report.outcome === "succeeded"),
    });
    return {
      ...launch,
      parentThreadId,
      taskId: task?.task_id ?? null,
      taskStatus,
      observationComplete,
      parentReport,
      reports,
      calls,
      workers,
      parentRead,
      parentModelMatched,
      verdict,
    };
  } finally {
    db.close();
  }
}
