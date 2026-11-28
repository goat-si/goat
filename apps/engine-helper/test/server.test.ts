import assert from "node:assert/strict";
import { test } from "node:test";

import { createServer } from "../src/server.ts";
import { engineLoaders } from "../src/engines.ts";

function harness() {
  const lines: Array<Record<string, unknown>> = [];
  const exits: number[] = [];
  const server = createServer({
    engines: engineLoaders,
    write: (line, done) => {
      lines.push(JSON.parse(line));
      done?.();
    },
    exit: (code) => exits.push(code),
    now: () => "2026-11-28T00:00:00.000Z",
  });
  const waitFor = async (predicate: (line: Record<string, unknown>) => boolean) => {
    for (let i = 0; i < 200; i += 1) {
      const found = lines.find(predicate);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out; saw ${JSON.stringify(lines)}`);
  };
  return { server, lines, exits, waitFor };
}

const init = {
  protocol: 1,
  engine: "fake",
  threadId: "t1",
  cwd: "/tmp",
  resume: null,
  modelSelection: { instanceId: "fake", model: "m" },
  runtimeMode: "full-access",
  mcp: null,
  instructions: null,
  launch: null,
};

test("initialize, echo turn, shutdown", async () => {
  const h = harness();
  h.server.handleLine(JSON.stringify({ id: 1, method: "initialize", params: init }));
  assert.deepEqual((await h.waitFor((l) => l.id === 1)).result, { engineRef: "fake-t1" });
  h.server.handleLine(
    JSON.stringify({
      id: 2,
      method: "turn.start",
      params: { inputs: [{ inputId: "i1", text: "hi", attachments: [] }], settings: init },
    }),
  );
  assert.deepEqual((await h.waitFor((l) => l.id === 2)).result, { status: "accepted", turnId: "turn-1" });
  const finished = await h.waitFor((l) => (l.event as { type?: string } | undefined)?.type === "turn_finished");
  assert.deepEqual(finished.event, { type: "turn_finished", turnId: "turn-1", outcome: { type: "done" } });
  const completed = h.lines.find((l) => (l.event as { type?: string } | undefined)?.type === "item_completed");
  assert.equal((completed?.event as { item: { text: string } }).item.text, "echo: hi");
  h.server.handleLine(JSON.stringify({ id: 3, method: "shutdown" }));
  await h.waitFor((l) => l.id === 3);
  assert.deepEqual(h.exits, [0]);
});

test("requests before initialize and unknown methods are bad_request", async () => {
  const h = harness();
  h.server.handleLine(JSON.stringify({ id: 1, method: "turn.start", params: {} }));
  h.server.handleLine(JSON.stringify({ id: 2, method: "nope" }));
  h.server.handleLine("not json");
  assert.equal(((await h.waitFor((l) => l.id === 1)).error as { code: string }).code, "bad_request");
  assert.equal(((await h.waitFor((l) => l.id === 2)).error as { code: string }).code, "bad_request");
  assert.ok(h.lines.some((l) => l.log !== undefined));
});

test("an engine that fails to load answers unavailable", async () => {
  const h = harness();
  h.server.handleLine(JSON.stringify({ id: 1, method: "initialize", params: { ...init, engine: "muse" } }));
  assert.equal(((await h.waitFor((l) => l.id === 1)).error as { code: string }).code, "unavailable");
});

test("fail emits exited once and exits 1", async () => {
  const h = harness();
  h.server.fail("boom");
  h.server.fail("again");
  assert.deepEqual(h.lines, [{ event: { type: "exited", reason: "boom" } }]);
  assert.deepEqual(h.exits, [1]);
});
