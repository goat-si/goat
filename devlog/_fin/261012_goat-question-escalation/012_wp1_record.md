# 012 — wp1 cycle record

**Conclusion.** wp1 foundations landed in `af2fe620d` (builder gpt-6.1-sol, task `q13-wp1-build-r1`) and `c30eb26ee` (review fixes). Threads launched by `goat_thread_launch`, `create_threads` and app-owned `delegate_task` children carry `launcher` from the authenticated caller; provider-native children and forks do not. Answers carry `respondedBy` (user | agent | client) stamped at the WS boundary or from the authenticated MCP caller, with a required reason; the loser of a race gets a typed "already answered by …" error; approvals refuse non-user responders; ceiling refusals on respond tell the agent to forward to a person. Web, mobile and the client-runtime history show "Answered by …: reason" for agent and client answers.

**Evidence.** Pre-implementation audit `q13-wp1-audit-r1` NEAR-PASS (folded as 010 E12–E15). Cross-family review `q13-wp1-review-r1` (anthropic/claude-opus-5-5) PASS with 2 minors, fixed in `c30eb26ee` together with the 10 lint warnings the commit introduced. Check receipt: 17 test files / 420 tests pass; tsc clean in contracts, provider-core, shared, client-runtime, server, web; mobile typecheck clean. Criterion c-2 met.

**What did not improve / open.** Nothing escalates yet: the launcher learns of a question only from wp2. Dismissed or settled questions show their attribution through MCP read and error text only; the history UI is unchanged for cancelled items (E15). No real-client pass was run (none requested).

**Direction.** Next P consumes [020_wp2_escalation_service.md](020_wp2_escalation_service.md) with errata E1–E6 after a stale check against `c30eb26ee` and current origin/dev; wp1 exported names to use: `OrchestrationV2ThreadLauncher`, `UserInputRespondedBy`, `describeUserInputResponder`.
