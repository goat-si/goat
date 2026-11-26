// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - offline eval against a recorded Bot session.
import * as NodeSqlite from "node:sqlite";

export const DIRECT_CHAT_PROMPT =
  "What is the capital of France? Please reply with just the city name.";

export function scoreDirectChat(db: NodeSqlite.DatabaseSync, inputId: string) {
  const input = db
    .prepare(`
    SELECT input_id, bot_id, state, json_extract(message_json,'$.text') AS prompt,
           json_extract(message_json,'$.replyAddress.threadId') AS destination
    FROM channel_inbox WHERE input_id = ? AND kind = 'goat'
      AND json_extract(message_json,'$.intent') = 'message'
      AND json_extract(message_json,'$.actor.senderThreadId') IS NULL
  `)
    .get(inputId);
  if (
    !input ||
    input.prompt !== DIRECT_CHAT_PROMPT ||
    typeof input.destination !== "string" ||
    typeof input.bot_id !== "string"
  )
    throw new Error("Expected a GOAT input containing the direct-chat prompt.");
  const asks = db
    .prepare(`
    SELECT COUNT(*) AS n FROM channel_inbox WHERE bot_id = ?
    AND json_extract(message_json,'$.intent') = 'message'
    AND json_extract(message_json,'$.actor.senderThreadId') IS NULL
  `)
    .get(input.bot_id);
  if (Number(asks?.n) !== 1 || input.bot_id === "main")
    throw new Error("Use a fresh member Bot with one user message per sample.");

  const tasks = db
    .prepare(`
    SELECT task_id, worker_thread_id, status, json_extract(task_json,'$.kind') AS kind,
           json_extract(task_json,'$.originInputId') AS origin
    FROM channel_tasks WHERE bot_id = ?
  `)
    .all(input.bot_id);
  const turn = tasks.find((task) => task.kind === "turn" && task.origin === inputId);
  const thread = typeof turn?.worker_thread_id === "string" ? turn.worker_thread_id : null;
  const records = db
    .prepare(`
    SELECT status, json_extract(payload_json,'$.modelSelection.instanceId') AS provider,
           json_extract(payload_json,'$.modelSelection.model') AS model
    FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal
  `)
    .all(thread);
  const children = db
    .prepare(`
    SELECT COUNT(*) AS n FROM orchestration_v2_projection_subagents WHERE thread_id = ?
  `)
    .get(thread);
  const admissions = db
    .prepare(`
    SELECT COUNT(*) AS n FROM channel_runtime_state
    WHERE key >= ('child-work:' || ? || ':') AND key < ('child-work:' || ? || ';')
  `)
    .get(turn?.task_id ?? null, turn?.task_id ?? null);
  const calls = db
    .prepare(`
    SELECT type, json_extract(payload_json,'$.toolName') AS name,
           json_extract(payload_json,'$.input.path') AS path
    FROM orchestration_v2_projection_turn_items WHERE thread_id = ?
      AND (type IN ('dynamic_tool','file_search','file_change','web_search','thread_created','subagent','fork') OR (type = 'command_execution' AND
        (json_extract(payload_json,'$.providerTurnId') IS NOT NULL OR
         COALESCE(json_extract(payload_json,'$.input'),'') <> 'Preparing workspace')))
  `)
    .all(thread);
  const unexpectedCalls = calls
    .filter((call) => {
      const name = String(call.name ?? "");
      if (
        [
          "goat.goat_describe",
          "goat.goat_channel_task_report",
          "goat.goat_thread_report_result",
        ].includes(name)
      )
        return false;
      return !(
        name === "goat.goat_call" &&
        ["channel.task_report", "thread.report_result"].includes(String(call.path))
      );
    })
    .map((call) => call.path ?? call.name ?? call.type);
  const delivery = db
    .prepare(`
    SELECT kind, state, json_extract(message_json,'$.text') AS text
    FROM channel_outbox WHERE destination_kind = 'goat' AND kind IN ('result','receipt','reply','failure')
      AND json_extract(message_json,'$.destination.threadId') = ? AND (input_id = ? OR task_id = ?)
    ORDER BY CASE WHEN kind IN ('result','failure') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 1
  `)
    .get(input.destination, inputId, turn?.task_id ?? null);
  const extraTasks = tasks.length - (turn ? 1 : 0);
  const childCount = Number(children?.n ?? 0);
  const admittedChildWork = Number(admissions?.n ?? 0);
  const checks = {
    completed:
      input.state === "replied" &&
      turn?.status === "completed" &&
      records.length > 0 &&
      records.every((run) => run.status === "completed" && typeof run.model === "string"),
    deliveredAnswer:
      delivery?.state === "delivered" &&
      delivery.kind !== "failure" &&
      typeof delivery.text === "string" &&
      /^paris[.!]?$/i.test(delivery.text.trim()),
    noChildWork: childCount === 0 && admittedChildWork === 0 && extraTasks === 0,
    directTools: unexpectedCalls.length === 0,
  };
  return {
    inputId,
    thread,
    records,
    extraTasks,
    childCount,
    admittedChildWork,
    delivery,
    unexpectedCalls,
    checks,
    pass: Object.values(checks).every(Boolean),
  };
}

if (import.meta.main) {
  const [database, inputId] = process.argv.slice(2);
  if (!database) throw new Error("Usage: node direct-chat.ts <eval database> [input ID]");
  const db = new NodeSqlite.DatabaseSync(database, { readOnly: true });
  try {
    db.exec("BEGIN");
    const samples = inputId
      ? [inputId]
      : db
          .prepare(`
      SELECT input_id FROM channel_inbox WHERE kind = 'goat' AND json_extract(message_json,'$.text') = ?
        AND json_extract(message_json,'$.intent') = 'message'
        AND json_extract(message_json,'$.actor.senderThreadId') IS NULL
      ORDER BY accepted_at
    `)
          .all(DIRECT_CHAT_PROMPT)
          .map((row) => String(row.input_id));
    if (!samples.length) throw new Error("No recorded direct-chat samples.");
    for (const id of samples) {
      const row = scoreDirectChat(db, id);
      console.log(JSON.stringify(row));
      if (!row.pass) process.exitCode = 1;
    }
  } finally {
    db.close();
  }
}
