# chase — upstream T3 추적

GOAT는 [pingdotgg/t3code](https://github.com/pingdotgg/t3code)의 포크이고 git 히스토리를 공유한다.
그래서 jawcode처럼 별도 클론을 읽고 카드 단위로 손 포팅하지 않는다. upstream은 사이클마다
`git merge`로 들여오고, 이 폴더는 그 머지를 안전하게 만드는 기록만 둔다.

- 어디까지 따라갔는가: [000_baseline.md](./000_baseline.md)
- GOAT가 일부러 다르게 가져가는 것과 충돌 시 정책: [010_fork_delta.md](./010_fork_delta.md)
- 한 사이클을 도는 순서: [020_cycle_runbook.md](./020_cycle_runbook.md)
- 이번 사이클에 남은 결정: [10_t3_chase_MOC.md](./10_t3_chase_MOC.md)

## 구조

```text
devlog/_chase/
  README.md                    규약 (이 문서)
  000_baseline.md              reviewed-through 기준선과 사이클 로그
  010_fork_delta.md            GOAT 의도적 분기 레지스트리 (영역 슬러그, 충돌 정책)
  020_cycle_runbook.md         사이클 절차와 명령
  scan.sh                      기준선, fork delta ID, trial merge 충돌, 마이그레이션 id, 이름 누수, workflow 스캔
  10_t3_chase_MOC.md           T3 축 카드 목록과 상태
  10.NNN_t3_chase_<topic>.md   열린 카드
  _fin/10/                     닫힌 카드
```

번호 `10`은 T3 upstream 축이다. jawcode의 `10`(gjc)/`20`(omp)과 같은 규칙이고, 두 번째
upstream이 생기면 `20`을 쓴다. 카드 번호는 축 안에서 단조 증가하며 재사용하지 않는다.

## jawcode chase와 다른 점

| 항목          | jawcode `struct_har/chase`                 | GOAT `devlog/_chase`                                            |
| ------------- | ------------------------------------------ | --------------------------------------------------------------- |
| upstream 코드 | `devlog/_gjc_chase/` gitignored 클론       | 같은 repo의 `upstream` remote                                   |
| 반영 방식     | 카드마다 읽고 포팅                         | 사이클마다 `git merge`, 카드는 머지가 남긴 결정만               |
| 기준선        | 클론 HEAD를 손으로 기록                    | `git merge-base origin/dev upstream/main`이 곧 reviewed-through |
| 카드          | 10항목 확장 섹션                           | 아래 짧은 템플릿                                                |
| 형태 스냅샷   | `struct_har/<side>/<band>` 재생성 스크립트 | 없음. [010](./010_fork_delta.md)의 영역 표가 그 역할을 한다     |

## 규칙

1. upstream은 merge commit으로만 들인다. rebase, squash, cherry-pick은 merge-base를 전진시키지
   않아서 다음 사이클이 같은 충돌을 다시 만난다. 급한 hotfix만 cherry-pick을 허용하고, 다음
   사이클 머지가 그것을 흡수한다. dev 랜딩도 squash가 아니라 merge commit 또는 fast-forward다.
2. 머지 대상은 스캔한 upstream SHA로 고정한다. 스캔과 머지 사이에 `upstream/main`이 움직여도
   카드가 설명하는 범위와 실제 머지 범위가 같아야 한다.
3. 충돌 해결은 [010](./010_fork_delta.md)의 영역별 정책을 따른다. 정책으로 결정되지 않는 충돌,
   데이터나 사용자 계약을 바꾸는 선택은 카드로 만들고 `⛔ needs decision`으로 둔다.
4. 텍스트 충돌이 없어도 `scan.sh`의 마이그레이션 id, `t3_*` 이름 누수, workflow 변경을 확인한다.
   이 셋은 깨끗하게 머지되고도 GOAT를 깨뜨린다.
5. 검증 정본은 머지 head에서 도는 goat-ci(EPYC)의 check, typecheck, test, build다. 로컬은 충돌
   파일의 focused test와 해당 패키지 typecheck까지만 한다.
6. dev에 랜딩한 뒤 [000](./000_baseline.md)의 기준선과 사이클 로그를 갱신하고, 닫힌 카드를
   `_fin/10/`으로 옮긴다.

## 카드 템플릿

```markdown
# 10.NNN — 제목

> 사이클: YYMMDD · 상태: ⬜ open | 🟡 in progress | ⛔ needs decision | ✅ fin
> upstream: <sha> (#PR) · GOAT 영역: `<slug>` (010 참조)

## 무엇이 다른가

upstream 변경과 GOAT 쪽 상태를 path:line 근거로 쓴다.

## 결정

import | adapt | reject | split 중 하나와 이유.

## 할 일

## 닫는 근거

머지 커밋, focused test, goat-ci run id.
```

닫을 때는 파일을 `_fin/10/`으로 옮기고, 헤더에 `Closed: YYYY-MM-DD <goat commit>`을 추가하고,
MOC 행을 `✅ _fin`으로 바꾼다. 카드 하나가 둘 이상의 결정을 품으면 split해서 새 번호를 받는다.
