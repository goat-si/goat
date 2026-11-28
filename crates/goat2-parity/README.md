# GOAT 2 parity wire format

A process target is invoked as `<runner> --scenario DIR --out FILE`. Exit 0 means
FILE contains a valid observed trace, including non-success outcomes. A nonzero exit,
a missing file, or invalid output is a target error; retain stderr in the report.

The input alias is the `input` of its Send step. Child-originated inputs are
`<child>#<n>` in child.reported order. Runs are `r1` through `rN` per thread in
first run.started order, wakes are `w1` through `wN` per parent in child.reported
order, and calls use the Mcp step's `call`. An unmappable id is an error naming
that id. Global sequence numbers describe observation order across threads.

Multi-thread and MCP scenarios: a call to a path that puts a message into a thread
(`task.create`, `thread.send`) names that input after the call id. Child threads
bind to the declared threads whose `parent` is the creating thread, in creation
order. Mcp `args` may use `$thread:<alias>` for a thread id and
`$result:<call>.<field>` for a field of an earlier call's result. A run-status
wait for `running` is satisfied once the run's own engine turn runs. Tool results
are ordered after every stored event at or below the highest sequence read when
the call returned (events committed in between may precede them).

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

## GOAT 2 target

`cargo run -p goat2-parity -- run --target goat2` runs `goat2-parity-goat2-runner` per scenario. It starts a
real `goat2-host` (`GOAT2_HOST_BIN`, default next to the runner) on a temporary data dir with
`GOAT2_ENGINE=codex` and `GOAT2_CODEX_BIN` pointing at `goat2-parity-fake-codex`, drives the steps over the
host WebSocket (start_thread, send_input, queue commands, stop), reads the thread log (the lines before the
replayed checkpoint through read_page) and maps it with `AliasMap`. The fake replays the scenario's v1
recording method by method (GOAT 2 frames differ from v1's): each process claims one native thread, answers
each request from the next recorded exchange of that method, skips v1 setup reads, never skips a thread or
turn request, compares turn/start and turn/steer text, and reports per claim in `GOAT2_PARITY_FAKE_DIR`.
GOAT 2 logs a thread's first input as steer; a requested start observed as steer with no active run maps to
start. Single-thread scenarios without MCP or restart steps only, so far; others report unsupported.
REQUIRED.json gates the v1 target only.
