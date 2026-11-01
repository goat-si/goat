# 000 — 사이드바: 프로젝트 뷰 + 액티비티 뷰(Priority)

> 브랜치: `codex/sidebar-priority`, `codex/sidebar-projects`, `codex/sidebar-header` (모두 base `origin/dev` 8dbb71880)

## 목표

Codex 데스크톱 사이드바처럼 두 가지 보기를 둔다.

1. **프로젝트 뷰(기본)**: 위에 Pinned, 아래에 프로젝트별 스레드 트리. 프로젝트 줄에 호스트 이름과 연결 점.
2. **액티비티 뷰**: 제목 줄의 종 아이콘(⌥⌘U)으로 켜고 끈다. 맨 위 **Priority** 구역에 돌고 있거나,
   승인/입력을 기다리거나, 읽지 않은 완료가 있는 스레드를 모은다. Priority에 있는 스레드는 아래 구역
   (Pinned, Active, Snoozed, Settled)에 다시 나오지 않는다.
3. 종 옆에 검색 아이콘.

## 이미 있는 것 (조사 결과)

- 두 보기 모두 이미 있다. `AppSidebarLayout.tsx`가 `legacySidebarEnabled` 클라이언트 설정으로
  `LegacySidebar.tsx`(프로젝트 트리)와 `Sidebar.tsx`(인박스 = 액티비티 뷰)를 고른다. 설정은
  Settings → Legacy features 안에 숨어 있어서 사용자에게는 "액티비티 뷰밖에 없는" 상태다.
- 두 사이드바는 제목 줄 `SidebarChromeHeader`를 공유한다. 종/검색 아이콘은 여기 한 곳에 넣으면 두 보기에 다 보인다.
- 액티비티 뷰의 구역 순서: Pinned, Active, Working(beta 설정, 켜졌을 때만), Snoozed, Settled. 고정 스레드는 작업 상태(working)
  때문에 Pinned에서 밀려나지 않는다(Sidebar.tsx:2856). 단 snooze와 settle은 pin보다 앞선다(Sidebar.logic.ts:144). 돌고 있는 스레드는 Active 안에서 흐리게(recede, 단 열려 있거나 선택된
  행은 예외 — Sidebar.logic.ts:1138) 보이거나, Working 설정이 켜져 있으면 Active 아래 Working 선반으로 간다.
  돌고 있는 것만 위에 모아 보는 구역이 없어서 "돌고 있는 게 안 보인다".
- 상태 모델: `resolveSidebarThreadStatus` (approval, input, working, waiting, failed, limited, ready),
  읽음은 `hasUnseenCompletion` + `resolveThreadLastVisitedAt`, woke는 snooze 복귀.

## 참고

- Codex 앱(`~/Developer/codex/chatgpt-app-deobf`, 26.930, 코디네이터가 `app/webview/assets/app-initial-60d038a052d7.js` 오프셋 ~8.03M에서 직접 확인): `sidebarElectron.priorityThreads` —
  "See chats that are unread, active, or awaiting a response". 종 툴팁 "View activity" / "Turn off activity view",
  주의가 필요하면 "View activity, needs attention" 변형. Priority 메뉴에 "Mark all as read". 최근 구역은 Priority를 뺀다.
- Synara(`../synara`, MIT): `SidebarActivityView.logic.ts`, `SidebarActivityBellButton`, `SidebarGroupsSurface`.

## 단계 지도

| wp  | 문서                              | 내용                                           | 의존  |
| --- | --------------------------------- | ---------------------------------------------- | ----- |
| wp0 | 000                               | 조사, 로드맵                                   | -     |
| wp1 | [010](./010_wp1_priority.md)      | 액티비티 뷰 Priority 구역                      | wp0   |
| wp2 | [020](./020_wp2_projects_view.md) | 프로젝트 뷰를 기본 보기로, Pinned, 호스트 표시 | wp0   |
| wp3 | [030](./030_wp3_header_icons.md)  | 종/검색 아이콘, ⌥⌘U, 명령 팔레트               | wp0   |
| wp4 | [040](./040_wp4_integrate.md)     | 리뷰, exact-head CI, dev 병합                  | wp1-3 |

wp1-3은 서로 다른 워크트리에서 동시에 짓는다. 소유는 아래 표를 따른다.

## 파일 소유 (레인 사이 충돌 방지)

| 파일                                                                                                                                | 소유 레인 | 다른 레인           |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------- |
| `Sidebar.tsx`, `Sidebar.logic.ts`(+test)                                                                                            | wp1       | wp3는 손대지 않는다 |
| `SettingsPanels.tsx`의 Working 행, `settingsSearch.ts`의 Working 항목                                                               | wp1       |                     |
| `LegacySidebar.tsx` 전부(Search 줄 제거 포함)                                                                                       | wp2       |                     |
| `packages/contracts/src/settings.ts` 기본값, `useSettings.ts`, `_chat.tsx`                                                          | wp2       |                     |
| `SettingsPanels.tsx`의 legacy-sidebar 행, `settingsSearch.ts`의 legacy-sidebar 항목                                                 | wp2       |                     |
| `sidebar/SidebarChrome.tsx`, 새 `sidebar/SidebarViewToggles.tsx`                                                                    | wp3       |                     |
| `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`, `AppSidebarLayout.tsx` 키 처리, `CommandPalette.tsx` | wp3       |                     |

wp3는 보기 전환을 `useUpdateClientSettings`류 기존 훅으로 `legacySidebarEnabled`만 뒤집는다(새 상태 저장소 없음).
`SettingsPanels.tsx`/`settingsSearch.ts`는 wp1과 wp2가 서로 다른 행을 고친다. 병합 충돌은 코디네이터가 푼다.
병합 순서 wp1 → wp3 → wp2.

## 범위 밖

서버 동작 변경(키바인딩 백필은 계약 목록을 자동으로 따른다), 데스크톱 앱 메뉴(View 메뉴에 항목을 더하지 않는다 — 단축키·종·명령 팔레트로 충분), 모바일 UI(모바일은 자체 내비게이션을 유지 — 이번 변경에서 지원하지 않음), 라이브 GOAT
(`~/.t3`, 127.0.0.1:3773). 설정 키 이름 `legacySidebarEnabled`는 와이어 호환을 위해 그대로 둔다.

## 서브에이전트 운용

빌더: Sol(`gpt-6.1-sol`) 레인 3개, 각자 워크트리 `~/.goat/worktrees/goat/sidebar-{priority,projects,header}`.
리뷰: 빌더와 다른 Sol 인스턴스가 PR head에서 읽기 전용 리뷰. 통합·병합은 주 에이전트만 한다.
