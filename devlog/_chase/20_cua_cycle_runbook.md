# 20 — Cua Driver 사이클 절차

한 사이클은 스캔, 분류, split, 머지, 라이선스 확인, 호환성 검증, 후보 아티팩트, GOAT pin 검증, 릴리스, 기록 순서로 돈다.
대상은 upstream 릴리스 태그 `cua-driver-rs-v<version>` 하나다. 사이클 이름은 그 버전이고(`0.38.0`), 카드
`20.NNN_cua_chase_cycle_<version>.md` 하나가 사이클을 대표한다. 포크 쪽 요약은 포크의
[GOAT.md](https://github.com/goat-si/cua-driver/blob/main/GOAT.md) "Syncing upstream"이고, 이 문서는 그 단계에 명령,
멈출 조건, GOAT 쪽 단계를 더한다. 둘이 어긋나면 고쳐서 맞춘다.

규칙은 T3 축과 같은 이유로 정한다.

1. upstream은 `upstream` 브랜치를 fast-forward하고, `main`에는 merge commit으로만 들인다. 포크 PR도 squash가 아니라 merge
   commit으로 랜딩해야 `upstream`이 `main`의 조상으로 남는다. 받지 않을 변경은 머지한 뒤 별도 revert 커밋으로 빼고 카드에 적는다.
   급한 upstream 수정만 사이클 전에 cherry-pick하고, 다음 머지가 그것을 흡수한다.
2. 대상은 스캔한 upstream SHA로 고정한다.
3. 충돌과 의미 변경은 [20_cua_fork_delta](./20_cua_fork_delta.md)의 영역 정책으로 푼다. 정책 밖이거나 프로토콜, 라이선스,
   권한을 바꾸는 선택은 카드로 만들고 `⛔ needs decision`으로 둔다.
4. GOAT의 live 확인이 끝나기 전에 릴리스 태그를 자르지 않는다.

## 0. 준비 (한 번)

GOAT checkout 옆에 두 클론을 만든다. `/tmp`에 두지 않는다. 아래 블록은 세 checkout을 절대 경로 변수로만 가리키므로 어느
디렉터리에서 실행해도 같다. 새 셸에서는 이 변수 세 줄을 GOAT checkout 안에서 먼저 다시 실행한다.

```bash
GOAT=$(git rev-parse --show-toplevel)      # GOAT checkout 안에서 실행
FORK=$(cd "$GOAT/.." && pwd)/cua-driver
CUA_UPSTREAM=$(cd "$GOAT/.." && pwd)/trycua-cua
git clone https://github.com/goat-si/cua-driver.git "$FORK"
# monorepo는 약 650 MB다. blob 없이 받아도 split은 tree만 읽으므로 된다.
git clone --filter=blob:none --no-checkout --no-tags https://github.com/trycua/cua.git "$CUA_UPSTREAM"
```

## 1. 스캔

```bash
(cd "$GOAT" && devlog/_chase/scan.sh --cua)   # GOAT pin 선언, upstream·포크 최신 태그, 20 레지스트리 검사
VER=0.38.0                    # 대상 upstream 버전
git -C "$CUA_UPSTREAM" fetch --no-tags origin main "refs/tags/cua-driver-rs-v$VER:refs/tags/cua-driver-rs-v$VER"
UP=$(git -C "$CUA_UPSTREAM" rev-parse "cua-driver-rs-v$VER^{commit}")
RT=<20_cua_baseline의 reviewed-through trycua 커밋>
git -C "$CUA_UPSTREAM" log --oneline "$RT..$UP" -- libs/cua-driver
# split에 보이지 않는 파일: 루트 라이선스, vendor 원본, 빌드 workflow
git -C "$CUA_UPSTREAM" diff --stat "$RT" "$UP" -- LICENSE.md LICENSING.md TRADEMARKS.md THIRD_PARTY_NOTICES.md \
  libs/cua/Cargo.toml libs/cua/crates/cua-telemetry libs/cua/crates/cua-teleport/src/ux/targets.json \
  libs/images/sandbox-images.json '.github/workflows/*cua-driver*' '.github/workflows/*rust*'
# 보안·동작 검토의 출발점. 결과는 사람이 읽는다.
git -C "$CUA_UPSTREAM" log -p "$RT..$UP" -- libs/cua-driver | rg -n 'Command::new|https?://|reqwest|ureq|unsafe |entitlement|kTCC'
git -C "$CUA_UPSTREAM" diff "$RT" "$UP" -- libs/cua-driver/rust/Cargo.lock | rg '^\+name = '
```

출력 전문은 커밋하지 않고 사이클 카드에 요약한다.

## 2. 분류

| 분류     | 조건                                                                  | 처리                                                 |
| -------- | --------------------------------------------------------------------- | ---------------------------------------------------- |
| clean    | 아래 어디에도 해당 없음                                               | 카드 없이 머지로 흡수                                |
| delta    | 포크 delta 영역의 경로를 건드림                                       | 영역 정책으로 해결, 정책 밖이면 카드                 |
| security | 새 외부 프로세스, 네트워크, entitlement·TCC, `unsafe`·FFI, 텔레메트리 | 검토 결과를 카드에 적는다. 받지 않으면 revert와 카드 |
| protocol | `tools/list` 이름·스키마, 도구 결과, SDK와의 프로토콜                 | `protocol-compat` 규칙: `⛔` 카드와 GOAT 쪽 변경     |
| license  | 새 crate, 루트 라이선스 파일, 번들 런타임                             | 5번에서 확인, 고지 갱신                              |
| build    | upstream workflow, `rust-toolchain.toml`, vendor 원본, 아카이브 배치  | 포크 CI와 `vendor/`에 손으로 옮긴다                  |
| upstream | 포크 수정이 upstream에 들어옴                                         | upstream 쪽을 받고 포크 delta 영역을 줄인다          |

## 3. split

```bash
git -C "$FORK" fetch origin
OLD=$(git -C "$FORK" rev-parse origin/upstream)
OLD_UP=$RT
# 재현성: 이전 split을 다시 만들어 같은 SHA인지 본다. 다르면 git 버전이나 옵션이 바뀐 것이므로 멈추고 카드를 만든다.
test "$(git -C "$CUA_UPSTREAM" subtree split -q --prefix=libs/cua-driver "$OLD_UP" 2>/dev/null)" = "$OLD"
NEW=$(git -C "$CUA_UPSTREAM" subtree split -q --prefix=libs/cua-driver "$UP" 2>/dev/null)
git -C "$CUA_UPSTREAM" merge-base --is-ancestor "$OLD" "$NEW"   # 실패하면 멈춘다
git -C "$CUA_UPSTREAM" branch -f "split-$VER" "$NEW"
# git 2.45부터 upload-pack은 partial clone에서 빠진 blob을 가져오지 않는다. 이 한 번은 허용한다.
GIT_NO_LAZY_FETCH=0 git -C "$FORK" fetch "$CUA_UPSTREAM" "split-$VER"
test "$(git -C "$FORK" rev-parse FETCH_HEAD)" = "$NEW"
git -C "$FORK" push origin "$NEW:refs/heads/upstream"   # force 없이. 거부되면 멈춘다
git -C "$FORK" tag "upstream-v$VER" "$NEW"
git -C "$FORK" push origin "upstream-v$VER"
```

split 한 번은 약 1분 걸린다 (2026-10-25, 0.37.0에서 1180 경로 커밋). `2>/dev/null`은 진행 표시를 지운다.

## 4. 머지

```bash
cd "$FORK"
git switch -c "chase/cua-$VER" origin/main
git merge --no-ff "$NEW" -m "chase(cua): merge upstream cua-driver-rs v$VER (trycua/cua ${UP:0:10})"
```

- 충돌은 [20_cua_fork_delta](./20_cua_fork_delta.md)의 영역 정책대로 푼다.
- `vendor/`를 포크 `vendor/README.md`의 명령으로 `REV=$UP`에서 다시 가져오고, `cua-telemetry/Cargo.toml`의 workspace 값을 같은
  커밋의 `libs/cua/Cargo.toml`에서 다시 쓰고, `vendor/README.md`의 원본 커밋을 고친다.
- 포크 delta의 "깨끗하게 머지되고도 깨지는 것"을 확인한다.
- 포크 `main`으로 PR을 열고 merge commit으로 랜딩한다. 랜딩한 `main` 커밋이 `RELEASE_SHA`다.

## 5. 라이선스와 고지

```bash
cd "$FORK/rust"
cargo deny check licenses advisories bans sources   # deny 설정은 #1589/#1590이 포크에 둔다. 그전에는 사이클을 릴리스까지 끌고 가지 않는다
git -C "$FORK" diff "$OLD" "$NEW" -- rust/Cargo.lock | rg '^\+name = '   # 새 crate는 고지에 반영
```

- 1번의 루트 `LICENSE.md`·`LICENSING.md`·`TRADEMARKS.md`·`THIRD_PARTY_NOTICES.md` 변경을 읽는다. `LICENSE.md`가 바뀌었으면 포크
  `LICENSE.md`를 같은 바이트로 맞춘다.
- 포크 빌드가 고지를 다시 생성하고(#1589), 결과를 GOAT `apps/desktop/src/cua/notices/`와 비교한다.
- 후보 아카이브의 파일 목록을 `requiredFiles`(`packages/shared/src/cuaDriverRelease.ts:66-79`)와 비교하고, 번들 런타임(ORT, Node
  runtime)과 그 라이선스를 확인한다. split에는 `rust/crates/cua-perception`과 모델 고지가 들어 있다. perception 모델은 싣지 않는다
  ([computer-use.md](../../docs/internals/computer-use.md) Licensing and provenance).

## 6. 호환성과 CI

- 포크 PR CI가 모든 플랫폼을 빌드하고 `protocol-compat` 게이트를 돈다 (#1590). 게이트가 생기기 전에는 릴리스하지 않는다.
- 스냅샷은 다시 생성하지 않는다. 게이트가 실패하면 변경을 카드로 올린다 (포크 delta `protocol-compat`).
- 로컬은 `rust/`에서 `cargo test --locked`. upstream `contract/`·`compat-fixtures/` 테스트는 참고이고 게이트를 대신하지 않는다.

## 7. 후보 아티팩트

`RELEASE_SHA`에서 포크 CI가 만든 아카이브, `SHA256SUMS`, SDK를 내려받아 검증한다. artifact 이름과 배치는 #1590이 정한다.
`gh run download`는 artifact마다 하위 폴더를 만들므로 아래는 `$CAND/<artifact>/` 아래의 파일을 찾는다.

```bash
CAND="../cua-candidates-$VER"
gh run download <run-id> -R goat-si/cua-driver -D "$CAND"
SUMS=$(find "$CAND" -name SHA256SUMS)   # 하나여야 한다
find "$CAND" -type f \( -name 'cua-driver-rs-*.tar.gz' -o -name 'cua-driver-rs-*.zip' \) | while read -r a; do
  want=$(awk -v n="$(basename "$a")" '$2 == n || $2 == "*" n { print $1 }' "$SUMS")
  have=$(shasum -a 256 "$a" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$have" ] || { echo "SHA256SUMS mismatch: $a"; exit 1; }
  gh attestation verify "$a" --repo goat-si/cua-driver \
    --signer-workflow goat-si/cua-driver/.github/workflows/<build workflow> \
    --source-digest "$RELEASE_SHA" --source-ref refs/heads/main || exit 1
done
```

아카이브 다섯 개(`cuaDriverRelease.ts:11-37`의 플랫폼마다 하나)가 모두 통과해야 한다. 하나라도 어긋나면 멈춘다. 크기는 8번에서 pin과 함께 확인된다.

## 8. GOAT pin 검증 (후보로)

GOAT dev에서 브랜치를 만든다: `cd "$GOAT" && node scripts/worktree-add.ts "$GOAT/../goat-cua-pin-$VER" -b chase/cua-pin-$VER origin/dev`. 이 절의 나머지 명령과 9번의 GOAT 쪽 단계는 그 새 worktree(`cd "$GOAT/../goat-cua-pin-$VER"`)에서 실행한다.

- 후보 바이트로 pin을 바꾼다: `cuaDriverRelease.ts`의 버전(`:3`), 아카이브 이름·바이트·SHA-256(`:11-37`), 필요하면
  `requiredFiles`(`:66-79`)와 텔레메트리 환경 변수(`:85-91`), SDK catalog(`pnpm-workspace.yaml:58`),
  `third-party-licenses.config.json`의 `Cua Driver` 버전·`sourceUrl`, `apps/desktop/src/cua/notices/`. 위치는
  [20_cua_baseline](./20_cua_baseline.md)의 표.
- SDK 후보는 [20.001](./20.001_cua_chase_fork_bootstrap.md)에서 정한 포크 SDK 게시 방식으로 설치한다. 그 결정 전에는 pin을 바꾸지 않는다.
- URL(`:64`)은 아직 릴리스가 없으므로 그대로 둔다. macOS와 Windows helper 빌드는 pin으로 검증한
  `node_modules/.cache/goat/cua-driver/<archiveName>`을 먼저 쓰므로 후보 아카이브를 그 이름으로 둔다
  (`scripts/build-computer-use-helper.ts:259-284`, `scripts/build-computer-use-helper-windows.ts:172-195`). Linux는
  `--driver-archive <file>`을 받는다 (`scripts/build-computer-use-helper-linux.ts:44`).
- `vp i`, `vp run check:changed`, `(cd scripts && vp test run build-computer-use-helper.test.ts build-computer-use-helper-windows.test.ts desktop-artifact-computer-use.test.ts)`.
- macOS: 로그인한 사용자의 Terminal에서 `node scripts/build-computer-use-helper.ts --channel dev` (Developer ID, keychain 필요;
  [development.md](../../docs/operations/development.md#macos-computer-use-helper)). 서명은 안에서 밖으로: `cua-driver`와
  `cua-cursor-theme`, helper, GOAT.app. `--notary-profile <profile>`이면 helper를 notarize하고 staple한다. 서명한 데스크톱 패키지는
  `scripts/build-desktop-artifact.ts:4710`에서 `verifyEmbeddedComputerUseHelper`(`scripts/desktop-artifact-computer-use.ts:303`)가 내장
  helper의 code hash와 team을 확인한다. helper bundle id와 Developer ID는 바꾸지 않는다: TCC 권한이 그 designated requirement에 붙어 있다.
- Windows: Windows에서 `node scripts/build-computer-use-helper-windows.ts --channel dev`. stable·nightly는 `--sign-thumbprint`로
  서명하고, helper는 빌드 때의 드라이버 파일 SHA-256만 실행한다. SignPath와 #1228 경로는 건드리지 않는다.
- Linux: `node scripts/build-computer-use-helper-linux.ts --driver-archive <candidate>`, 그다음
  `node scripts/computer-use-linux-smoke.ts --helper apps/server/.computer-use-helper-linux/goat-computer-use --evidence <dir>`.
- 준비 상태: 권한을 준 Mac에서 다시 빌드한 helper의 권한 probe가 Accessibility·Screen Recording 모두 true인지, 준비 상태의 네
  답(OS 권한, 인증된 helper, 실제 캡처와 트리, 이번 턴 도구)이 모두 ready인지 본다. 그다음 OS마다 `@computer` live 턴 하나를 후보
  드라이버로 돌린다. release workflow는 바꾸지 않는다.

## 9. 릴리스와 pin 확정

```bash
N=<이 upstream 버전의 다음 번호>
git -C "$FORK" tag "cua-driver-rs-v$VER-goat.$N" "$RELEASE_SHA"
git -C "$FORK" push origin "cua-driver-rs-v$VER-goat.$N"
```

- 릴리스는 7번 후보와 같은 바이트를 올린다. 올라간 자산의 크기와 SHA-256이 후보와 같은지 확인한다. 다시 빌드해 바이트가
  달라졌다면 pin을 바꾸고 7-8번을 다시 한다.
- GOAT 브랜치에서 URL(`cuaDriverRelease.ts:64`)을 포크 릴리스로 바꾸고, 캐시 없이 helper 빌드 하나가 다운로드와 검증을 통과하는지
  본다. `vp run check:changed` 뒤 dev로 PR을 연다 (AGENTS.md "Pull requests").

## 10. 기록

- [20_cua_baseline](./20_cua_baseline.md): 새 reviewed-through(포크 `upstream` tip과 trycua 커밋), 포크 `main`, GOAT pin, 사이클 로그 행.
- 포크 delta에서 upstream이 받은 영역을 줄이거나 지우고, 새 GOAT 변경을 영역으로 더한다.
- 포크 수정 가운데 GOAT 전용이 아닌 것은 trycua/cua PR 링크를 영역에 적는다.
- 닫힌 카드는 `_fin/20/`으로 옮기고 [MOC](./20_cua_chase_MOC.md)를 갱신한다.
- 임시 클론(`../cua-candidates-*`)과 worktree는 랜딩 뒤 지운다.
