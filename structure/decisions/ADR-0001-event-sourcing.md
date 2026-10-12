# ADR-0001 — decision recorded under "Orchestration"

- Contract owner: [server.md](../server.md#orchestration)
- Commit: `483a1ae3718e39269075e99ea84e437d4cfad591` (2026-02-21)

## Decision record

- 목적과 의도: Move thread state off the client and onto a server event-sourced engine, as the commit subject states: "Add server-side orchestration engine with event sourcing".
- 기존 구현 및 제약 조건: The commit message says state management lived on the client, including a persistence layer the change removed.
- 검토한 주요 대안: The commit message does not record a rejected alternative.
- 선택한 방식: An SQLite append-only event log, an orchestration engine with a command queue, reducer, and read model, and Effect PubSub for read-model updates. Orchestration schemas moved to contracts.
- 다른 대안 대신 이 방식을 선택한 이유: The message states the goal as moving state management from client to server. It does not compare designs beyond that.
- 장점, 단점 및 영향: The client store lost its persistence layer. This engine is not the live path. `de343914273eceb852a1d1d739cd1d38df7796ee` replaced it with `apps/server/src/orchestration-v2/`. The directory `apps/server/src/orchestration/` from that commit is gone.
