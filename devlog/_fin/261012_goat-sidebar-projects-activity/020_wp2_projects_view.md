# 020 — wp2: 프로젝트 뷰

워크트리 `~/.goat/worktrees/goat/sidebar-projects`, 브랜치 `codex/sidebar-projects`. 소유: `LegacySidebar.tsx`,
`packages/contracts/src/settings.ts`의 `legacySidebarEnabled`, `useSettings.ts`, `_chat.tsx`, `SettingsPanels.tsx`의
legacy-sidebar 행, `settingsSearch.ts`의 legacy-sidebar 항목.

## 기본 보기와 hydration 정책

- 프로젝트 뷰 = 기존 `LegacySidebar`. 보이는 이름 "Projects view" / "Activity view". 키 이름 `legacySidebarEnabled`는 유지
  (true = Projects), 스키마 주석으로 의미를 적는다.
- 디코드 기본값을 `true`로. 설정은 객체 전체를 저장하므로(useSettings.ts:175) 이미 저장한 사용자는 값이 그대로다;
  키가 없는 문서·저장본이 없는 새 설치만 Projects로 시작한다.
- `useLegacySidebarEnabled`: hydration 전과 hydration 실패 시 기본 보기(Projects)를 그린다 →
  `settingsHydrated ? value : true`. 그래서 기본 사용자에게 깜빡임이 없고, 명시적 false(Activity)를 고른 사람만 hydration 뒤
  한 번 바뀐다(지금 legacy opt-in이 겪는 것과 같은 대칭).
- 테스트: ClientSettingsSchema 디코드 — 키 없음 → true, 명시 true/false 유지. 데스크톱 문서의 wrapped/bare 두 모양이 같은
  스키마를 지나는지 기존 테스트 파일이 있으면 거기에 한 케이스씩.
- 훅 동작 테스트: 보기 판정을 순수 함수(`resolveSidebarViewIsProjects({hydrated, value})` 등)로 빼서 hydration 전 → true,
  hydration 뒤 true/false 그대로, 저장본 없음(기본값) → true, hydration 실패(기본값 유지) → true를 고정한다.

## 새 채팅(⌘N)

`_chat.tsx:133`: 액티비티 뷰 + 프로젝트 여러 개 → 프로젝트 선택 팔레트, 프로젝트 뷰 → 현재 맥락에서 바로 생성. Codex와
같은 의도된 동작이므로 유지하고 PR 본문에 적는다. hydration 전에는 위 정책대로 Projects 동작.

## Pinned 구역

- 프로젝트 뷰 맨 위 "Pinned": `pinnedAt`이 있는 최상위 스레드(전역 에이전트 제외), `sortPinnedThreadsForSidebar` 순서.
  Pinned 스레드는 프로젝트 목록에서 빠진다(중복 없음).
- LegacySidebar에는 고정 기능이 없다(컨텍스트 메뉴 LegacySidebar.tsx:2333 근처). 액티비티 뷰가 쓰는 고정/해제 명령과
  capability(`threadPinning`)·권한 검사를 그대로 가져와 프로젝트 뷰 스레드 메뉴에 "Pin thread"/"Unpin thread"를 넣는다.
  capability가 없는 서버의 스레드에는 항목을 숨긴다.
- ⌘1..9 점프와 이전/다음 순서: Pinned를 앞에 붙이고 프로젝트 목록 순서(LegacySidebar.tsx:3563 `sortedProjects.flatMap`)에서
  중복 제거.

## 프로젝트 줄 호스트 표시

원격 환경 프로젝트는 오른쪽에 호스트 이름(`remoteEnvironmentLabels`, 여러 개면 첫째 + "+N")과 연결 점(연결됨 초록, 오류/끊김
빨강, 연결 중 회색 — 환경 connection phase에서). 로컬 프로젝트는 표시 없음. 기존 machine 아이콘 툴팁은 유지.

## Search 줄

프로젝트 뷰의 고정 헤더 "Search" 줄(LegacySidebar.tsx:3086)은 wp3의 검색 아이콘이 대신하므로 지운다. 명령 팔레트 단축키는 그대로.

## 설정 화면

legacy-sidebar 행을 Legacy features에서 꺼내 일반 사이드바 설정 쪽으로: "Sidebar view" 선택(Projects / Activity),
검색 항목 제목·검색어(sidebar, projects, activity, priority)·앵커 갱신.

## 증명

설정 디코드 테스트, 새 순수 로직(점프 순서 등) 테스트, apps/web 타입체크, 대상 파일 lint.
