# 20 — Cua Driver 기준선

> 갱신: 2026-10-25 (사이클 0 진행 중, [20.001](./20.001_cua_chase_fork_bootstrap.md). reviewed-through `0c0ffa5bc32e` = trycua/cua `2d2f99228d`)

GOAT는 Cua Driver를 별도 저장소 [goat-si/cua-driver](https://github.com/goat-si/cua-driver)에서 빌드한다. T3 축과 달리
upstream과 GOAT 저장소가 git 히스토리를 공유하지 않는다. upstream monorepo의 `libs/cua-driver`를 `git subtree split`으로
잘라 포크의 `upstream` 브랜치에 쌓고, 그것을 포크 `main`에 머지한 뒤, 포크가 낸 아티팩트를 GOAT가 pin한다.
포크 쪽 규약 요약은 포크의 [GOAT.md](https://github.com/goat-si/cua-driver/blob/main/GOAT.md)에 있고, 이 문서는 GOAT가 어디까지
따라갔는지를 기록한다.

## 현재 기준선

| 항목                        | 값                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| upstream                    | [trycua/cua](https://github.com/trycua/cua) `main`, 경로 `libs/cua-driver`. MIT, 루트 `LICENSE.md` "Copyright (c) 2025 Cua AI, Inc."                   |
| upstream 릴리스 태그        | `cua-driver-rs-v<version>` (monorepo의 다른 패키지 태그와 섞여 있다)                                                                                   |
| fork point                  | `cua-driver-rs-v0.37.0` = `2d2f99228d4d2508dc6fcc84c176b296e146714a` (2026-10-20 릴리스)                                                               |
| 포크 저장소                 | `goat-si/cua-driver` (2026-10-25 생성, public). `upstream` = subtree split만, `main` = `upstream` + GOAT 변경(PR로만)                                  |
| reviewed-through (split)    | 포크 `upstream` `0c0ffa5bc32e`, 태그 `upstream-v0.37.0`. trycua/cua `2d2f99228d`의 split이다                                                           |
| 포크 `main`                 | `ec339be454a5`: split 위에 GOAT 커밋 2개 (`64ba7cd62620` standalone 빌드·`vendor/`·`LICENSE.md`, `ec339be454a5` GOAT.md). PR goat-si/cua-driver#1 열림 |
| 포크 릴리스                 | `cua-driver-rs-v0.37.0-goat.2` (포크 `main` `fed205570015`, 2026-10-25). 서명 없음 + attestation. 태그 규약은 포크 GOAT.md                             |
| GOAT가 실제로 쓰는 드라이버 | 포크 `0.37.0-goat.2` 아카이브를 크기·SHA-256으로 pin (#1591). 헬퍼 빌드가 Developer ID로 서명                                                          |
| upstream 앞섬               | 0.38.0 (`85e2b1318bd7`, 2026-10-21) 경로 커밋 29개, `main` 기준 44개 (2026-10-25)                                                                      |

reviewed-through는 포크 `upstream` 브랜치 tip과 그것이 split한 trycua/cua 커밋의 쌍이다. split 커밋은 upstream SHA와 다르므로
사이클마다 두 값을 함께 적는다. 같은 git과 같은 `--prefix`로 같은 upstream 커밋을 split하면 같은 SHA가 나온다: 2026-10-25에
blobless 클론(git 2.54.0)에서 `cua-driver-rs-v0.37.0`을 split한 결과가 포크 `upstream`과 같은 `0c0ffa5bc32e`였고, 0.38.0의
split `a10bf063f35a`는 그것을 조상으로 가진다. 그래서 다음 사이클의 split은 `upstream`을 fast-forward한다.

## GOAT pin이 선언된 곳

포크 아티팩트로 바꾸는 사이클(#1591)과 이후 모든 pin bump는 이 파일들을 함께 바꾼다.

| 무엇                                  | 어디                                                                                                                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 드라이버 버전                         | `packages/shared/src/cuaDriverRelease.ts:3` `CUA_DRIVER_VERSION`                                                                    |
| 플랫폼별 아카이브 이름·바이트·SHA-256 | `packages/shared/src/cuaDriverRelease.ts:11-37`                                                                                     |
| 다운로드 URL                          | `packages/shared/src/cuaDriverRelease.ts` (`github.com/goat-si/cua-driver/releases/download/cua-driver-rs-v…`)                      |
| 아카이브 안의 필수 파일               | `packages/shared/src/cuaDriverRelease.ts:66-79` `requiredFiles`                                                                     |
| 텔레메트리·업데이트 확인 끄기         | `packages/shared/src/cuaDriverRelease.ts:85-91`, `:140-148`                                                                         |
| SDK                                   | `pnpm-workspace.yaml:58` catalog `@trycua/cua-driver: 0.37.0`, 사용처 `apps/server/package.json:58`, `apps/desktop/package.json:24` |
| 고지                                  | `third-party-licenses.config.json:265-274` `Cua Driver` 항목, `apps/desktop/src/cua/notices/`                                       |
| 검증 후 사용                          | `scripts/build-computer-use-helper{,-windows,-linux}.ts`, `scripts/desktop-artifact-computer-use.ts`                                |

포크는 npm SDK를 발행하지 않는다. npm `@trycua/cua-driver`는 계약 필드 0.8.0을 검사하므로 0.37.0을 유지한다. 결정 근거는
[ADR-0022](../../structure/decisions/ADR-0022-cua-driver-computer-use.md)와
[ADR-0023](../../structure/decisions/ADR-0023-goat-computer-use-app.md)이고, 포크 결정에 맞춘 개정은 #1594다.
`devlog/_chase/scan.sh --cua`가 이 선언들과 upstream·포크의 최신 태그를 한 번에 출력한다.

## 사이클 로그

| 사이클 | 날짜       | upstream 범위                    | 경로 커밋 | 결과                                                         | 카드   |
| ------ | ---------- | -------------------------------- | --------- | ------------------------------------------------------------ | ------ |
| 0      | 2026-10-25 | fork point `2d2f99228d` (0.37.0) | 1180      | 진행 중: 포크 생성, standalone 빌드. CI·릴리스·pin 전환 남음 | 20.001 |
