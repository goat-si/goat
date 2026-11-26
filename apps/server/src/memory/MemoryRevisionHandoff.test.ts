import { assert, it } from "@effect/vitest";
import { MemoryId, MemoryRevisionId, type TurnMemoryResult } from "@goat/contracts";
import { confirmsRecall, summarizeNaturalTurn } from "../../scripts/memoryNaturalTurn.ts";
import * as Effect from "effect/Effect";
import { revisionHandoff } from "./memoryRevisionHandoff.testkit.ts";
import { scoreTicket } from "../../scripts/memoryHandoffScore.ts";

it.effect("compares reads of the same edited memory before and after indexing", () =>
  Effect.gen(function* () {
    const f = yield* revisionHandoff("old-fixture", "new-fixture");
    assert.notEqual(f.oldRevision, f.currentRevision);
    for (const [o, ids, coverage] of [
      [f.initial, [f.oldRevision], "complete"],
      [f.pending, [], "partial"],
      [f.indexed, [f.currentRevision], "complete"],
    ] as const) {
      assert.equal(o.result.indexCoverage.status, coverage);
      assert.deepStrictEqual(
        o.result.items.map((i) => i.revisionId),
        [...ids],
      );
      assert.deepStrictEqual(
        o.receipt.events.map((e) => [e.kind, e.items.map((i) => i.revisionId)]),
        [["recall", [...ids]]],
      );
      assert.isFalse(Boolean(o.receipt.incomplete || o.receipt.truncated));
    }
    assert.equal(f.initial.result.items[0]?.relation, "project_thread");
    assert.include(f.indexed.result.items[0]?.text, "new-fixture");
  }),
);

it("scores a ticket against the current head and the evidence actually supplied", () => {
  const grade = (answer: string, currentSupplied: boolean) =>
    scoreTicket(answer, { current: "new", previous: "old", currentSupplied });
  assert.equal(grade('{"acceptanceCode":"new"}', true), "grounded-current");
  assert.equal(grade('{"acceptanceCode":"new"}', false), "unsupported-current");
  assert.equal(grade('{"acceptanceCode":"old"}', true), "stale");
  assert.equal(grade('{"acceptanceCode":"old"}', false), "stale");
  assert.equal(grade('{"acceptanceCode":null}', false), "abstained");
  assert.equal(grade('{"acceptanceCode":null}', true), "missed-current");
  assert.equal(grade('{"acceptanceCode":"something else"}', true), "wrong-code");
  assert.equal(grade('{"acceptanceCode":"new","old":"old"}', true), "invalid-ticket");
  assert.equal(grade("new", true), "invalid-ticket");
});

const target = MemoryId.make("00000000-0000-4000-8000-000000000001");
const other = MemoryId.make("00000000-0000-4000-8000-000000000002");
const previous = MemoryRevisionId.make("00000000-0000-4000-8000-000000000003");
const current = MemoryRevisionId.make("00000000-0000-4000-8000-000000000004");
type Event = TurnMemoryResult["events"][number];
const event = (kind: Event["kind"], items: Event["items"]): Event => ({
  id: kind,
  kind,
  query: null,
  items,
});
const item = (revisionId: MemoryRevisionId, memoryId = target) => ({
  memoryId,
  revisionId,
  excerpt: null,
});
const gradeInstall = (
  events: readonly Event[],
  options: Partial<Parameters<typeof summarizeNaturalTurn>[0]> = {},
) =>
  summarizeNaturalTurn({
    answer: "pnpm install",
    memoryId: target,
    expected: "pnpm",
    previousRevision: previous,
    currentRevision: current,
    receipt: { events, truncated: false },
    tools: [],
    ...options,
  });

it("credits an automatically delivered edit without requiring a lookup", () => {
  const report = gradeInstall([event("automatic", [item(current)])]);
  assert.equal(report.outcome, "grounded-current");
  assert.deepEqual(report.automatic, [current]);
  assert.deepEqual(report.recalled, []);
  assert.equal(report.recallToolCalls, 0);
  assert.equal(report.recallEvents, 0);
});

it("distinguishes a voluntary recall from discovery and from another memory", () => {
  for (const toolName of [
    "goat.goat_call",
    "mcp__goat__goat_call",
    "goat_goat_call",
    "goat_call",
  ]) {
    const report = gradeInstall(
      [
        event("automatic", [item(previous), item(current, other)]),
        event("recall", [item(current)]),
      ],
      {
        tools: [
          { toolName: "goat.goat_describe", input: { path: "memory.recall" } },
          { toolName, input: { resource: "memory", verb: "recall" } },
        ],
      },
    );
    assert.equal(report.outcome, "grounded-current");
    assert.deepEqual(report.automatic, [previous]);
    assert.deepEqual(report.recalled, [current]);
    assert.equal(report.recallToolCalls, 1);
    assert.equal(report.recallEvents, 1);
    assert.isFalse(report.incomplete);
  }
});

it("retains misses, missing receipts and stale or ambiguous answers as separate outcomes", () => {
  const tools = [{ toolName: "goat.goat_call", input: { path: "memory.recall" } }];
  const miss = gradeInstall([event("recall", [])], { tools });
  assert.equal(miss.outcome, "unsupported-current");
  assert.equal(miss.recallEvents, 1);
  assert.deepEqual(miss.recalled, []);
  assert.equal(gradeInstall([], { tools }).outcome, "evidence-incomplete");
  assert.equal(
    gradeInstall([], { receipt: { events: [], truncated: true } }).outcome,
    "evidence-incomplete",
  );
  assert.equal(
    gradeInstall([event("automatic", [item(current, other)])]).outcome,
    "unsupported-current",
  );
  const supplied = [event("automatic", [item(current)])];
  assert.equal(gradeInstall(supplied, { answer: "npm install" }).outcome, "stale");
  assert.equal(
    gradeInstall(supplied, { answer: "npm install or pnpm install" }).outcome,
    "other-answer",
  );
  assert.equal(gradeInstall(supplied, { answer: "`pnpm install`" }).outcome, "grounded-current");
});

it("only confirms an identifiable, single GOAT recall in supervised mode", () => {
  const request = { requestKind: "mcp-elicitation", appName: "goat", prompt: 'Use "goat_call"?' };
  const call = { toolName: "goat.goat_call", input: { path: "memory.recall" } };
  assert.isTrue(confirmsRecall(request, [call]));
  assert.isFalse(confirmsRecall({ requestKind: "mcp-elicitation", appName: "goat" }, [call]));
  assert.isFalse(confirmsRecall({ ...request, appName: "external" }, [call]));
  assert.isFalse(confirmsRecall({ ...request, requestKind: "command" }, [call]));
  assert.isFalse(confirmsRecall({ ...request, prompt: 'Use "other"?' }, [call]));
  assert.isFalse(confirmsRecall(request, [call, call]));
  assert.isFalse(confirmsRecall(request, [{ ...call, input: { path: "memory.save" } }]));
});
