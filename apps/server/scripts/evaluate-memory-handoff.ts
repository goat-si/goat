// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - standalone opt-in eval.
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { revisionHandoff } from "../src/memory/memoryRevisionHandoff.testkit.ts";
import { scoreTicket } from "./memoryHandoffScore.ts";

const { values } = NodeUtil.parseArgs({
  options: { live: { type: "boolean" }, model: { type: "string" } },
});
const endpoint = process.env.GOAT_MEMORY_EVAL_COMPLETIONS_URL;
if (values.live && !values.model)
  throw new Error("--live requires --model and GOAT_MEMORY_EVAL_COMPLETIONS_URL");

type Message = { role: "user" | "assistant" | "system"; content: string };
const decodeCompletion = Schema.decodeUnknownSync(
  Schema.Struct({
    choices: Schema.Array(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })),
  }),
);
async function complete(messages: readonly Message[]): Promise<string> {
  const token = process.env.GOAT_MEMORY_EVAL_API_KEY;
  if (!endpoint) throw new Error("Set GOAT_MEMORY_EVAL_COMPLETIONS_URL for live runs");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    signal: AbortSignal.timeout(90000),
    redirect: "error",
    body: JSON.stringify({ model: values.model, messages, temperature: 0 }),
  });
  if (!response.ok) throw new Error("Model endpoint returned HTTP " + response.status);
  const data = decodeCompletion(await response.json());
  const content = data.choices[0]?.message.content;
  if (typeof content !== "string") throw new Error("Model endpoint returned no assistant text");
  return content;
}

// Short, unpredictable tokens keep the task about revision choice, not copying long IDs.
const oldCode = NodeCrypto.randomUUID().slice(0, 8);
const currentCode = NodeCrypto.randomUUID().slice(0, 8);
if (currentCode === oldCode) throw new Error("Fixture generated identical codes; repeat the run");
const fixture = await Effect.runPromise(revisionHandoff(oldCode, currentCode));
type Observation = typeof fixture.initial;
const request = (observation: Observation): Message => ({
  role: "user",
  content:
    "Issue the release ticket using the currently verified acceptance code.\n" +
    "Memory lookup for this turn:\n" +
    JSON.stringify({
      coverage: observation.result.indexCoverage.status,
      items: observation.result.items.map((i) => i.text),
    }),
});
function reportedRevisions(observation: Observation) {
  return observation.receipt.events
    .filter((e) => e.kind === "recall")
    .flatMap((e) =>
      e.items.filter((i) => i.memoryId === fixture.memoryId).map((i) => i.revisionId),
    );
}
function evidence(observation: Observation) {
  const supplied = observation.result.items.map((i) => i.revisionId);
  const recorded = reportedRevisions(observation);
  if (
    observation.receipt.incomplete ||
    observation.receipt.truncated ||
    observation.receipt.events.length !== 1 ||
    supplied.length !== recorded.length ||
    supplied.some((id, i) => id !== recorded[i])
  )
    throw new Error("Recall and Turn memory disagree for " + observation.runId);
  return {
    runId: observation.runId,
    coverage: observation.result.indexCoverage.status,
    returned: observation.result.items.map(({ revisionId, text }) => ({ revisionId, text })),
    recorded,
  };
}
const prior = evidence(fixture.initial);
const pending = evidence(fixture.pending);
const indexed = evidence(fixture.indexed);
const report = {
  version: 1,
  model: values.live ? values.model : null,
  truth: {
    oldCode,
    currentCode,
    oldRevision: fixture.oldRevision,
    currentRevision: fixture.currentRevision,
  },
  prior,
  pending,
  indexed,
};

if (!values.live) {
  console.log(JSON.stringify(report));
} else {
  const history: Message[] = [
    {
      role: "system",
      content:
        'Return exactly one JSON object with the single field "acceptanceCode". Output raw JSON with no Markdown or code fences. Use the exact code, or null if current memory cannot verify it. Codes can change between tickets.',
    },
    request(fixture.initial),
  ];
  const priorTicket = await complete(history);
  const qualified =
    prior.recorded.includes(fixture.oldRevision) &&
    scoreTicket(priorTicket, { current: oldCode, previous: currentCode, currentSupplied: true }) ===
      "grounded-current";
  if (!qualified) {
    console.log(JSON.stringify({ ...report, priorTicket, qualified, arms: [] }));
  } else {
    history.push({ role: "assistant", content: priorTicket });
    const arms = [];
    for (const phase of ["pending", "indexed"] as const) {
      const answer = await complete([...history, request(fixture[phase])]);
      arms.push({
        phase,
        answer,
        outcome: scoreTicket(answer, {
          previous: oldCode,
          current: currentCode,
          currentSupplied: report[phase].recorded.includes(fixture.currentRevision),
        }),
      });
    }
    console.log(JSON.stringify({ ...report, priorTicket, qualified, arms }));
  }
}
