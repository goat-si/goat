// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
import * as NodeSqlite from "node:sqlite";
import {
  parseWorkerOrder,
  prepareWorkerOrder,
  readWorkerOrder,
  workerOrderPrompt,
  type WorkerOrder,
} from "./worker-order-fixture.ts";

type Fixture = ReturnType<typeof readWorkerOrder>;
type Artifact = Fixture["a"];

interface Probe {
  readonly start: number;
  readonly end: number;
}

function findProbe(db: NodeSqlite.DatabaseSync, threadId: string, artifact: Artifact) {
  const rows = db
    .prepare(`
    SELECT json_extract(payload_json, '$.output') AS output,
           json_extract(payload_json, '$.startedAt') AS started,
           json_extract(payload_json, '$.completedAt') AS completed
    FROM orchestration_v2_projection_turn_items
    WHERE thread_id = ? AND type = 'command_execution' AND status = 'completed'
      AND json_extract(payload_json, '$.exitCode') = 0
      AND instr(json_extract(payload_json, '$.input'), 'probe.mjs') > 0
  `)
    .all(threadId);
  const matches: Probe[] = [];
  for (const { output, started, completed } of rows) {
    if (typeof output !== "string") continue;
    const match = /^WORKER_ORDER (\S+) (\d+) (\d+) (\S+)$/.exec(output.trim());
    if (!match || match[1] !== artifact.file || match[4] !== artifact.value) continue;
    const start = Math.max(Number(match[2]), Date.parse(String(started)));
    const end = Math.min(Number(match[3]), Date.parse(String(completed)));
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && start < end) {
      matches.push({ start, end });
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

export function scoreWorkerOrder(
  db: NodeSqlite.DatabaseSync,
  inputId: string | undefined,
  order: WorkerOrder,
  workspace: string,
  fixture: Fixture,
) {
  const prompt = workerOrderPrompt(order, workspace);
  if (inputId === undefined) {
    const matches = db
      .prepare(`
      SELECT input_id FROM channel_inbox WHERE kind = 'goat'
        AND rtrim(json_extract(message_json,'$.text'), char(13) || char(10) || ' ') = ?
      LIMIT 2
    `)
      .all(prompt);
    if (matches.length !== 1 || typeof matches[0]?.input_id !== "string") {
      throw new Error(
        "Expected one matching Bot input. Supply its input ID when reusing a fixture.",
      );
    }
    inputId = matches[0].input_id;
  }
  const task = db
    .prepare(`
    SELECT t.task_id, t.status, t.worker_thread_id, i.state AS inbox_state,
           json_extract(i.message_json, '$.text') AS prompt,
           json_extract(i.message_json, '$.replyAddress.threadId') AS destination
    FROM channel_inbox i JOIN channel_tasks t ON t.bot_id = i.bot_id AND
      json_extract(t.task_json,'$.originInputId') = i.input_id AND json_extract(t.task_json,'$.kind') = 'turn'
    WHERE i.input_id = ? AND i.kind = 'goat'
  `)
    .get(inputId);
  if (
    !task ||
    typeof task.prompt !== "string" ||
    task.prompt.trimEnd() !== prompt ||
    typeof task.destination !== "string" ||
    typeof task.task_id !== "string" ||
    typeof task.worker_thread_id !== "string"
  ) {
    throw new Error("Expected a Bot turn for this input ID, prompt and fixture directory.");
  }
  const children = db
    .prepare(`
    SELECT child_thread_id, status, started_at, completed_at, completion_delivery_state,
           json_extract(payload_json, '$.prompt') AS assignment,
           json_extract(payload_json, '$.result') AS result,
           (SELECT json_extract(report_json, '$.outcome') FROM thread_run_results r
               WHERE r.thread_id = s.child_thread_id ORDER BY r.reported_at DESC LIMIT 1) AS report
    FROM orchestration_v2_projection_subagents s WHERE s.thread_id = ?
  `)
    .all(task.worker_thread_id);
  const workers = children.map((child) => {
    const thread = typeof child.child_thread_id === "string" ? child.child_thread_id : "";
    const a = findProbe(db, thread, fixture.a);
    const b = findProbe(db, thread, fixture.b);
    const lane = a && !b ? "a" : b && !a ? "b" : undefined;
    return {
      thread,
      lane,
      probe: a ?? b,
      launch: Date.parse(String(child.started_at)),
      completion: Date.parse(String(child.completed_at)),
      receivedA: typeof child.assignment === "string" && child.assignment.includes(fixture.a.value),
      delivered:
        lane !== undefined &&
        child.status === "completed" &&
        (child.report === null || child.report === "succeeded") &&
        (child.completion_delivery_state === "delivered" ||
          child.completion_delivery_state === "acknowledged") &&
        typeof child.result === "string" &&
        child.result.includes(fixture[lane].value),
    };
  });
  const reply = db
    .prepare(`
    SELECT kind, state, json_extract(message_json, '$.text') AS text FROM channel_outbox
    WHERE destination_kind = 'goat' AND json_extract(message_json,'$.destination.threadId') = ?
      AND (input_id = ? OR task_id = ?) AND kind IN ('result', 'reply', 'receipt', 'failure')
    ORDER BY CASE WHEN kind IN ('result', 'failure') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1
  `)
    .get(task.destination, inputId, task.task_id);
  const a = workers.find((worker) => worker.lane === "a");
  const b = workers.find((worker) => worker.lane === "b");
  const bothDelivered =
    workers.length === 2 && a?.delivered === true && b?.delivered === true && a.thread !== b.thread;
  const overlapMs =
    a?.probe && b?.probe
      ? Math.max(0, Math.min(a.probe.end, b.probe.end) - Math.max(a.probe.start, b.probe.start))
      : null;
  const dependent =
    a?.probe && b?.probe && b.receivedA && a.completion < b.launch && a.probe.end <= b.probe.start;
  const parentProbe = db
    .prepare(`
    SELECT 1 FROM orchestration_v2_projection_turn_items WHERE thread_id = ? AND type = 'command_execution'
      AND instr(json_extract(payload_json, '$.input'), 'probe.mjs') > 0 LIMIT 1
  `)
    .get(task.worker_thread_id);
  const checks = {
    bothDelivered,
    noParentProbe: !parentProbe,
    ordered: order === "parallel" ? overlapMs !== null && overlapMs > 0 : dependent === true,
    completed:
      task.status === "completed" && task.inbox_state === "replied" && reply?.kind !== "failure",
    deliveredValues:
      reply?.state === "delivered" &&
      typeof reply.text === "string" &&
      reply.text.includes(fixture.a.value) &&
      reply.text.includes(fixture.b.value),
  };
  return {
    inputId,
    order,
    taskStatus: task.status,
    replyKind: reply?.kind ?? null,
    workers,
    overlapMs,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

if (import.meta.main) {
  const [action, mode, workspace, database, inputId] = process.argv.slice(2);
  const order = parseWorkerOrder(mode);
  if (action === "prepare" && workspace && !database) {
    console.log(prepareWorkerOrder(order, workspace));
  } else if (action === "score" && workspace && database) {
    const fixture = readWorkerOrder(order, workspace);
    const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
    try {
      db.exec("BEGIN");
      const row = scoreWorkerOrder(db, inputId, order, workspace, fixture);
      console.log(JSON.stringify(row));
      if (!row.pass) process.exitCode = 1;
    } finally {
      db.close();
    }
  } else {
    throw new Error(
      "Usage: worker-order.ts prepare <parallel|dependent> <new directory>, or score <parallel|dependent> <directory> <database> [input ID]",
    );
  }
}
