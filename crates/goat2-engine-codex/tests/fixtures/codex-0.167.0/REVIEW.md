# Recorded fixture review

Each recording was made with `examples/record_codex.rs` against codex-cli 0.167.0 (model gpt-6-luna, low effort),
redacted fail-closed, schema-validated and privacy-scanned by the recorder, then read by a person: every string
that survived redaction was listed and checked (protocol values, ids, process numbers, the synthetic prompts and
commands, the scripted answers, the placeholder MCP URL and token). A fixture whose sha256 is not listed here
fails `tests/recording_privacy.rs`; re-review after any change.

| File | sha256 | Reviewer | Date | Note |
|---|---|---|---|---|
| approval.json | f83022f025e417efc4a28dcd6bf14d3f86296acfcd6d10819f473cf9ed8d172e | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| basic.json | 45c4da212d4fb1117a80c237cb033abf1081d7c3132b5e35b4881f8d300fea5f | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| interrupt.json | ae9dee85df027523f024b68c4a4253e51b8b5f25bcc94f36261f30a07055bc56 | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| resume.json | 72086b877930ca370b260b58fb06eb0d6161012ccc8e90d648f7b950823f15af | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
| steer.json | cbd0f9c4768cdfec69271fdfa23c43dbfc4ad48e0a5bfce373cd9ed369032dbe | JUN (lane B agent, claude-opus-5-5) | 2026-11-28 | read every kept string; synthetic prompt/answers only |
