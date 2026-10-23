# Re-scoring the Claude rows

[runs.jsonl](runs.jsonl) is unchanged. [rescored.jsonl](rescored.jsonl) is derived from it with
the fixed model check (`sameModel` in [core.ts](../../core.ts)), which accepts a reviewer's model
reported as `<instance> / <model>`, `<instance>/<model>`, or the bare id.

- fan-out-review pairs 0 and 2 failed only because they reported `codex / <model>`, the form the
  prompt lists. They answered in the launched run, so their metrics are complete; in
  rescored.jsonl they pass, and `rescore.dropped` lists the failures removed.
- fan-out-review pairs 1 and 3-9 are superseded and left out of rescored.jsonl. Each answered in
  a later run woken by a delegated review's delivery, which the runner at bb7f97ae2 did not
  measure, so the rows hold neither the answer nor the cost.
- read-control and wait-running rows are copied unchanged.

These are reference numbers from a one-arm campaign on task set 2, not paired with any other arm.
[report-rescored.md](report-rescored.md) is built from rescored.jsonl:

```sh
node scripts/agent-surface/eval/report.ts --campaign scripts/agent-surface/eval/results/261023-full-claude-mbp/campaign.json \
  --budget scripts/agent-surface/eval/results/261023-full-claude-mbp/context-budget.json scripts/agent-surface/eval/results/261023-full-claude-mbp/rescored.jsonl > scripts/agent-surface/eval/results/261023-full-claude-mbp/report-rescored.md
```

rescored.jsonl was written from the repository root with:

```sh
node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
import { sameModel } from "./scripts/agent-surface/eval/core.ts";
const dir = "scripts/agent-surface/eval/results/261023-full-claude-mbp/";
const campaign = JSON.parse(readFileSync(dir + "campaign.json", "utf8"));
const instanceOf = (model) => campaign.reviewModels.find((m) => m.model === model)?.instanceId;
const out = [];
for (const line of readFileSync(dir + "runs.jsonl", "utf8").trim().split("\n")) {
  const row = JSON.parse(line);
  const spelled = row.failures.map((f) => /reported model "(.*)", ran (\S+)$/.exec(f));
  const dropped = row.failures.filter((f, i) => spelled[i] !== null &&
    sameModel(spelled[i][1], { instanceId: instanceOf(spelled[i][2]), model: spelled[i][2] }));
  if (row.failures.some((f) => f.startsWith("0 EVAL_JSON"))) continue;
  const failures = row.failures.filter((f) => !dropped.includes(f));
  out.push(JSON.stringify(dropped.length === 0 ? row : { ...row, ok: failures.length === 0,
    failures, rescore: { scorer: "sameModel", dropped } }));
}
writeFileSync(dir + "rescored.jsonl", out.join("\n") + "\n");
'
```
