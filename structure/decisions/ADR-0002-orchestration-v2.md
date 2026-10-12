# ADR-0002 — decision recorded under "Orchestration"

- Contract owner: [server.md](../server.md#orchestration)
- Commit: `de343914273eceb852a1d1d739cd1d38df7796ee` (2026-10-02)

## Decision record

- 목적과 의도: Introduce the orchestrator that current servers run. The subject is "feat(orchestrator): introduce new orchestrator (#2829)".
- 기존 구현 및 제약 조건: ADR-0001's engine was the previous server-side orchestration path. The commit removes the legacy checkpoint reactor under the old orchestration tree and rewires callers onto v2.
- 검토한 주요 대안: The commit message does not record a rejected alternative. The body is co-author trailers.
- 선택한 방식: Land `apps/server/src/orchestration-v2/`, including `Orchestrator.ts`, the effect worker, and `CheckpointService.ts` with `CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints"`. Derive `dbPath` as `statev2.sqlite` and seed it from `state.sqlite` when V2 is missing (`apps/server/src/persistence/initializeV2Database.ts`).
- 다른 대안 대신 이 방식을 선택한 이유: The message does not say why this shape won. The tree it added is still the commit path in `apps/server/src/orchestration-v2/EventSink.ts`.
- 장점, 단점 및 영향: Command acknowledgement means the event log, projections, receipt, and outbox committed together. Provider work and checkpoint capture run as effects. Checkpoint ref names keep the `refs/t3/` prefix.
