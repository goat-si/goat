# Recorded fixture review

Each recording was made with `examples/record_codex.rs` against codex-cli 0.167.0 (model gpt-6-luna, low effort),
driven through `CodexEngineFactory` (the driver itself, with a recording tap), redacted fail-closed,
schema-validated and privacy-scanned by the recorder, then read by a person: every string that survived
redaction was listed and checked (protocol values, ids, the T3 Code client identity, the synthetic prompts and
commands, the scripted answers, the placeholder MCP URL and token). A fixture whose sha256 is not listed here
fails `tests/recording_privacy.rs`; re-review after any change.

| File | sha256 | Reviewer | Date | Note |
|---|---|---|---|---|
| approval.json | b2d54968a923c45900477d3a216cc3f6d509e4a6949e21cdc74c5f02309a3552 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| basic.json | 4095806de91363973c02a9a188a39b4790247978430e57006c06113ec3effb3f | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| interrupt.json | f056f0c597ae09d2ea01834decbd9f637f0d997f8099081aa109cc032fcf896f | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| resume.json | 4500c38a1adc2588b63588e9a6e29f7d17f6d8d7a34577b34255cd05f9edc308 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| steer.json | b9847a2688f2539f90492e49f8678ac919a67f52b86df1582eba3bb4e5ace5c5 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
