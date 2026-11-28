# Recorded fixture review

Each recording was made with `examples/record_codex.rs` against codex-cli 0.167.0 (model gpt-6-luna, low effort),
driven through `CodexEngineFactory` (the driver itself, with a recording tap), redacted fail-closed,
schema-validated and privacy-scanned by the recorder, then read by a person: every string that survived
redaction was listed and checked (protocol values, ids, the T3 Code client identity, the synthetic prompts and
commands, the scripted answers, the placeholder MCP URL and token). A fixture whose sha256 is not listed here
fails `tests/recording_privacy.rs`; re-review after any change.

| File | sha256 | Reviewer | Date | Note |
|---|---|---|---|---|
| approval.json | 4b70eb6d6b6bbe0c1c289c537c7fed5149b5367961ca4ee90b6a4fd93c088fe9 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| basic.json | a2252587705f186444987c9fe07557617a3fcc6556cdad3bd011aa910f6a3ccf | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| interrupt.json | 36b7eeda38c26b4a2931d8cb256b87547c668479f44587ee560dace41292be3f | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| resume.json | 84a5ffa6f1e57b80c344542b608faa5b2d259bc8c19f5e4939f36cca75ea1488 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| steer.json | 75218bff7971e4b4c95aabd7640365545485402e3fc50653c7fdd78a05cc161a | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
