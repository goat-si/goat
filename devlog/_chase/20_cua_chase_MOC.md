# 20 — Cua Driver chase MOC

> 축: upstream `trycua/cua` `libs/cua-driver` (태그 `cua-driver-rs-v*`) · 포크 [goat-si/cua-driver](https://github.com/goat-si/cua-driver)
> reviewed-through: 포크 `upstream` `0c0ffa5bc32e` = trycua `2d2f99228d` (0.37.0) · GOAT pin: upstream 0.37.0 바이너리 (#1591 전) · 열린 카드 001 · 갱신 2026-10-25

- 어디까지 따라갔는가, GOAT pin이 어디 있는가: [20_cua_baseline](./20_cua_baseline.md)
- 포크가 upstream과 다른 곳과 충돌 정책: [20_cua_fork_delta](./20_cua_fork_delta.md)
- 한 사이클을 도는 순서: [20_cua_cycle_runbook](./20_cua_cycle_runbook.md)
- 포크 저장소 쪽 요약: 포크의 [GOAT.md](https://github.com/goat-si/cua-driver/blob/main/GOAT.md). 결정은 #1595, ADR 개정은 #1594

| NNN | 카드                                                                   | 포크 delta 영역                                                | P   | 상태           |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------- | --- | -------------- |
| 001 | [사이클 0: 포크 생성과 pin 전환](./20.001_cua_chase_fork_bootstrap.md) | `attribution` `ci-release` `standalone-build` `versioning-sdk` | P1  | 🟡 in progress |

## 포크 작업과 영역

| 작업                                  | issue                         | 영역                                            |
| ------------------------------------- | ----------------------------- | ----------------------------------------------- |
| 라이선스·고지 감사                    | #1589                         | `attribution`                                   |
| 포크 CI, 아티팩트, 호환성 테스트, SDK | #1590                         | `ci-release` `protocol-compat` `versioning-sdk` |
| GOAT pin을 포크 아티팩트로            | #1591                         | (GOAT 쪽, runbook 8-9번)                        |
| 부모가 죽으면 드라이버 종료           | #1592                         | `parent-death`                                  |
| click·`run_steps` 지연 측정           | #1593                         | `protocol-compat`                               |
| ADR-0022/0023, computer-use.md 개정   | #1594                         | (문서)                                          |
| `screencapture` 마이크 권한 창        | #1588, #1600, trycua/cua#5938 | `screencapture-fallback`                        |
| 포크로 옮길 드라이버 issue            | #1221, #1261, #1242           | 포크 PR이 생기면 영역 추가                      |

머지 순서: 포크 `upstream` fast-forward → 포크 PR을 `main`에 merge commit으로 → 후보 아티팩트로 GOAT 검증과 OS별 live 확인 →
릴리스 태그 → GOAT pin PR → [20_cua_baseline](./20_cua_baseline.md) 갱신, 카드 `_fin/20/` 이동.

## \_fin

| NNN | 카드 | 닫힘 |
| --- | ---- | ---- |
