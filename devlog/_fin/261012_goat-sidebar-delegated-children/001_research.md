# 001 — 조사 요약 (Sol R1-R3, 2026-10-12)

조사 레인 세 개(GPT-6.1-Sol, read-only)의 결론 중 설계에 쓰는 사실만 남긴다. 줄 번호는 `390b9fd42` 기준.

## 사이드바와 클라이언트 (R1)

- 사이드바는 평평한 목록이다. pinned, active, working, snoozed, settled 구획에 `SidebarThreadRow`
  (card / slim)를 정렬 가능한 `<li>`로 그린다. `apps/web/src/components/Sidebar.tsx:1113`, `:5423`.
- fork도 중첩하지 않는다. `getSidebarForkParentThreadId`(`Sidebar.logic.ts:585`)는 테스트에서만 쓴다.
- 자식 스레드 shell은 서버가 거르지 않고 클라이언트까지 온다 (`ProjectionStore.ts:5321`,
  `ws.ts:973`). 웹이 `filterSidebarV2VisibleThreads`(`Sidebar.logic.ts:571`)에서 subagent를 뺀다.
- shell에는 `lineage`, `source.creationSource`, `latestRun`, `runtime`, `archivedAt`가 있다
  (`packages/client-runtime/src/state/models.ts:89`). provider-native 자식은 run이 없는 root turn이라
  shell 상태로는 실행 여부를 알 수 없다 (`threadExecution.ts:129`). 그래서 사이드바는 `mcp` 자식만 다룬다.
- 상세 패널 `ThreadRelationshipsPanel`이 이미 active / "Previous agents"(접힘, 6개 + 12개씩)로 나누고,
  Stop은 `threadEnvironment.interruptTurn`(`run.interrupt`, `holdQueue: true`)를 자식 id로 부른다
  (`ThreadRelationshipsControl.tsx:71`, `:284`, `:331`).
- 모바일은 `threadListV2.ts:711`에서 subagent를 따로 거른다. optional 필드 추가로 깨지지 않는다.

## 서버 위임과 승격 (R2)

- `delegated_task.request`가 부모에 `OrchestrationV2Subagent`(`origin: "app_owned"`, `childThreadId`)를
  만들고 자식을 `lineage.relationshipToParent: "subagent"`, `forkedFrom: {type: "node"}`로 만든다
  (`Orchestrator.ts:6578`, `provider-core/src/server/subagentProjection.ts:66`).
- 클라이언트는 `thread.stop`(internal)을 보낼 수 없고 `run.interrupt`만 쓴다
  (`contracts/src/orchestrationV2.ts:3080`, `:2934`). `task_cancel`은 `thread.stop` + 부모 delivery dispose.
- 계보는 `payload_json` 안의 JSON이다. 계보를 바꾸는 명령은 없고, Orchestrator는 계보가 불변이라
  가정하고 잠금 없이 부모를 읽는다 (`Orchestrator.ts:9573`).
- 계보만 null로 바꾸면 `finalizeAppOwnedSubagent`가 조기 반환해(`Orchestrator.ts:9841`) 부모 작업이
  영원히 active로 남고, `task_cancel`과 `stopDelegatedTasks`(`ThreadManagementService.ts:438`)는 여전히
  승격된 스레드를 멈춘다. 승격은 부모 쪽 기록을 함께 정리해야 한다.

## launch 계보 (R3)

- `goat_thread_launch` → `ThreadMessageIntake.launchThread` → `ThreadLaunchService.launch` →
  `thread.create` → `thread.created`(`parentThreadId: null`) (`project/handlers.ts:167`,
  `ThreadLaunchService.ts:835`, `Orchestrator.ts:2212`). launcher 정보는 첫 메시지의 `senderThreadId`뿐이다.
- SSH launch는 원격 `goat_thread_launch`를 부르고 인자에 launcher 정보가 없다
  (`SshRemoteDispatch.ts:655`). 원격 세션은 별칭+권한 단위로 공유돼 launcher를 증명할 수 없다.
- launch watch는 `(launcherThreadId, host = 대상의 SSH 별칭, threadId)`로 식별한다
  (`launchWatch.ts:37`, `:99`). `host`는 launcher 호스트가 아니라 대상 호스트다.
- `OrchestrationV2Actor`는 문자열 enum이라 스레드 id를 담지 못한다 (`orchestrationV2.ts:79`).
