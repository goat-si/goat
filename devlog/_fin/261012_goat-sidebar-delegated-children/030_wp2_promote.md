# 030 — wp2: 위임 하위 작업을 최상위 스레드로 승격

> 의존: 010(사이드바 메뉴), 020(`launchedBy`) · 범위: contracts, server, client-runtime, web. 마이그레이션 없음.

## 의미

승격은 **소유권 분리**다. 자식 스레드의 id, 기록, provider 세션, 실행 중인 run은 그대로 두고, 부모와의
관계만 끊는다. 이후 그 스레드는 부모를 깨우지 않고, 부모의 Stop, `task_cancel`, 연쇄 Stop에 멈추지 않는다.
되돌리기(다시 자식으로)는 없다. 위임 결과는 이미 부모에게 "승격됨"으로 끝났기 때문이다. 보이지 않게 하는
출구는 보관(archive)이다.

| 상황                                                       | 동작                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 대상이 app_owned 위임 자식                                 | 승격                                                                                                                                                         |
| provider-native subagent, 일반 스레드, fork                | 거부 ("Only delegated tasks can be promoted.")                                                                                                               |
| 삭제된 스레드                                              | 거부                                                                                                                                                         |
| 보관된 자식                                                | 승격 (보관 상태 유지)                                                                                                                                        |
| 이미 승격됨 (`launchedBy.kind === "promotion"`, 계보 null) | 수락하고 아무것도 바꾸지 않음 (같은 payload 재발행, 재시도 안전)                                                                                             |
| 부모 작업이 아직 실행 중                                   | 그 작업을 `cancelled`로 끝내고 결과 "Promoted to top-level thread <id> by the user; it no longer reports to this thread." 부모는 평소 wake 정책대로 깨어난다 |
| 부모 작업이 이미 끝남                                      | 상태와 결과, 이미 잡힌 delivery는 그대로. `promotedAt`만 기록                                                                                                |
| 자식을 가리키는 작업 기록이 여럿(후속 메시지)              | 모두 같은 규칙으로 처리                                                                                                                                      |
| 자식의 자식(손자)                                          | 그대로 이 스레드의 자식으로 남는다. `rootThreadId`는 바꾸지 않는다(역사적 조상으로 읽는다)                                                                   |

## 계약 — MODIFY `packages/contracts/src/orchestrationV2.ts`

1. `OrchestrationV2Subagent`: `promotedAt: Schema.optional(Schema.DateTimeUtc)` (주석: set when the user
   promoted the child to a top-level thread; the task no longer owns it). `OrchestrationV2SubagentJson`에
   `promotedAt: Schema.optional(Schema.DateTimeUtcFromString)`.
2. 공개 명령 `OrchestrationV2Command`에:
   ```ts
   /** Detaches a delegated task's child thread into an ordinary top-level thread, keeping its history. */
   Schema.Struct({ type: Schema.Literal("thread.promote"), commandId: CommandId, threadId: ThreadId }),
   ```
3. internal `thread.stop`: `stopCascadeFrom: Schema.optional(ThreadId)` — "The thread whose Stop or task_cancel
   cascaded here. The stop is an accepted no-op unless this thread is still a delegated descendant of it."
   부모 하나가 아니라 연쇄를 시작한 스레드를 담는다. 재귀가 no-op 뒤에도 손자로 내려가므로(`ThreadManagementService.ts:453`,
   `OrchestratorMcpService.ts:2122`), 손자도 스스로 사슬을 확인해야 승격된 중간 노드 아래가 멈추지 않는다.
4. `packages/contracts/src/environment.ts` capabilities: `threadPromotion: Schema.optionalKey(Schema.Boolean)`
   (threadSettlement과 같은 버전 차이 규칙). 서버 `ServerEnvironment.ts:230` 근처에 `threadPromotion: true`.

