# chase — upstream 추적

GOAT가 따라가는 upstream은 둘이고, 축 번호로 나눈다.

| 축   | upstream                                                                   | 들이는 방식                                                                                                         | 기준선                                  | 포크 delta                                  | 사이클 절차                                       | MOC                                       |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ------------------------------------------------- | ----------------------------------------- |
| `10` | [pingdotgg/t3code](https://github.com/pingdotgg/t3code) `main`             | 같은 repo의 `upstream` remote를 `git merge`                                                                         | [000_baseline](./000_baseline.md)       | [010_fork_delta](./010_fork_delta.md)       | [020_cycle_runbook](./020_cycle_runbook.md)       | [10_t3_chase_MOC](./10_t3_chase_MOC.md)   |
| `20` | [trycua/cua](https://github.com/trycua/cua) `libs/cua-driver` (Cua Driver) | 별도 repo [goat-si/cua-driver](https://github.com/goat-si/cua-driver)에 subtree split을 머지, GOAT는 아티팩트를 pin | [20_cua_baseline](./20_cua_baseline.md) | [20_cua_fork_delta](./20_cua_fork_delta.md) | [20_cua_cycle_runbook](./20_cua_cycle_runbook.md) | [20_cua_chase_MOC](./20_cua_chase_MOC.md) |

GOAT는 T3 Code의 포크이고 git 히스토리를 공유한다. 그래서 jawcode처럼 별도 클론을 읽고 카드 단위로 손 포팅하지 않는다.
T3 upstream은 사이클마다 `git merge`로 들여오고, 이 폴더는 그 머지를 안전하게 만드는 기록만 둔다.

Cua Driver는 GOAT 저장소에 코드가 없다. GOAT는 드라이버를 포크 저장소에서 빌드하고 그 릴리스 아카이브와 SDK를 이름, 크기,
SHA-256으로 pin한다 (#1595). 그래서 20 축은 두 단계를 기록한다: upstream을 포크에 들이는 것, 포크 릴리스로 GOAT pin을 옮기는 것.

## 구조

```text
devlog/_chase/
  README.md                    규약 (이 문서)
  scan.sh                      T3 스캔 (기본, --delta, --names, --commits)과 Cua 스캔 (--cua)
  000_baseline.md              T3 reviewed-through 기준선과 사이클 로그
  010_fork_delta.md            T3 쪽 GOAT 의도적 분기 레지스트리 (영역 슬러그, 충돌 정책)
  020_cycle_runbook.md         T3 사이클 절차와 명령
  10_t3_chase_MOC.md           T3 축 카드 목록과 상태
  10.NNN_t3_chase_<topic>.md   열린 카드
  20_cua_baseline.md           Cua 기준선, GOAT pin 위치, 사이클 로그
  20_cua_fork_delta.md         포크 goat-si/cua-driver의 분기 레지스트리
  20_cua_cycle_runbook.md      Cua 사이클 절차 (포크 머지부터 GOAT pin까지)
  20_cua_chase_MOC.md          Cua 축 카드 목록과 상태
  20.NNN_cua_chase_<topic>.md  열린 카드
  _fin/10/, _fin/20/           닫힌 카드
```

번호 `10`은 T3 upstream 축, `20`은 Cua Driver 축이다. jawcode의 `10`(gjc)/`20`(omp)과 같은 규칙이다. 카드 번호는
축 안에서 단조 증가하며 재사용하지 않는다.

축 문서 배치 결정 (2026-10-25): 루트의 `000`/`010`/`020`은 T3 축 문서로 이름을 그대로 둔다. AGENTS.md, `scan.sh`, 닫힌
카드가 그 경로를 가리킨다. 두 번째 축부터는 축 문서에 축 번호를 앞에 붙이고 카드 번호는 붙이지 않는다
(`20_cua_baseline.md`). 그래야 MOC와 함께 정렬되고, `20.010` 같은 카드 번호와 겹칠 일이 없다. 포크 delta도 축마다 따로 둔다.
Cua 포크의 커밋은 `origin/dev`에서 닿지 않아 010의 해시 검사를 받을 수 없기 때문이다. 세 번째 upstream은 `30_<name>_*`을 쓴다.

## jawcode chase와 다른 점

| 항목          | jawcode `struct_har/chase`                 | GOAT `devlog/_chase`                                            |
| ------------- | ------------------------------------------ | --------------------------------------------------------------- |
| upstream 코드 | `devlog/_gjc_chase/` gitignored 클론       | 같은 repo의 `upstream` remote                                   |
| 반영 방식     | 카드마다 읽고 포팅                         | 사이클마다 `git merge`, 카드는 머지가 남긴 결정만               |
| 기준선        | 클론 HEAD를 손으로 기록                    | `git merge-base origin/dev upstream/main`이 곧 reviewed-through |
| 카드          | 10항목 확장 섹션                           | 아래 짧은 템플릿                                                |
| 형태 스냅샷   | `struct_har/<side>/<band>` 재생성 스크립트 | 없음. [010](./010_fork_delta.md)의 영역 표가 그 역할을 한다     |

## 규칙 (T3 축)

Cua 축의 규칙은 [20_cua_cycle_runbook](./20_cua_cycle_runbook.md) 머리에 있다. 같은 이유(merge-base 전진, 고정 SHA, 정책 밖은 카드)로 정했다.

1. upstream은 merge commit으로만 들인다. rebase, squash, cherry-pick은 merge-base를 전진시키지
   않아서 다음 사이클이 같은 충돌을 다시 만난다. 급한 hotfix만 cherry-pick을 허용하고, 다음
   사이클 머지가 그것을 흡수한다. dev 랜딩도 squash가 아니라 merge commit 또는 fast-forward다.
2. 머지 대상은 스캔한 upstream SHA로 고정한다. 스캔과 머지 사이에 `upstream/main`이 움직여도
   카드가 설명하는 범위와 실제 머지 범위가 같아야 한다.
3. 충돌 해결은 [010](./010_fork_delta.md)의 영역별 정책을 따른다. 정책으로 결정되지 않는 충돌,
   데이터나 사용자 계약을 바꾸는 선택은 카드로 만들고 `⛔ needs decision`으로 둔다.
4. 텍스트 충돌이 없어도 `scan.sh`의 마이그레이션 id, `t3_*` 이름 누수, workflow 변경을 확인한다.
   이 셋은 깨끗하게 머지되고도 GOAT를 깨뜨린다.
5. 검증 정본은 머지 head에서 손으로 돌린 goat-ci(EPYC) 전체 실행
   (`gh workflow run goat-ci.yml --ref <branch>`)의 check, typecheck, test, build다. PR run은 바뀐
   경로가 닿는 task만 돌고, push로는 돌지 않는다. 로컬은 충돌 파일의 focused test와 해당 패키지
   typecheck까지만 한다.
6. dev에 랜딩한 뒤 [000](./000_baseline.md)의 기준선과 사이클 로그를 갱신하고, 닫힌 카드를
   `_fin/10/`으로 옮긴다.

## 카드 템플릿 (두 축 공통)

```markdown
# <축>.NNN — 제목

> 사이클: YYMMDD · 상태: ⬜ open | 🟡 in progress | ⛔ needs decision | ✅ fin
> upstream: <sha> (#PR) · GOAT 영역: `<slug>` (010 또는 20_cua_fork_delta 참조)

## 무엇이 다른가

upstream 변경과 GOAT 쪽 상태를 path:line 근거로 쓴다.

## 결정

import | adapt | reject | split 중 하나와 이유.

## 할 일

## 닫는 근거

머지 커밋, focused test, goat-ci run id. Cua 축은 포크 머지 커밋, 릴리스 태그, GOAT pin PR, OS별 live 확인.
```

Cua 축의 사이클 이름은 날짜가 아니라 대상 upstream 버전이다 (`20.NNN_cua_chase_cycle_0.38.0.md`).

닫을 때는 파일을 `_fin/<축>/`으로 옮기고, 헤더에 `Closed: YYYY-MM-DD <goat commit>`을 추가하고,
MOC 행을 `✅ _fin`으로 바꾼다. 카드 하나가 둘 이상의 결정을 품으면 split해서 새 번호를 받는다.
