# 010 — rebase와 사이드바 재부착 (wp1)

## 무엇이 바뀌었나

dev는 오늘 Projects를 기본 보기로 바꿨다(87e94bcaa). Projects 보기는 `LegacySidebar.tsx`, Activity 보기는 `Sidebar.tsx`다. Projects 보기의 `SidebarProjectsContent`는 Search 행이 든 `fixedHeader`를 없애 `<SidebarContent>`만 남았다. 그래서 기존 커밋 1b7c12422의 봇 항목 자리가 사라진다(trial rebase에서 LegacySidebar.tsx 충돌, L2c 통합 브랜치에서도 같은 충돌 확인).

## 할 일

- `git rebase origin/dev`. 충돌은 LegacySidebar.tsx(커밋 1). `routeTree.gen.ts`가 충돌하면 손으로 풀지 않고 재생성한다.
- Projects 보기: `SidebarContent`에 `fixedHeader={<SidebarGroup className="z-[1]"><SidebarMenu><GoatBotSidebarRow /></SidebarMenu></SidebarGroup>}`. 070 "스크롤이나 프로젝트 필터에 따라 사라지지 않는다"를 지키려면 스크롤 영역 밖이어야 한다. Pinned 그룹보다 위.
- Projects 보기 `visibleProjectThreads`: dev의 `pinnedThreads ??` 분기를 유지하고 그 안의 `excludeGlobalAgentThreads(..., globalAgentRef, goatBotRef)`로 봇을 뺀다. useMemo deps에 둘 다.
- Projects 보기 루트 목록(`LegacySidebar` 기본 export의 `sidebarThreads = excludeGlobalAgentThreads(allThreadShells, globalAgentRef)`, dev 3376-3379)에 goatBotRef를 넘긴다. 이 목록이 visibleThreads, pinnedThreads, 키보드 이동 순서를 먹인다.
- Projects 보기 `pinnedThreads`는 이미 걸러진 루트 목록에서 나오므로 따로 거르지 않는다(감사 r2 7).
- Activity 보기: `SidebarThreadHeader` 아래 `<SidebarMenu className="mt-1"><GoatBotSidebarRow /></SidebarMenu>`는 자동 머지로 유지된다. dev의 priorityHoldsRef와 goatBotRef를 함께 둔다. Priority 목록도 `excludeGlobalAgentThreads`를 거친 `visible`에서 나오는지 확인한다.

## 검증

- `node_modules/.bin/vp test run apps/web/src/components/goatBot apps/web/src/globalAgentRoute.test.ts apps/web/src/globalAgentStore.test.ts apps/web/src/components/ThreadRouteView.test.tsx apps/web/src/components/LegacySidebar.logic.test.ts`
- `cd apps/web && pnpm typecheck`
