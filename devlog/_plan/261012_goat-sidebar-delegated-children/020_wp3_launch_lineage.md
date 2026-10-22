# 020 — wp3: launch 계보 `launchedBy`

> 의존: 000, 001, 002 · 범위: contracts, server(launch 경로, shell builder), client-runtime, web. 마이그레이션 없음.
> goalplan id는 wp3이지만 승격(030)이 이 필드를 쓰므로 먼저 실행한다.

## 결정

- 새 optional 필드 `launchedBy`를 스레드에 둔다. 계보(`lineage`)는 위임 관계 전용으로 그대로 두고, launch는
  최상위 스레드라 `lineage.parentThreadId`를 쓰지 않는다 (아키텍트 D3, 001 R3).
- 모든 `launchedBy`는 **서술용**이다. `thread.create`는 공개 클라이언트 명령이고 SSH 전달 값도 증명할 수
  없다. 권한, 알림, 소유 판단에 쓰지 않고 표시와 링크에만 쓴다.
- launcher 식별은 `(environmentId, threadId)` 쌍이다. `environmentId: null`은 "launched 스레드와 같은 환경"을
  뜻한다(local launch, `create_threads`, 승격). SSH launch만 launcher 쪽 환경 id와 이름을 채운다. 그래서
  ServerEnvironment 의존은 SSH 핸들러 하나에만 생긴다(감사 #4).
- 새 스레드는 `launchedBy`를 물려받지 않는다. fork(`ThreadForkService.ts:88-99`)와 subagent 자식
  (`provider-core/src/server/subagentProjection.ts:54-69`)은 원본 스레드를 펼쳐 만들므로 두 곳에서 `launchedBy`를
  뺀다(감사 #3).
- launch watch와 같은 값: 그 caller의 launch가 watch를 만들었을 때 `launchedBy.threadId === watch.launcherThreadId`. watch의 `host`는 대상 별칭이고
  `launchedBy.environmentLabel`은 launcher 쪽 이름이다. 둘을 섞지 않는다. `notifyOnCompletion:false`와
  승격은 watch를 만들지 않아도 `launchedBy`는 남긴다.
- `create_threads`(에이전트가 최상위 스레드를 만드는 다른 경로)도 같은 값을 남긴다.

## 계약

### MODIFY `packages/contracts/src/orchestrationV2.ts`

`OrchestrationV2AppThreadLineage` 뒤:

```ts
/**
 * Who started a top-level thread: an agent thread through goat_thread_launch,
 * goat_ssh_thread_launch or create_threads ("launch"), or the user promoting a
 * delegated task ("promotion"). Descriptive only: thread.create is a client
 * command and SSH forwards it unauthenticated, so never authorize with it.
 */
export const OrchestrationV2ThreadLauncher = Schema.Struct({
  kind: Schema.Literals(["launch", "promotion"]),
  threadId: ThreadId,
  /** Environment of the launcher thread; null means the launched thread's own environment. */
  environmentId: Schema.NullOr(EnvironmentId),
  /** Launcher environment label at launch time (host name for SSH launches). */
  environmentLabel: Schema.NullOr(Schema.String),
  /** Launcher thread title at launch time, shown when it cannot be resolved. */
  threadTitle: Schema.NullOr(Schema.String),
});
export type OrchestrationV2ThreadLauncher = typeof OrchestrationV2ThreadLauncher.Type;
```

- `OrchestrationV2AppThread`: `launchedBy: Schema.optional(OrchestrationV2ThreadLauncher)`.
- `OrchestrationV2ThreadShell`: 같은 필드. `OrchestrationV2ThreadShellJson`/`OrchestrationV2AppThreadJson`은
  필드에 날짜가 없어 변환이 필요 없다(`mapFields`가 그대로 옮긴다 — 구현 때 확인).
- `thread.create` 명령: `launchedBy: Schema.optional(OrchestrationV2ThreadLauncher)`.
- `EnvironmentId` import가 없으면 `./baseSchemas`(또는 정의 위치)에서 가져온다.

필드 체인 (PLAN-FIELD-CHAIN-01):

| 단계   | 경로                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 생성   | `project/handlers.ts`(local launch), `ssh/handlers.ts` → `SshRemoteDispatch.ts` 인자 → 원격 `project/handlers.ts`, `OrchestratorMcpService.createThreads`, 030 승격 |
| 전달   | `ThreadLaunchInput.launchedBy` → `thread.create` (`ThreadLaunchService.ts:835`) → `Orchestrator.dispatchThreadCreate` (`:2212`) → `thread.created` payload          |
| 저장   | `payload_json` (스레드 전체 인코딩, `ProjectionStore.ts:1846`). 마이그레이션 없음                                                                                   |
| shell  | `ProjectionStore.ts:1460`, `:1730` 두 shell builder에서 `...(thread.launchedBy === undefined ? {} : { launchedBy: thread.launchedBy })`                             |
| 디코드 | optional이라 구 서버 payload는 없음으로, 구 클라이언트는 모르는 키를 무시한다                                                                                       |
| 소비   | 웹 `ChatHeader`, `ThreadRelationshipsPanel`; client-runtime은 `EnvironmentThreadShell.source.launchedBy`로 읽는다 (presented 모델 변경 없음)                        |

## 서버

### MODIFY `apps/server/src/orchestration-v2/ThreadLaunchService.ts`

- `ThreadLaunchInput`에 `readonly launchedBy?: OrchestrationV2ThreadLauncher | undefined`.
- `thread.create` dispatch에 `...(input.launchedBy === undefined ? {} : { launchedBy: input.launchedBy })`.
- `ThreadMessageIntake.launchThread` 입력 타입이 `ThreadLaunchInput`을 그대로 쓰는지 확인하고 아니면 전달한다.

### MODIFY `apps/server/src/orchestration-v2/Orchestrator.ts`

`dispatchThreadCreate`의 `thread` 객체에 `...(command.launchedBy === undefined ? {} : { launchedBy: command.launchedBy })`.

### MODIFY `apps/server/src/orchestration-v2/ThreadForkService.ts`, `packages/provider-core/src/server/subagentProjection.ts`

원본 스레드를 펼친 객체에서 `launchedBy`를 뺀다(`const { launchedBy: _launchedBy, ...rest } = source`). 승격(030)은
자기 값을 직접 넣는다.

### MODIFY `apps/server/src/mcp/toolkits/project/tools.ts`, `handlers.ts`

- `goat_thread_launch` 파라미터에 `launchedBy: Schema.optional(OrchestrationV2ThreadLauncher.annotate({ description:
  "Set by GOAT when it forwards an SSH launch. Leave unset." }))`.
- 핸들러: `caller`가 있으면 `{kind: "launch", threadId: caller.id, environmentId: null, environmentLabel: null,
  threadTitle: caller.title}`, 없으면 `input.launchedBy`(SSH 전달)를 쓴다. `ThreadMessageIntake.launchThread`에 넘긴다.
  새 서비스 의존은 없다.

### MODIFY `apps/server/src/mcp/toolkits/ssh/handlers.ts`, `apps/server/src/sshRemote/SshRemoteDispatch.ts`

- 핸들러: `caller.caller !== undefined`일 때만 `ServerEnvironment.ServerEnvironment`의 `getDescriptor`로
  `{environmentId, label}`을 읽어 `{kind: "launch", threadId: launcher.id, environmentId, environmentLabel: label,
  threadTitle: launcher.title}`를 만들고 `dispatch.launchThread({..., launchedBy})`. 스레드 밖 외부 MCP 클라이언트
  (`threadAccess.ts:73-82`의 `caller: undefined`, `McpToolAccess.test.ts:264`)는 지금처럼 계보 없이 launch한다
  (watch 등록 가드 `ssh/handlers.ts:84-86`과 같은 조건). 의존 체인: `ssh/tools.ts`의 `goat_ssh_thread_launch` `dependencies`에
  `ServerEnvironment.ServerEnvironment` 추가(`ssh/tools.ts:20-25`) → `McpHttpServer.ts:852-870`이 등록 시 요구 →
  운영 레이어는 이미 `ServerEnvironment`를 제공(서버 런타임 레이어에서 확인) → `ssh/handlers.test.ts` 레이어에
  descriptor mock 추가.
- 구 원격 서버 호환(감사 #1): `McpHttpServer.ts:805-837`이 선언되지 않은 최상위 인자를 거부하므로 무조건 보내면 구
  원격에서 launch 전체가 `remote_refused`로 실패한다. NEW `listAcpMcpTools`(`apps/server/src/mcp/AcpMcpStdioBridge.ts`,
  `callAcpMcpTool`과 같은 handshake 뒤 `tools/list`)를 두고, `SshRemoteDispatch`는 세션 캐시 항목
  (`sessions` 값, `:420` 부근)에 `launchLineage?: boolean`을 둔다. `goat_thread_launch` 직전에 값이 없으면 한 번
  `tools/list`로 `goat_thread_launch.inputSchema.properties.launchedBy` 존재를 확인해 캐시하고, 있을 때만 인자에 넣는다.
  목록 호출이 실패하면 `false`로 보고 launch는 계보 없이 한 번만 보낸다(모호한 응답 뒤 재시도 없음).
  `SshLaunchInput`에 `launchedBy?`.

### MODIFY `apps/server/src/mcp/OrchestratorMcpService.ts` (`create_threads`, `:2236`)

`thread.create`에 `launchedBy: {kind: "launch", threadId: scope.thread.threadId, environmentId: null, environmentLabel: null, threadTitle: parent.thread.title}`.

## 웹

### MODIFY `apps/web/src/components/chat/ChatHeader.tsx` 와 `ChatView.tsx` (`:2167`)

- `ChatView`가 `serverThread?.source.launchedBy`(presented 모델에는 없다)를 읽어 breadcrumb 데이터를 만들고 `ChatHeader`에 넘긴다.
- 지금 subagent에만 만드는 `parentThreadLink`를 확장: subagent 부모가 없고 `launchedBy`가 있으며
  `launchedBy.environmentId`의 shell 중 `threadId`가 있으면 그 스레드로 가는 breadcrumb. aria-label
  "Open launching thread: <title>" (promotion이면 "Open original parent thread").
- 다른 환경 이동(감사 #7): `onOpenThread`는 타임라인과 공유하므로(`ChatView.tsx:11494`, `MessagesTimeline.tsx:343`)
  넓히지 않는다. `ChatHeader`에 별도 `onOpenScopedThread(ref: ScopedThreadRef)`를 더하고 launcher breadcrumb만 쓴다.
  `launchedBy.environmentId === null`이면 현재 환경으로 해석한다.

### MODIFY `apps/web/src/components/chat/ThreadRelationshipsControl.tsx`

- Lineage 섹션 맨 위에 launcher 행: 아이콘 `RocketIcon`(launch) / `CornerLeftUpIcon`(promotion), 라벨
  "Launched by" / "Promoted from", 제목은 연결된 shell의 현재 제목 → `threadTitle` → `threadId`, 보조 글자
  `environmentLabel`. 연결되지 않았으면 비활성 행(기존 `node?.missing` 표현).
- "Launched" 그룹: 연결된 모든 환경의 shell 중 `source.launchedBy?.kind === "launch"`, `threadId === 이 스레드`,
  그리고 `(launchedBy.environmentId ?? shell.environmentId) === 이 환경`인 것(괄호 필수: `??`가 `===`보다 약하다).
  이 판정은 NEW 순수 함수 `isLaunchedFromThread(shell, launcher: ScopedThreadRef)`로 두고 테스트한다. `ThreadLineageGroup`은
  `ThreadRelationshipWalkRow`에 묶여 있으므로(`ThreadRelationshipsControl.tsx:117-128`) NEW `LaunchedThreadRow`
  (`{ ref: ScopedThreadRef, title, status }`)와 작은 그룹 컴포넌트(같은 6/12 상수와 `ThreadLineageRowList` 재사용)를 둔다.
  key는 `scopedThreadKey(ref)`, 이동은 `ref.environmentId`로 한다(`:299-303`의 환경 고정 이동을 쓰지 않는다).
  SSH 대상 호스트에 연결하지 않았으면 그 스레드는 보이지 않는다 (`goat_thread_watch_list`가 보여 준다).
- 같은 규칙의 "Launched by" 행도 `ScopedThreadRef`로 이동한다.
- 섹션이 비었는지 판단하는 조건(`relationshipRows.length === 0 && runningCount === 0`)에 두 항목을 더한다.

## 테스트

- `apps/server/src/mcp/toolkits/project/handlers.test.ts`: thread caller가 launch하면 생성된 스레드
  `launchedBy`가 `{kind:"launch", threadId: caller, environmentId, environmentLabel, threadTitle}`; caller 없이
  `launchedBy` 인자를 주면 그 값; caller가 있으면 인자를 무시.
- `apps/server/src/mcp/toolkits/ssh/handlers.test.ts`: `dispatch.launchThread`가 launcher를 받는다.
- `SshRemoteDispatch` 테스트(있으면): 원격 인자에 `launchedBy` 포함.
- `packages/contracts/src/orchestrationV2.test.ts`: `launchedBy` 있는/없는 shell 디코드.
- launch 체인: `apps/server/src/orchestration-v2/ThreadLaunchService.test.ts`에 `launchedBy`를 준 launch 뒤 저장된 전체
  스레드(`getThread`)와 두 shell 경로(`readShellSnapshot`, `getThreadShell`)에 같은 값이 있다.
- 상속 없음: `ThreadForkService.test.ts`와 `packages/provider-core` subagent projection 테스트에 `launchedBy`
  (launch, promotion 각각)가 있는 원본에서 만든 fork/자식에 필드가 없다. subagent 쪽은 apps/server/src/orchestration-v2/SubagentProjection.test.ts에 둔다.
- SSH 호환: `SshRemoteDispatch.test.ts`에 `tools/list`가 `launchedBy`를 선언하는 원격과 선언하지 않는 원격 두 경우,
  launch가 성공하고 인자에 필드가 있음/없음, `goat_thread_launch` 호출이 정확히 한 번.
- 웹: 같은 thread id가 두 환경에 있을 때 "Launched" 행 key와 이동 대상이 환경별로 갈린다(로직 함수 테스트).
- 웹: `isLaunchedFromThread` 부정 사례 — 같은 launcher thread id, 다른 `launchedBy.environmentId`이면 false;
  `environmentId: null`이면 shell 자기 환경과 비교.
- SSH 핸들러: thread caller가 없는 외부 클라이언트 launch가 성공하고 `launchedBy`를 보내지 않는다.

## 검증 명령

- `vp test run apps/server/src/mcp/toolkits/project/handlers.test.ts apps/server/src/mcp/toolkits/ssh/handlers.test.ts apps/server/src/sshRemote/SshRemoteDispatch.test.ts apps/server/src/orchestration-v2/ThreadLaunchService.test.ts apps/server/src/orchestration-v2/ThreadForkService.test.ts packages/contracts/src/orchestrationV2.test.ts apps/server/src/orchestration-v2/SubagentProjection.test.ts`
- 각 패키지 디렉터리에서 `npx tsc --noEmit`: `packages/contracts`, `apps/server`, `packages/client-runtime`, `apps/web`, `apps/mobile`
- `vp lint <changed files>`, `vp fmt --check <changed files>`
