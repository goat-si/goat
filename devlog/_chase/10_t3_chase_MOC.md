# 10 — T3 chase MOC

> 축: upstream `pingdotgg/t3code` `main`
> reviewed-through: `de49d637d` (fork point) · 머지 대상: `v0.0.46-nightly.20261012.3021` · 갱신 2026-10-13

| NNN | 카드                                                                   | GOAT 영역           | P      | 상태         |
| --- | ---------------------------------------------------------------------- | ------------------- | ------ | ------------ |
| 001 | [사이클 261012 triage](./10.001_t3_chase_cycle_261012.md)              | 전체                | **P1** | ↪ 005가 대체 |
| 002 | [마이그레이션 id 61 충돌](./10.002_t3_chase_migration_61_collision.md) | `server-activity`   | **P0** | 🟡 PR 리뷰   |
| 003 | [새 upstream `t3_*` 이름](./10.003_t3_chase_goat_tool_names.md)        | `mcp-names`         | **P1** | ✅ PR 반영   |
| 004 | [SSH tunnel 테스트 이식](./10.004_t3_chase_ssh_tunnel_port.md)         | `ssh-runtime`, `ci` | P2     | ✅ PR 반영   |
| 005 | [사이클 261013 머지](./10.005_t3_chase_cycle_261013.md)                | 전체                | **P1** | 🟡 PR 리뷰   |

머지 순서: 005 PR(002-004 포함) goat-ci green → dev에 merge commit으로 랜딩 → 000 기준선 갱신, 카드 `_fin` 이동.

## \_fin

아직 없음. 닫힌 카드는 [`_fin/10/`](./_fin/README.md)에 둔다.