필드 체인: `promotedAt` 생성 = 승격 핸들러만; 저장 = subagent `payload_json`; 디코드 = optional;
소비 = `stopDelegatedTasks`, `task_cancel`, completion-delivery dispose 핸들러, client `threadRelationships`.
`stopCascadeFrom` 생성 = `stopDelegatedTasks`(재귀 내내 처음 값을 유지), `task_cancel`; 소비 = `thread.stop` 핸들러.
`threadPromotion` 생성 = 서버 descriptor; 소비 = 웹의 공용 `canPromoteThread` (세 진입점 모두).

## 서버 — MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`

1. `commandThreadId`: `"thread.promote"` → `command.threadId`. `dispatchOnce`의 `switch (command.type)`(`:10447`)에
   `case "thread.promote": yield* dispatchThreadPromote(command, events); break;`. 테스트 헬퍼
   `testkit/OrchestratorScenario.ts:134-189` `commandThreadIds`에도 `thread.promote` → `[command.threadId]`.
   `ThreadManagementService.ts:96`, `ws.ts:1841`, RPC 권한은 명령을 일반적으로 다루고 `CommandPolicy.ts`에는 명령
   종류 전수 switch가 없다(감사 #2 확인) — 타입 검사가 빠진 switch를 잡는다.
2. `dispatchWithReceipt`: `message.dispatch`처럼 `thread.promote`도 `appOwnedSubagentParentThreadId`로 부모를
   찾아 부모 잠금 → 자식 잠금 순서로 실행한다. 잠금을 얻은 뒤 핸들러가 계보를 다시 확인한다.
3. `appOwnedSubagentParentThreadId` 주석을 "lineage only ever detaches (promotion), so a stale read takes one
   extra parent lock and handlers revalidate after locking"으로 바꾼다.
4. NEW `dispatchThreadPromote(command, events)`:
   - 자식 thread 읽기, 위 표의 거부/no-op 판정.
   - 부모 projection: `getThreadRecords(parentId, ["runs","messages","subagents","providerTurns","nodes","turnItems"], { turnItemTypes: ["subagent"], messageRoles: ["user"] })`.
   - 작업 = `subagents.filter(t => t.origin === "app_owned" && t.childThreadId === child.id && t.promotedAt === undefined)`. 비면 거부.
   - 자식에 `thread.metadata-updated`: `{...child, lineage: {parentThreadId: null, relationshipToParent: null, rootThreadId: child.id}, launchedBy: {kind: "promotion", threadId: parent.id, environmentId: null, environmentLabel: null, threadTitle: parent.title}, updatedAt: now}`. `forkedFrom`은 유지한다. `environmentId: null`은 같은 환경이라는 뜻(020)이라 Orchestrator에 새 서비스 의존이 없다.
   - 각 작업: 끝났으면 `{...task, promotedAt: now, updatedAt: now}`로 `subagent.updated`. 실행 중이면
     `updatedTask = {...task, status: "cancelled", result: PROMOTED_RESULT, completedAt: now, promotedAt: now, updatedAt: now}`,
     `planDelegatedCompletionDelivery({ parentProjection: <pending events 반영>, parentRun, task, updatedTask, now })`,
     그리고 finalize와 같은 방식으로 부모의 작업 node와 subagent turn item을 terminal로 갱신한다. 작업마다
     `getProjectionWithPendingEvents(parentId, events)`로 다시 읽어 같은 부모 run의 cohort를 덮어쓰지 않는다.
   - context transfer(`subagent_result`)는 만들지 않는다.
5. 커밋 뒤: `thread.promote`도 `offerDelegatedCompletionDeliveries(parentThreadId)`를 부른다 (`:10900` 근처의
   기존 후처리 목록).
6. `thread.stop` 핸들러(`:9272`): `command.stopCascadeFrom`이 있으면 대상 잠금 아래서 조상 사슬을 확인한다.
   `cur = target`부터 `lineage.relationshipToParent === "subagent"`인 동안 `parentThreadId`로 올라가(최대 32단계)
   `stopCascadeFrom`에 닿으면 멈추기를 진행하고, 사슬이 끊기면(승격된 노드) 이벤트 없이 수락한다(empty-events
   오류가 나면 기존 idempotent 재발행 패턴을 따른다). 중간 노드의 승격이 이 확인보다 먼저 커밋됐으면 막히고, 뒤에
   커밋됐으면 "멈춘 뒤 승격"이라는 정상 순서다. 분리만 일어나므로 커밋된 상태 읽기로 충분하다.
7. `delegated_task.completion-delivery.dispose` 핸들러(`:1913` 부근, 부모 잠금 아래): 작업에 `promotedAt`이 있으면
   변경 없는 작업 row를 `subagent.updated`로 다시 내보내고 끝낸다(`:1950-1968`의 idempotent 패턴; 이벤트 없는 수락은
   `thread.stop`만 허용, `:10784-10793`). `task_cancel`이 승격 전에 만든 dispose가 승격 뒤 실행돼 "승격됨" 알림을
   지우는 경쟁을 막는다 (`OrchestratorMcpService.ts:2077`, `:2159`, `:2178`).

## 서버 — 연쇄 Stop 가드

- MODIFY `apps/server/src/orchestration-v2/ThreadManagementService.ts` `stopDelegatedTasks` (`:438`):
  `task.promotedAt !== undefined`면 건너뛴다. 입력에 `stopCascadeFrom?`을 더해 첫 호출의 `threadId`로 채우고
  재귀에도 같은 값을 넘긴다. 보내는 `thread.stop`에 `stopCascadeFrom`.
- MODIFY `apps/server/src/mcp/OrchestratorMcpService.ts` `task_cancel` (`:2045-2125`): 대상 작업이 승격됐으면
  stop 없이 현재 상태를 돌려준다. 재귀 preflight에서 승격된 작업을 건너뛴다. `thread.stop`과 재귀
  `stopDelegatedTasks`에 `stopCascadeFrom: <task를 가진 부모 스레드>`. 이미 큐에 있던 `delegated-tasks.stop`
  effect도 같은 `stopDelegatedTasks`를 타고, effect가 기록한 부모 스레드를 `stopCascadeFrom`으로 쓴다.
- MODIFY `apps/server/src/mcp/toolkits/orchestrator/tools.ts` `delegate_task` 설명: "Children do not appear in
  the sidebar"를 "Running children show nested under this thread in the sidebar, and the user can promote one
  to a top-level thread, which ends the task here"로 바꾸고 goal/loop 작업은 `goat_thread_launch`로 보낸다는
  안내는 유지한다.

## client-runtime

- `packages/client-runtime/src/operations/commands.ts`: `simpleThreadCommand`의 type 유니온(`:412-419`)에
  `"thread.promote"`를 더하고 `promoteThread = Effect.fn("EnvironmentCommands.promoteThread")(…simpleThreadCommand("thread.promote", input))`,
  `PromoteThreadInput = ThreadCommandInput`.
- `packages/client-runtime/src/state/threadCommands.ts`: `threadEnvironment.promoteThread` 등록 (label
  `environment-data:commands:thread:promote`).
- `packages/client-runtime/src/state/threadRelationships.ts` (`:98`, `:111`): `promotedAt`이 있는 subagent 기록으로
  subagent 간선을 만들지 않는다. context transfer 간선은 역사로 남긴다.

## 웹

- 공용 판정 NEW `canPromoteThread(shell, capabilities)` (`apps/web/src/components/Sidebar.logic.ts` 또는
  client-runtime `thread-workflows`): mcp 위임 자식 + 대상 환경 `threadPromotion === true`. 각 진입점은 여기에
  `useEnvironmentScope(environmentId, AuthOrchestrationOperateScope)`를 더한다. 서버는 dispatch에서
  `orchestration:operate`를 이미 검사한다(`RpcAuthorization.ts:49`).
- 사이드바 자식 행 메뉴(010)에 "Promote to thread". 성공하면 그 스레드로 이동하고 토스트 "Promoted to a thread".
- `ChatHeader`: 지금 스레드가 승격 가능하면 부모 breadcrumb 옆 작은 버튼 또는 기존 헤더 메뉴에 "Promote to
  thread". 구현자는 헤더에 이미 있는 메뉴가 있으면 그곳을 쓴다.
- 명령 팔레트: 열린 스레드가 승격 가능하면 "Promote to thread" 액션. 액션 목록은 `CommandPalette.tsx:1898` 부근(감사 #2).
- 상세 패널 Lineage: 승격된 스레드는 020의 "Promoted from" 행을 보인다.

## 테스트 — NEW `apps/server/src/orchestration-v2/ThreadPromote.integration.test.ts`

기존 위임 하네스(`DelegatedCompletionDelivery.test.ts` 또는 `BackgroundWorkStop.integration.test.ts:341` 패턴,
`worker.drain()`)로:

1. async 위임 실행 중 승격 → 자식 계보 null, `launchedBy.kind === "promotion"`, 부모 작업 `cancelled` + `promotedAt` + 결과 문구, 부모에 wake run이 큐에 생김.
2. 같은 명령 재시도 → 오류 없음, 상태 변화 없음.
3. 승격 뒤 부모 `thread.stop` 연쇄(`stopDelegatedTasks`) → 승격된 스레드와 그 아래 실행 중인 손자의 run이 계속 돈다.
4. 승격 전에 만든 `thread.stop`(`stopCascadeFrom: parent`)을 승격 뒤 dispatch → 자식과 손자 모두 no-op.
5. 일반 최상위 스레드 승격 → 거부.
6. 이미 끝난 작업의 자식 승격 → 작업 상태/결과 불변, `promotedAt`만.
7. 승격 뒤 실행된 `delegated_task.completion-delivery.dispose` → no-op, 승격 wake delivery가 남는다.
8. 클라이언트 경로: `ThreadManagementService.dispatch`로 들어온 `thread.promote`가 같은 결과를 낸다. client-runtime
   `packages/client-runtime/src/operations/commands.test.ts`에 `promoteThread`가 `{type: "thread.promote", commandId, threadId}`를
   dispatch하는 테스트(기존 `archiveThread` 테스트 형태)를 더한다.
9. 경쟁: 손자가 실행 중일 때 `stopDelegatedTasks`의 첫 `getThreadRecords` 뒤, 자식 `thread.stop` dispatch 전에 자식을
   승격(테스트 dispatcher를 감싸 첫 stop 직전에 promote를 끼움) → 자식과 손자 모두 계속 돈다.
10. 경쟁: `task_cancel` preflight 뒤 승격 → 자식은 멈추지 않고 승격 delivery가 남는다.

웹: `canPromoteThread` 부정 사례(capability 없음, provider 자식, 최상위 스레드) 로직 테스트.

client-runtime: `threadRelationships` 테스트에 승격된 기록이 간선을 만들지 않는 경우 추가.

## 검증 명령

- `vp test run apps/server/src/orchestration-v2/ThreadPromote.integration.test.ts packages/client-runtime/src/state/threadRelationships.test.ts`
- 관련 기존 테스트: `vp test run apps/server/src/orchestration-v2/DelegatedCompletionDelivery.test.ts apps/server/src/orchestration-v2/ThreadStop.test.ts apps/server/src/orchestration-v2/ThreadManagementService.test.ts`
- 각 패키지 디렉터리에서 `npx tsc --noEmit`: `packages/contracts`, `apps/server`, `packages/client-runtime`, `apps/web`, `apps/mobile`
- `vp lint <changed files>`, `vp fmt --check <changed files>`
