# 021 — wp2 stale check against c8e17b29e (origin/dev 32f7bda9b unchanged)

wp2 consumes [020_wp2_escalation_service.md](020_wp2_escalation_service.md) with errata E1–E6. Since 020 was written:

- wp1 landed. Use the real exports: `OrchestrationV2ThreadLauncher` (`packages/contracts/src/orchestrationV2.ts:118`), `UserInputRespondedBy`, `UserInputResponseReason`, `describeUserInputResponder` (`packages/contracts/src/providerPolicy.ts:78-99`), the `question` notification source member (`orchestrationV2.ts:1112`), `exceededDispatchModeLimit` (`apps/server/src/orchestration-v2/DispatchModeLimit.ts:44`).
- Of the files 020 modifies, `Orchestrator.ts` (+82, wp1 respond/dismiss provenance) and `ProjectionStore.ts` (+2, shell launcher copies) moved; `EventSink.ts`, `server.ts`, `serverActivation.ts`, `runtimeLayer.ts` did not. Re-anchor 020's hunks by symbol.
- 020 errata E2 adds two contracts schemas (`OrchestrationV2QuestionEscalation`, `OrchestrationV2QuestionResolution`); they go next to `OrchestrationV2ThreadLauncher` in `orchestrationV2.ts`.
- Who answered: compare `respondedBy.type === "agent" && respondedBy.environmentId === null && respondedBy.threadId === launcher.threadId` to detect the launcher; everything else is a non-launcher responder (020 E1/E4).

Consultation record: decisions come from the wp0 roadmap consultation (`q13-wp0-architect-proposal`, `q13-wp0-architect-reflection`, `q13-wp0-audit-r1b`); this P adds none.

## wp2 execution packet

- Builder: one `delegate_task` implementation child on `codex/gpt-6.1-sol`, sole writer in this worktree.
- Verifiers: `$B/vp test run apps/server/src/orchestration-v2/QuestionEscalationService.test.ts apps/server/src/orchestration-v2/ProjectionStore.test.ts` plus any other touched test file (EventSink, contracts); `$B/vp lint` on touched files with no new warnings; `tsc --noEmit` in `packages/contracts` and `apps/server` (and web/client-runtime if a contracts change reaches them).
- Review: Anthropic-family reviewer on the wp2 diff.
