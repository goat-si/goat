# 020 — 사이클 절차

한 사이클은 스캔, 분류, 머지, 해결, 검증, 랜딩, 기록 순서로 돈다. 사이클 이름은 스캔한 날짜의
`YYMMDD`이고, 카드 `10.NNN_t3_chase_cycle_<YYMMDD>.md` 하나가 그 사이클을 대표한다.

## 0. 준비 (checkout마다 한 번)

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git
git config remote.upstream.tagopt --no-tags # upstream nightly 태그가 수천 개다
```

## 1. 스캔

```bash
devlog/_chase/scan.sh --commits > /tmp/goat-chase-<YYMMDD>.txt
```

`upstream main`과 `origin`을 fetch한 뒤 기준선, trial merge 충돌 파일, 양쪽이 추가한 마이그레이션
id와 겹침, upstream workflow 변경, `goat_*` 짝이 없는 upstream `t3_*` 도구, upstream이 추가한 `t3_*`
줄, 커밋별 분류를 출력한다. 대상 브랜치는 마지막 인자로 바꾼다 (`scan.sh --no-fetch dev`). 출력
전문은 커밋하지 않고 사이클 카드에 요약한다.

## 2. 분류

`--commits` 출력의 upstream 커밋은 다음 중 하나 이상에 속한다.

| 분류      | 조건                    | 처리                                                             |
| --------- | ----------------------- | ---------------------------------------------------------------- |
| clean     | `shared=0 t3=0 conf=[]` | 카드 없이 머지로 흡수                                            |
| shared    | `shared>0`, `conf=[]`   | 겹친 파일의 [010](./010_fork_delta.md) 영역에서 의미 충돌만 확인 |
| conflict  | `conf=[...]`            | 010 정책으로 해결. 정책 밖이면 카드                              |
| rename    | `t3>0`                  | `goat_*`로 바꾸는 작업을 카드로 묶음                             |
| migration | 마이그레이션 id 겹침    | `⛔` 카드. 결정 전 머지 금지                                     |
| workflow  | upstream workflow 변경  | push 전에 goat-si/goat에서 비활성화                              |

## 3. 머지

```bash
UP=<스캔한 upstream SHA>
git switch -c chase/t3-<YYMMDD> origin/dev
git merge --no-ff "$UP" -m "chase(t3): merge upstream main $(git rev-parse --short "$UP")"
```

## 4. 해결

- 충돌 파일은 사이클 카드의 충돌 표에 적은 정책대로 푼다.
- 이름 누수: `git diff <merge-base> HEAD -- apps packages ':!*.md' | rg '^\+.*\bt3_[a-z]+_[a-z]'`의
  결과가 legacy alias나 legacy 렌더링 테스트가 아니면 `goat_*`로 바꾼다.
- 마이그레이션: `Migrations.ts`의 id가 중복 없이 단조 증가하고 결정 카드의 선택이 반영됐는지 본다.

## 5. 검증

- 로컬: 충돌 파일의 focused test (`vp test run <files>`)와 바뀐 패키지 typecheck.
- 정본: 머지 head에서 손으로 돌린 goat-ci 전체 실행(`gh workflow run goat-ci.yml --ref <branch>`)의 check, typecheck, test, build가 모두 green. cancelled는 pass가 아니다.

## 6. 랜딩

`chase/t3-<YYMMDD>`를 dev에 merge commit 또는 fast-forward로 넣는다. squash merge는 upstream parent를
잃어 merge-base가 전진하지 않으므로 쓰지 않는다.

## 7. 기록

- [000](./000_baseline.md): 새 reviewed-through(`git merge-base origin/dev upstream/main`)와 사이클 로그 행.
- 닫힌 카드는 `_fin/10/`으로 옮기고 MOC를 갱신한다.
- 새 GOAT 분기가 생겼으면 [010](./010_fork_delta.md)에 영역을 추가한다.
