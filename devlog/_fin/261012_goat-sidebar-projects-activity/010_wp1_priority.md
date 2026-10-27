# 010 — wp1: 액티비티 뷰 Priority 구역

워크트리 `~/.goat/worktrees/goat/sidebar-priority`, 브랜치 `codex/sidebar-priority`. 소유: `Sidebar.tsx`,
`Sidebar.logic.ts`(+test), `SettingsPanels.tsx`의 Working 행, `settingsSearch.ts`의 Working 항목.

## 소속 규칙

- 후보: 지금 액티비티 뷰에 보이는 최상위 스레드(전역 에이전트 스레드 제외 — Sidebar.tsx:2848의 제외를 그대로, delegated
  자식은 최상위가 아니므로 후보 아님), snooze되지 않은 것.
- 다음 중 하나면 Priority:
  1. 상태 approval / input (`resolveSidebarThreadStatus`)
  2. 상태 working / waiting
  3. 읽지 않은 완료(`hasUnseenCompletion`, lastVisitedAt은 기존 `resolveThreadLastVisitedAt`로 서버+로컬 합침) 또는 woke 복귀
  4. 중첩된 delegated 자식 중 하나라도 attention(`sidebarDelegatedChildState === "attention"`) — 부모가 Priority로 올라가고
     자식은 지금처럼 부모 아래 중첩 한 번만 보인다.
- 고정(pinned)이나 settled여도 위 조건이면 Priority로 간다. 조건이 풀리면 원래 구역으로 돌아간다.
- Priority에 있는 스레드는 Pinned, Active, Working, Settled 어디에도 다시 나오지 않는다.

## 보이는 구역과 수명 상태 분리

- Priority는 **보이는 구역**일 뿐이다. 서버 상태(pinnedAt, settledOverride, snooze)는 바꾸지 않는다.
- 행 액션은 보이는 구역이 아니라 수명 상태에서 정한다: 기본 액션은 settled면 Un-settle, 아니면 Settle(pinned 포함 — 지금과
  같다). Unpin은 지금처럼 별도 컨트롤(Sidebar.tsx:1812)로 그대로 둔다. `section === "settled"`로 액션을 고르는 곳
  (Sidebar.tsx:5482 근처)과 끝난 자식 표시 여부(`section !== "settled"`, Sidebar.tsx:5468)를 수명 상태(settled 여부) 기준으로 바꾼다.
- 테스트: settled+unread → Priority, 읽음 처리 뒤 Settled로 복귀(뮤테이션 없음). pinned+working → Priority, 끝나고 읽으면
  Pinned 원래 자리. 자식 attention이 부모를 올리고 첫 묶음으로 정렬됨. Priority 안의 settled 행이 끝난 자식을 숨기는 규칙 유지. 전역 에이전트 제외. snoozed+working은 Snoozed에 남음.

## 정렬

approval/input 또는 delegated 자식 attention → working/waiting → unread/woke. 각 묶음 안에서는 최근 활동 순, 동률은 스레드 키로 고정.

## 드래그

- `SidebarSection`에 "priority", 마커에 "priority-header" 추가. Priority 행은 드래그 출발 불가, Priority 위로 놓기 불가
  (슬롯 분류에서 Priority 행/마커를 대상에서 제외; 기존 Working/Snoozed 거절 경로와 같은 방식). 낙관적 투영(optimisticDrop)은
  Priority 행을 만들지 않는다. 드래그 중인 행의 보이는 구역이 Priority로 바뀌면 드래그를 취소한다(기존 "행이 사라지면 취소"
  효과를 "구역이 바뀌어도 취소"로 넓힘). Sidebar.logic 테스트로 드롭 대상 해석을 고정.

## Working 선반

Priority가 대신한다. Working 선반 렌더링·드래그 미리보기의 Working 분기를 없애고, 설정 화면의 Working 토글과
검색 항목을 지운다. 스키마 필드 `sidebarWorkingShelfEnabled`는 디코드 호환을 위해 남기고 더는 읽지 않는다.
(인박스 복귀 정렬 `sortInboxThreadsByReturn`도 Working 설정에 묶여 있으면 함께 정리하고 Active는 기존 기본 정렬.)

## 탐색, 검색

- 사이드바 검색 대상(Sidebar.tsx:2968 근처 searchableThreads)에 Priority 포함.
- ⌘1..9 점프와 이전/다음 스레드 순서는 화면 순서(Priority가 맨 앞)를 따른다.

## 검색 포커스 수신

wp3가 쓰는 `apps/web/src/components/sidebar/sidebarSearchFocus.ts`를 이 레인도 **똑같은 내용으로** 만든다(같은 내용의 add/add는
병합 충돌이 없다). `Sidebar.tsx`에서 `subscribeSidebarSearchFocus`로 구독해 `threadSearchInputRef`에 포커스한다.

```ts
// Lets the sidebar title-row search icon focus the Activity view's inline
// thread search without either component owning the other's refs.
type Listener = () => void;
const listeners = new Set<Listener>();

export function requestSidebarSearchFocus(): boolean {
  for (const listener of listeners) listener();
  return listeners.size > 0;
}

export function subscribeSidebarSearchFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
```

## 헤더

"Priority" + 개수, … 메뉴에 "Mark all as read"(읽지 않은 Priority 스레드를 기존 visit 명령으로). 비면 구역 숨김.

## 증명

`vp test run apps/web/src/components/Sidebar.logic.test.ts`, apps/web 타입체크, 대상 파일 lint.
