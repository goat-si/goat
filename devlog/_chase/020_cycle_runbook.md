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
devlog/_chase/scan.sh --commits --names > /tmp/goat-chase-<YYMMDD>.txt
```

`upstream main`과 `origin`을 fetch한 뒤 기준선, trial merge 충돌 파일, 양쪽이 추가한 마이그레이션
id와 겹침, upstream workflow 변경, `goat_*` 짝이 없는 upstream `t3_*` 도구, upstream이 추가한 `t3_*`
줄, 커밋별 분류를 출력한다. 대상 브랜치는 마지막 인자로 바꾼다 (`scan.sh --no-fetch dev`). 출력
전문은 커밋하지 않고 사이클 카드에 요약한다. `--names`는 임시 detached worktree의 upstream tip에 현재
rename 규칙을 적용한 뒤 `--check`로 규칙 밖 이름의 총수와 앞부분을 출력하고 worktree를 제거한다.
기본 스캔은 이 전처리를 하지 않는다. 전체 upstream 트리를 검사하므로 이전 사이클부터 남은 이름도 보인다.

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

upstream과 GOAT는 T3↔GOAT 이름이 달라 그대로 머지하면 이름 차이가 충돌로 나온다. 머지 전에 양쪽 upstream 트리에
같은 이름 규칙을 적용하고(rename 전처리), 그 둘과 dev를 3-way 머지한다.
1번의 `scan.sh --names`가 보고한 규칙 밖 이름을 먼저 분류한다. upstream 전처리 결과에 남은 이름은
머지 결과에서 처리해야 하며, CI의 `goat-scope` 이름 검사는 최종 GOAT 트리에서 exit 0이어야 한다.

```bash
UP=<스캔한 upstream SHA>
BASE=$(git merge-base origin/dev "$UP")
git switch -c chase/t3-<YYMMDD> origin/dev
for side in base:"$BASE" up:"$UP"; do
  name=${side%%:*}; sha=${side#*:}
  GOAT_WORKTREE_SETUP=0 git -c core.hooksPath=/dev/null worktree add --detach "../chase-rename-$name" "$sha"
  node scripts/goat-rename.ts --apply --root "../chase-rename-$name"
  git -c core.hooksPath=/dev/null -C "../chase-rename-$name" commit --no-verify -qam "chore(rename): [script] upstream $name $(git rev-parse --short "$sha")"
done
node scripts/goat-rename.ts --check --root ../chase-rename-up --limit 100000 > /tmp/goat-chase-<YYMMDD>-names.txt
git merge-recursive "$(git -C ../chase-rename-base rev-parse HEAD)" -- HEAD "$(git -C ../chase-rename-up rev-parse HEAD)"
# 충돌을 4번대로 푼 뒤, 해결된 트리에 부모 HEAD와 upstream SHA를 단 진짜 merge commit을 남긴다.
git add -A -- . ':!.goat' ':!.t3'
MERGED=$(git commit-tree "$(git write-tree)" -p HEAD -p "$UP" -m "chase(t3): merge upstream main $(git rev-parse --short "$UP")")
git reset -q --soft "$MERGED"
```

`--check --root ../chase-rename-up`의 출력은 규칙이 아직 모르는 upstream의 새 T3 이름이다. 사이클 카드에 요약한다. 규칙 밖에서 손으로
고친 줄(보이는 문구의 일회성 수정 등)을 upstream이 다시 건드리면 이 목록에 다시 나온다. 임시 worktree는 랜딩 뒤 지운다.

## 4. 해결

- 충돌 파일은 사이클 카드의 충돌 표에 적은 정책대로 푼다.
- 이름 누수: `git diff <merge-base> HEAD -- apps packages ':!*.md' | rg '^\+.*\bt3_[a-z]+_[a-z]'`의
  결과가 legacy alias나 legacy 렌더링 테스트가 아니면 `goat_*`로 바꾼다.
- 이름 정리: `node scripts/goat-rename.ts --apply`(멱등)를 다시 돌리고 `--check`가 0줄이 될 때까지 남은 T3 이름을 처리한다.
  반복될 이름이면 `scripts/lib/goat-rename/rules-*.ts`에 규칙을 더하고, 한 번뿐인 줄은 손으로 고친다. 남겨야 하는 이름은
  이유를 적은 KEEP 규칙이나 `goat-rename: legacy` 표시로 남긴다. 저장되거나 다른 버전이 읽는 이름(저장 키, wire id, env)은
  `packages/contracts/src/legacyT3Names.ts`에 옛 이름을 두고 둘 다 읽게 한다.
- 마이그레이션: `Migrations.ts`의 id가 중복 없이 단조 증가하고 결정 카드의 선택이 반영됐는지 본다.
- Node 고정: 루트 `package.json` `engines.node`는 GOAT의 정확한 버전을 유지한다. upstream이 Node를 올리면 사이클 카드에 적고
  올릴지 정한다. 올릴 때는 그 값만 바꾸고 SEA·워크플로에 버전 사본을 다시 만들지 않는다. 서버 `apps/server/package.json` `engines.node`와
  `packages/shared/src/nodeSqliteClient.ts`의 `NODE_SQLITE_RUNTIME_RANGE`는 GOAT 값 `^24.16.0 || >=26.1.0`를 유지한다
  ([010 `node-pin`](./010_fork_delta.md)). 데스크톱 Electron이 Node를 바꾸면 그 버전이 서버 범위 안인지 확인한다.

## 5. 검증

- 로컬: 루트 `engines.node`의 Node로 돌린다 (`vp env exec node -v`). 시스템 Node가 다르면 `node:sqlite` 검사가 서버 테스트를 멈춘다.
  충돌 파일의 focused test (`vp test run <files>`)와 바뀐 패키지 typecheck. `node scripts/goat-rename.ts --check`가 exit 0.
  chase PR은 `--admin`으로 랜딩하므로 CI의 이름 검사에만 기대지 않는다. `vp run check:changed`도
  변경 파일 선택과 무관하게 같은 이름 검사를 실행한다.
- 정본: 머지 head에서 손으로 돌린 goat-ci 전체 실행(`gh workflow run goat-ci.yml --ref <branch>`)의 이름 검사(`goat-scope`), check, typecheck, test, build와 `goat-ci-result`가 모두 green. cancelled는 pass가 아니다.

## 6. 랜딩

`chase/t3-<YYMMDD>`를 dev에 merge commit 또는 fast-forward로 넣는다. squash merge는 upstream parent를
잃어 merge-base가 전진하지 않으므로 쓰지 않는다.

## 7. 기록

- [000](./000_baseline.md): 새 reviewed-through(`git merge-base origin/dev upstream/main`)와 사이클 로그 행.
- 닫힌 카드는 `_fin/10/`으로 옮기고 MOC를 갱신한다.
- 새 GOAT 분기가 생겼으면 [010](./010_fork_delta.md)에 영역을 추가한다.
