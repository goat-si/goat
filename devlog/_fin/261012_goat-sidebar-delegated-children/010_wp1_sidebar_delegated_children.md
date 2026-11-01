# 010 — wp1: 사이드바에 위임 하위 작업 중첩

> 의존: 000, 001 · 범위: `apps/web`만. 계약, 서버, 모바일 변경 없음.

## 규칙 (사용자 결정 대신 남기는 근거)

| 항목                 | 규칙                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 근거                                                                                              |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 대상                 | `lineage.relationshipToParent === "subagent"`, `lineage.parentThreadId !== null`, `source.creationSource === "mcp"`, `archivedAt === null`, `deletedAt === null`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | provider-native 자식은 shell로 상태를 알 수 없다 (001 R1). 상세 패널에 그대로 남는다.             |
| 위치                 | 보이는 최상위 행의 직계 자식만. 부모가 안 보이면(보관, 범위 밖, 글로벌 에이전트) 자식도 안 보인다. 손자는 자식 스레드 안에서 본다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 트리 깊이를 하나로 묶어 행 높이와 계산을 고정한다.                                                |
| 표시 상태            | 넷으로 나눈다. attention: 승인/입력 대기(`hasPendingApprovals`, `hasPendingUserInput`). working: `runtime.status`가 `preparing`/`starting`/`running`/`waiting`(= `activityRunStatus`가 있는 활성 run), 또는 `runtime.status === "idle"`이면서 `pendingBackgroundTasks`가 남은 경우(라벨 `background`). queued: 위가 아니고 `runtime.status === "queued"`. finished: 나머지. `isSidebarThreadWorking`은 쓰지 않는다 — 활성 runtime에 `queued`가 들어 있어(`models.ts:79-85`) queued만 있는 자식을 running으로 만든다(감사 #5). 오래된 활성 run과 새 queued run이 함께 있으면 `runtime.status`가 활성 run 상태라 working이다. 라벨은 `needs input`, `running`, `background`, `queued`, 끝난 것은 상대 시간. | 라벨이 거짓말하지 않게 한다.                                                                      |
| 실행 중 묶음         | attention은 모두 보인다(3개 제한 밖). working과 queued는 오래된 순으로 합쳐 처음 3개를 보이고 나머지는 "+N more running" 버튼으로 펼친다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 수십 개가 동시에 돌 때 부모 행 하나가 화면을 덮지 않게 하되, 답이 필요한 자식은 접히지 않게 한다. |
| 끝난 것              | active가 아닌 자식은 "N finished" 토글 뒤에 접는다(기본 접힘). 펼치면 최근 6개, "Show 12 more"로 12개씩. 최근 = `latestRun.completedAt ?? updatedAt` 내림차순(상세 패널은 생성순이지만, 사이드바는 방금 끝난 결과가 위에 오는 편이 쓸모 있다).                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 상세 패널 Lineage와 같은 6/12 페이지 규칙 (`ThreadRelationshipsControl.tsx:71`).                  |
| settled/snoozed 부모 | active 자식과 열린 자식만. "finished" 토글은 그리지 않는다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 접어 둔 행 아래에 끝난 작업 줄이 쌓이지 않게 한다.                                                |
| 열린 자식            | 지금 열린 스레드가 자식이면 접기와 페이지에 상관없이 한 번만 보인다(중복 없음). 부모가 보이지 않으면(보관, 범위 밖, 부모도 자식) 사이드바 어디에도 없다 — 지금 동작과 같고, 헤더 breadcrumb으로 부모에 간다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 기존 "open thread must never vanish" 규칙 (`Sidebar.tsx:3027`).                                   |
| 정리                 | 시간 기반 자동 정리 없음. 보관(archive)하면 사라진다. 자식 행 메뉴에 Archive를 둔다.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 기록을 지우지 않고, 보관이라는 기존 출구를 쓴다.                                                  |
| 펼침 상태            | 부모별 메모리 상태(`Map<parentKey, {running, finished, finishedVisible}>`). 새로고침하면 기본값.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 저장할 가치가 없는 일시 UI 상태다.                                                                |

## 동작

- 클릭: `navigateToThread(childRef)` (사이드바 행과 같은 경로, 선택 해제 포함).
- Stop: `runtime.activeRunId !== null`인 working/attention 자식에만 hover 버튼(`SquareIcon`)과 메뉴 항목(`background`, queued에는 없다). `threadEnvironment.interruptTurn`을
  자식 id로 부른다 (`ThreadRelationshipsControl.tsx:331`과 같음). queued만 있는 자식은 `interruptTurn`이 아무것도
  멈추지 않으므로(`commands.ts:786`, `:824`) Stop 없이 "queued" 라벨만 둔다. 권한은 행과 같은
  `useEnvironmentScope(environmentId, AuthOrchestrationOperateScope)`; 없으면 버튼을 숨긴다.
- 우클릭 메뉴(`api.contextMenu.show`): Open, Stop(working/attention일 때), Archive, (wp2에서) Promote to thread.
- 키보드: 자식 행은 `role="button"`, Enter/Space로 열기. 점프 힌트, 다중 선택, 드래그 대상이 아니다.
- 드래그: 자식 그룹은 부모 `<li>` 안에 그려 부모와 함께 움직인다. 드래그 중에도 숨기지 않는다(활성화 뒤 높이가
  바뀌면 dnd-kit이 잰 위치와 어긋난다). 그룹의 `onPointerDown`은 `stopPropagation`해서 자식 행에서 부모 드래그가
  시작되지 않게 한다(센서는 `onPointerDown`으로 활성화, `Sidebar.pointer.ts:24`).
- 높이: `[content-visibility:auto] [contain-intrinsic-size:…]`를 `<li>`에서 고정 높이 행 표면(role=button div)으로
  옮긴다. 자식 행은 각자 `[contain-intrinsic-size:auto_28px]`. `<li>`는 측정 가능한 블록으로 남는다.
- 정렬 전략(`Sidebar.drag.ts:147`, `:220`): 입력에 `nestedKeys: ReadonlySet<string>`(자식 그룹을 그리는 행 키)를
  더한다. 기준 card/slim 높이 추론에서 이 행들을 건너뛰고, 옮겨지는 행이 이 집합에 있으면 기준 높이 대신 잰
  rect 높이를 쓴다.

## 파일 변경

### MODIFY `apps/web/src/components/Sidebar.logic.ts`

`creationSource`는 presented shell에 없으므로 `thread.source.creationSource`로 읽는다 (`models.ts:290`).

`isSidebarSubagentThread` 옆에 추가한다.

```ts
export const SIDEBAR_CHILD_RUNNING_LIMIT = 3;
export const SIDEBAR_CHILD_FINISHED_INITIAL_COUNT = 6;
export const SIDEBAR_CHILD_FINISHED_PAGE_COUNT = 12;

type SidebarChildInput = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "id"
  | "lineage"
  | "archivedAt"
  | "deletedAt"
  | "source"
  | "latestRun"
  | "runtime"
  | "updatedAt"
  | "createdAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "hasActionableProposedPlan"
  | "pendingBackgroundTasks"
>;

/** delegate_task children: T3-owned subagent threads the sidebar nests under their parent. */
export function isSidebarDelegatedChildThread(thread: SidebarChildInput): boolean;

export type SidebarDelegatedChildState = "attention" | "working" | "queued" | "finished";
export function sidebarDelegatedChildState(thread: SidebarChildInput): SidebarDelegatedChildState;
/** Stop interrupts the active turn; a queued-only child has none to interrupt. */
export function canStopSidebarDelegatedChild(thread: SidebarChildInput): boolean; // attention | working

export interface SidebarDelegatedChildren<T> {
  /** Needs-attention first, then oldest first, so running rows keep their place while siblings finish. */
  readonly active: ReadonlyArray<T>;
  /** Most recently finished first. */
  readonly finished: ReadonlyArray<T>;
}

/** Parent scoped key (environmentId + parentThreadId) to its delegated children. */
export function buildSidebarDelegatedChildIndex<T extends SidebarChildInput>(
  threads: ReadonlyArray<T>,
  previous?: ReadonlyMap<string, SidebarDelegatedChildren<T>>,
): ReadonlyMap<string, SidebarDelegatedChildren<T>>;
// Reuses the previous entry object when both arrays hold the same elements in the
// same order, so memoized parent rows skip re-rendering on unrelated shell updates.

export function resolveSidebarDelegatedChildWindow<
  T extends { environmentId: string; id: string },
>(input: {
  readonly children: SidebarDelegatedChildren<T>;
  readonly runningExpanded: boolean;
  readonly finishedExpanded: boolean;
  readonly finishedVisibleCount: number;
  readonly showFinished: boolean; // false for settled/snoozed parents
  readonly openThreadKey: string | null;
}): {
  /** Every attention child, then the first SIDEBAR_CHILD_RUNNING_LIMIT working/queued ones. */
  readonly activeRows: ReadonlyArray<T>;
  /** Hidden working/queued children; attention children are never hidden. */
  readonly hiddenActiveCount: number;
  readonly finishedCount: number; // 0 when showFinished is false
  readonly finishedRows: ReadonlyArray<T>; // empty unless finishedExpanded
  readonly hiddenFinishedCount: number;
  /** The open child when the window would otherwise hide it. */
  readonly pinnedOpenRow: T | null;
};
```

`scopedThreadKey(scopeThreadRef(environmentId, parentThreadId))`를 부모 키로 쓴다(행의 `threadKey`와 같은 형식).

### NEW `apps/web/src/components/sidebar/SidebarDelegatedChildren.tsx`

- `memo` 컴포넌트. props: `parentKey`, `children: SidebarDelegatedChildren<EnvironmentThreadShell>`,
  `showFinished`, `openThreadKey`, `onOpen(threadRef)`, `onStop(threadRef)`, `onContextMenu(threadRef, position)`,
  `stoppingThreadKey`.
- 펼침 상태는 `useSidebarDelegatedChildrenUi(parentKey)`(모듈 수준 zustand 또는 `useState`; 행이 가상화나
  재마운트될 때 유지하려면 모듈 수준 `Map` 기반 작은 store) 하나로 둔다.
- `<ul role="group" aria-label="Delegated tasks">` 안에 행(`h-7`, 왼쪽 들여쓰기 `pl-6`, 연결선 없음):
  `BotIcon` 또는 실행 중 `LoaderCircleIcon`(`motion-safe:animate-spin` 금지 — 계속 도는 애니메이션은 GPU를
  쓴다. 정지 아이콘과 상태 점으로 표시), 제목(`formatSubagentDisplayTitle`가 맞으면 사용, 아니면
  `thread.title`), 오른쪽에 짧은 상태(`running`, `waiting`, `needs input`, 끝난 것은 상대 시간).
- 토글 행: "+N more running", "N finished" (`ChevronRightIcon` 회전), "Show 12 more".
- 색과 크기는 기존 사이드바 토큰(`text-sidebar-muted-foreground`, `hover:bg-sidebar-row-hover`)만 쓴다.
  `components/ui` 컴포넌트를 className으로 덮어쓰지 않는다 (`shadcn/no-restyle`).

### MODIFY `apps/web/src/components/Sidebar.tsx`

1. `SidebarThreadRow` props에 `delegatedChildren?: SidebarDelegatedChildren<EnvironmentThreadShell> | undefined`,
   `delegatedChildrenShowFinished: boolean`, `openThreadKey: string | null`, `onOpenDelegatedChild`,
   `onStopDelegatedChild`, `onDelegatedChildContextMenu`, `stoppingDelegatedChildKey`를 추가한다.
   slim과 card 두 `<li>` 모두 `</Tooltip>` 뒤에 `delegatedChildren`이 있으면(드래그 중에도)
   `<SidebarDelegatedChildren …/>`를 그린다. `openThreadKey`는 자식이 있는 행에만 넘긴다(그 외엔 `null`)
   — 모든 행에 경로 키를 넘기면 이동할 때마다 모든 memo 행이 다시 그린다.
2. 정렬 memo 근처에 인덱스를 만든다.
   ```ts
   const delegatedChildIndexRef = useRef<
     ReadonlyMap<string, SidebarDelegatedChildren<EnvironmentThreadShell>>
   >(new Map());
   const delegatedChildIndex = useMemo(() => {
     const next = buildSidebarDelegatedChildIndex(threads, delegatedChildIndexRef.current);
     delegatedChildIndexRef.current = next;
     return next;
   }, [threads]);
   ```
3. `renderThreadRowInner`에서 `delegatedChildren={delegatedChildIndex.get(threadKey)}`,
   `delegatedChildrenShowFinished={section !== "settled" && section !== "snoozed"}`를 넘긴다.
4. 콜백: `onOpenDelegatedChild = navigateToThread`; `onStopDelegatedChild`는
   `useAtomCommand(threadEnvironment.interruptTurn)`로 `{environmentId, input: {threadId}}`를 보내고 실패하면
   `toastManager`로 "Could not stop task"; `onDelegatedChildContextMenu`는 `api.contextMenu.show`로
   Open / Stop / Archive 메뉴. Archive는 기존 단일 행 archive 경로(`attemptArchive` 계열)를 재사용한다.
   모두 `useCallback`으로 안정화한다.
5. `filterSidebarV2VisibleThreads`는 그대로 둔다. 자식은 최상위 목록에 들어가지 않는다.
6. `nestedKeys`: 보이는 행 중 `delegatedChildIndex`에 entry가 있고 그 창(`resolveSidebarDelegatedChildWindow`)이
   그릴 행이나 토글이 하나라도 있는 행 키 집합을 `useMemo`로 만들고, 정렬 전략을 만드는 곳(`Sidebar.drag.ts`의
   strategy factory 호출부)에 넘긴다.

### MODIFY `apps/web/src/components/Sidebar.drag.ts`, `Sidebar.drag.test.ts`

`nestedKeys` 입력(위 '높이'). 테스트: 자식 그룹이 있는 첫 card가 기준 높이를 키우지 않는다; 자식이 있는 행을
옮기면 잰 높이만큼 자리를 비운다(card, slim 각각).

### MODIFY `apps/web/src/components/Sidebar.logic.test.ts`

- 인덱스: mcp 자식만, provider 자식/보관/삭제 제외, 다른 환경의 같은 부모 id 분리, active 오래된 순,
  finished 최근 순, 변경 없는 부모의 entry 객체 재사용.
- 상태: attention/working/queued/finished 분류, queued만 있는 자식은 `canStopSidebarDelegatedChild`가 false.
  fixture는 `presentThreadShell`(client-runtime `models.ts`)로 만든 실제 형태의 shell을 쓴다: queued만 있는 자식
  (`status: "queued"`, `activityRunStatus: null`), 오래된 활성 run + 새 queued run(`activityRunStatus: "running"`),
  idle + `pendingBackgroundTasks`.
- 창: attention 4개면 4개 모두 + working 3개 + hidden 수, finished 접힘/펼침/페이지, `showFinished: false`, 숨은 열린 자식의 `pinnedOpenRow`(중복 없음).

## 수락 기준

- 위 테스트 통과.
- 활성 조건: active 자식이 4개 이상이면 "+N more running"이 보이고, 열린 자식이 접힌 범위에 있으면
  `pinnedOpenRow`로 보인다 (로직 테스트로 확인).
- 웹 typecheck, 변경 파일 lint, fmt --check 통과.
- 사용자 동의 없이 브라우저 검증은 하지 않는다 (AGENTS.md). 시각 확인은 PR 리뷰어 몫으로 남기고 PR에 적는다.

## 검증 명령

- `vp test run apps/web/src/components/Sidebar.logic.test.ts`
- `vp test run apps/web/src/components/Sidebar.drag.test.ts`
- `vp lint <changed files>` (oxlint), `vp fmt --check <changed files>`
- `vp run --filter @t3tools/web typecheck`
