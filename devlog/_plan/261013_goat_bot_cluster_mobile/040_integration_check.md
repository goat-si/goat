# 040 — 통합 확인 (L1 + L2 + L3 합친 dev)

> 작성 2026-10-13 · 기준 origin/dev `6312aee35` · 브랜치 `fix/integration-check`

## 결론

L1·L2·L3가 새로 깨뜨린 검사는 없다. 실패 7건(서버 6, 모바일 네이티브 2파일)은 모두 L1 직전 `923975527`에서도 똑같이 실패했고, 이 브랜치에서 최소 수정으로 고쳤다. 호스티드 CI는 dev에서 테스트를 돌리지 않고(PR Vouch/Size만), 모바일 네이티브 회귀 테스트는 macOS에서만 돌아서 지금까지 드러나지 않았다.

## 명령과 결과 (macOS, Node 24.17, pnpm 11.10, 수정 후)

`pnpm install --frozen-lockfile` 뒤 각 패키지 디렉터리에서 `pnpm run typecheck`(`tsc --noEmit`)와 `pnpm run test`(`vp test run`).

| 패키지                  | typecheck | test                                          |
| ----------------------- | --------- | --------------------------------------------- |
| apps/server             | pass      | 451 files, 6592 passed, 20 skipped            |
| packages/shared         | pass      | 93 files (+1 skipped), 1524 passed, 1 skipped |
| packages/client-runtime | pass      | 135 files, 2111 passed                        |
| apps/web                | pass      | 501 files, 7134 passed                        |
| apps/mobile             | pass      | 249 files, 2235 passed                        |

## 고친 것

- 모바일: Expo 58 업그레이드(#12045)가 `expo-modules-core@57.0.14`·`expo-notifications@57.0.15` 패치 등록을 떨어뜨렸다. 권한 레지스트리 경합(TSan)은 58.0.11에 그대로 있어 패치를 다시 붙였고, 알림 패치는 58의 `Mutex` 레지스트리 위에 "등록 중 도착한 응답"과 "재생 중 도착한 응답 보존" 두 동작만 옮겼다. 회귀 테스트 스텁을 58 소스에 맞췄다.
- 서버: `migrate-dev-db`가 061의 생성 열(`has_pending_background_work`) 때문에 `SELECT *` 복사에 실패 → 저장 열만 복사.
- 서버: 스토리지 정리가 조상 경로의 심볼릭 링크(macOS `/var`)에서 아무것도 지우지 않음 → 루트 자체가 링크일 때만 거절. 세션 스캐너가 링크된 T3 홈 아래 샌드박스를 프로젝트로 잡음 → 워크트리 디렉터리 realpath도 비교.
- 서버 테스트: #75가 쓰기 시작한 `RemoteDispatchCoordinator.get`을 목에 추가.
- 환경: `ServerBrowserPage.test.ts`는 Playwright headless shell이 없어서 실패했다(`pnpm exec playwright-core install chromium-headless-shell` 후 통과). 코드 변경 없음.
