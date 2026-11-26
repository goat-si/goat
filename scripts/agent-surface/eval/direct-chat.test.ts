// @effect-diagnostics nodeBuiltinImport:off - exercises the read-only scorer against synthetic SQLite records.
import * as NodeSqlite from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";
import { DIRECT_CHAT_PROMPT, scoreDirectChat } from "./direct-chat.ts";

let db: NodeSqlite.DatabaseSync;
beforeEach(() => {
  db = new NodeSqlite.DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE channel_inbox (input_id, bot_id, state, message_json, kind);
    CREATE TABLE channel_runtime_state (key TEXT PRIMARY KEY, value_json);
    CREATE TABLE channel_tasks (task_id, bot_id, worker_thread_id, status, task_json);
    CREATE TABLE channel_outbox (task_id, input_id, kind, destination_kind, state, created_at, message_json);
    CREATE TABLE orchestration_v2_projection_runs (thread_id, status, ordinal, payload_json);
    CREATE TABLE orchestration_v2_projection_subagents (thread_id);
    CREATE TABLE orchestration_v2_projection_turn_items (thread_id, type, payload_json);
    INSERT INTO channel_tasks VALUES ('t','member','bot-session','completed','{"kind":"turn","originInputId":"input"}');
    INSERT INTO orchestration_v2_projection_runs VALUES ('bot-session','completed',1,'{"modelSelection":{"instanceId":"codex","model":"example"}}');
    INSERT INTO channel_outbox VALUES ('t','input','receipt','goat','delivered',1,'{"destination":{"threadId":"member-thread"},"text":"Paris"}');
  `);
  db.prepare("INSERT INTO channel_inbox VALUES ('input','member','replied',?,'goat')").run(
    JSON.stringify({
      intent: "message",
      replyAddress: { threadId: "member-thread" },
      text: DIRECT_CHAT_PROMPT,
    }),
  );
});
afterEach(() => db.close());

it("accepts the delivered answer and the normal server workspace preparation", () => {
  db.exec(
    `INSERT INTO orchestration_v2_projection_turn_items VALUES ('bot-session','command_execution','{"providerTurnId":null,"input":"Preparing workspace"}')`,
  );
  expect(scoreDirectChat(db, "input").pass).toBe(true);
});

it.each([
  [
    "a secondary channel task",
    `INSERT INTO channel_tasks VALUES ('other','member',NULL,'running','{"kind":"coding"}')`,
  ],
  [
    "admitted remote work with no local child or tool call",
    `INSERT INTO channel_runtime_state VALUES ('child-work:t:remote','{"state":"launching"}')`,
  ],
  [
    "a recorded subagent",
    `INSERT INTO orchestration_v2_projection_subagents VALUES ('bot-session')`,
  ],
  [
    "a created thread even if no subagent record exists",
    `INSERT INTO orchestration_v2_projection_turn_items VALUES ('bot-session','thread_created','{"targetThreadId":"child"}')`,
  ],
  [
    "a dispatch tool attempt without a resulting child",
    `INSERT INTO orchestration_v2_projection_turn_items VALUES ('bot-session','dynamic_tool','{"toolName":"goat.goat_call","input":{"path":"task.create"}}')`,
  ],
  [
    "a real command with the same label as the workspace preparation",
    `INSERT INTO orchestration_v2_projection_turn_items VALUES ('bot-session','command_execution','{"providerTurnId":"p","input":"Preparing workspace"}')`,
  ],
  ["a pending delivery", "UPDATE channel_outbox SET state='pending'"],
  ["a run still in progress", "UPDATE orchestration_v2_projection_runs SET status='running'"],
  [
    "a wrong final answer after a correct receipt",
    `INSERT INTO channel_outbox VALUES ('t',NULL,'result','goat','delivered',2,'{"destination":{"threadId":"member-thread"},"text":"Berlin"}')`,
  ],
])("rejects %s", (_, statement) => {
  db.exec(statement);
  expect(scoreDirectChat(db, "input").pass).toBe(false);
});

it("requires a single user message in the member Bot", () => {
  db.exec(
    "INSERT INTO channel_inbox SELECT 'other',bot_id,state,message_json,kind FROM channel_inbox",
  );
  expect(() => scoreDirectChat(db, "input")).toThrow("fresh member Bot");
});
