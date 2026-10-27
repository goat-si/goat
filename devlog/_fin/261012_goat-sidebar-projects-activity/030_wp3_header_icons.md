# 030 — wp3: 제목 줄 종/검색 아이콘, ⌥⌘U

워크트리 `~/.goat/worktrees/goat/sidebar-header`, 브랜치 `codex/sidebar-header`. 소유: `sidebar/SidebarChrome.tsx`, 새
`sidebar/SidebarViewToggles.tsx`, `packages/contracts/src/keybindings.ts`, `packages/shared/src/keybindings.ts`,
`AppSidebarLayout.tsx`의 키 처리, `CommandPalette.tsx`. `Sidebar.tsx`/`LegacySidebar.tsx`는 고치지 않는다.

## 규칙

- `SidebarChromeHeader` 오른쪽에 아이콘 버튼 두 개: 종, 검색. 두 보기 모두. 설정 화면(`isOnSettings`)에서는 숨긴다.
  데스크톱 drag-region 안에서 클릭되게 no-drag. 좁은 폭/모바일 폭에서도 브랜드와 겹치지 않게.
- 종: 기존 클라이언트 설정 업데이트 훅으로 `legacySidebarEnabled`를 뒤집는다. 액티비티 뷰일 때 눌린 상태(aria-pressed),
  툴팁 "View activity" / "Turn off activity view" + 단축키 라벨. 프로젝트 뷰에서 승인/입력을 기다리는 최상위 스레드
  (전역 에이전트 제외, delegated 자식 attention 포함)가 있으면 주의 변형(점 있는 종, 라벨 "View activity, needs attention").
  이 판정은 작은 순수 함수 + 테스트.
- 새 명령 `sidebar.toggleActivity`: contracts `STATIC_KEYBINDING_COMMANDS`, 기본 바인딩 `mod+alt+u`는
  `packages/shared/src/keybindings.ts`, 처리는 `AppSidebarLayout.tsx`의 기존 `sidebar.toggle` 처리 옆, 명령 팔레트 항목
  ("View activity"/"Turn off activity view"). 서버는 계약 목록으로 검증·백필하므로 서버 코드는 바꾸지 않고, 기존 서버
  키바인딩 테스트가 기본 목록 전체를 고정하고 있으면 그 기대값만 갱신한다.
- 검색 아이콘: `apps/web/src/components/sidebar/sidebarSearchFocus.ts`(010에 적힌 내용 그대로, wp1도 같은 내용으로 만든다)의
  `requestSidebarSearchFocus()`를 부른다. 수신자가 있으면(액티비티 뷰 — wp1이 Sidebar.tsx에서 구독) 인라인 검색 입력에 포커스,
  false를 돌려받으면(프로젝트 뷰) 명령 팔레트를 연다.
- 데스크톱 앱 메뉴는 고치지 않는다(000 범위 밖).

## 증명

shared 키바인딩 기본 해석 테스트(`mod+alt+u` → `sidebar.toggleActivity`), 주의 판정 테스트, apps/web·contracts·shared 타입체크,
대상 파일 lint.
