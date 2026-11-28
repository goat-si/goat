# GOAT 2 parity wire format

A process target is invoked as `<runner> --scenario DIR --out FILE`. Exit 0 means
FILE contains a valid observed trace, including non-success outcomes. A nonzero exit,
a missing file, or invalid output is a target error; retain stderr in the report.

The input alias is the `input` of its Send step. Child-originated inputs are
`<child>#<n>` in child.reported order. Runs are `r1` through `rN` per thread in
first run.started order, wakes are `w1` through `wN` per parent in child.reported
order, and calls use the Mcp step's `call`. An unmappable id is an error naming
that id. Global sequence numbers describe observation order across threads.

Each scenario's provenance cites its pinned v1 transcript and the fixture input
or integration test it mirrors. Stored transcript hashes are checked, and the
source hash is checked against `GOAT_V1_ROOT` when set. Update schemas with
`GOAT2_PARITY_BLESS=1 cargo test -p goat2-parity --test wire` and review their diff.

Scenario example:

```json
{
  "v": 1, "name": "example", "summary": "A single turn",
  "spec": ["docs/parity/example.md#r1"],
  "v1Refs": ["apps/server/example.ts:1"],
  "streams": {"main": {"engine": "codex", "transcript": "transcripts/example.ndjson", "provenance": {"source": "apps/server/example.ndjson", "commit": "pinned", "sourceSha256": "abc", "sha256": "abc"}}},
  "threads": {"main": {"kind": "user", "stream": "main"}},
  "steps": [{"do": "send", "id": "s1", "thread": "main", "input": "i1", "text": "Hello", "mode": "start"}],
  "expect": {"complete": true, "exhaustive": ["input.accepted"], "threads": {"main": [{"id": "e1", "kind": "input.accepted", "thread": "main", "input": "i1", "from": "user", "mode": "start", "text": "Hello"}]}, "happensBefore": []},
  "targets": {"v1": {"status": "pending", "reason": "driver pending"}}
}
```

Observed trace example:

```json
{
  "v": 1, "target": "v1", "scenario": "example",
  "outcome": {"outcome": "ok"},
  "events": [{"seq": 1, "kind": "input.accepted", "thread": "main", "input": "i1", "from": "user", "mode": "start", "text": "Hello"}],
  "streams": {"main": {"consumedAll": true, "outboundChecked": 1, "outboundMismatches": []}},
  "incomplete": false
}
```

GOAT 2 log mapping recognizes all 15 `LogEvent` variants. Input acceptance,
input changes, accepted steer delivery, run start/finish and child start/report
produce trace events; the other variants do not. An unknown log type marks the
trace incomplete. The harness registers request and child aliases and binds each
child input to its observed report with `AliasMap::bind_child_input`; absent
correlation is an error. GOAT 2 logs do not prove enqueue, queued wake or
cancelled wake, so the mapper never emits those transitions.
