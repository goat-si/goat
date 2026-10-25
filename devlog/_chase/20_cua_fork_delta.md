# 20 — Cua Driver 포크 delta 레지스트리

> 기준: 포크 `main` `ec339be454a5` (2026-10-25). 대부분의 영역은 아직 계획이다.

포크 `main`이 upstream split과 다른 곳, 그 이유, upstream 머지에서 충돌하거나 의미가 깨질 때의 정책을 영역별로 적는다.
T3 축의 [010](./010_fork_delta.md)과 같은 형식이지만 따로 둔다. 여기 적는 커밋은 goat-si/cua-driver에 있어서
`origin/dev`에서 닿지 않으므로 010의 해시 검사를 받을 수 없다.

## 원칙

Cua Driver에 문제가 있으면 GOAT 쪽에서 우회하지 않는다. 포크에서 고치고, GOAT 전용이 아닌 수정은 같은 내용을
trycua/cua `main`에 별도 PR로 보내며, 드라이버 문제는 upstream에 issue로 올린다 (Jun, 2026-10-25, #1595 댓글). 그래서
영역마다 upstream issue나 PR을 적고, upstream이 같은 수정을 받으면 다음 사이클에서 upstream 쪽을 받고 그 영역을 줄이거나
지운다. 남는 영역은 GOAT 전용인 것뿐이어야 한다.

## 영역 규칙

- 블록은 ``### `slug` 제목``이고 슬러그의 알파벳 순서로 둔다. 이유는 010과 같다.
- `- 변경:` 줄에 포크 PR(`goat-si/cua-driver#N`), 포크 커밋(`goat-si/cua-driver@<sha>`), GOAT issue(`#N`)를 적는다.
  `- 커밋:` 줄은 쓰지 않는다. 그 이름은 010에서 dev 도달 검사를 받는다.
- `- 상태:`는 `계획`, `진행`, `적용`, `upstream 반영` 중 하나다. upstream이 받아 영역이 비면 블록을 지우고 사이클 카드에 적는다.
- `devlog/_chase/scan.sh --cua`가 슬러그 중복, 형식, 순서를 검사한다.

### `attribution` 라이선스, 고지, 상표

- 변경: goat-si/cua-driver@64ba7cd62620 (`LICENSE.md`), goat-si/cua-driver#1 (README 첫 줄), #1589
- 경로: `LICENSE.md`, `README.md`, `GOAT.md`, 빌드가 만드는 고지 파일
- upstream: 해당 없음 (GOAT 전용)
- 상태: 진행. `LICENSE.md`는 적용, README 고지는 PR, 고지 생성은 #1589
- 정책: subtree split은 monorepo 루트의 `LICENSE.md`, `LICENSING.md`, `TRADEMARKS.md`, `THIRD_PARTY_NOTICES.md`를 버린다. 포크는 루트
  `LICENSE.md`를 바이트 그대로 싣고 upstream 저작권 표기를 바꾸지 않는다. 사이클마다 이 네 파일의 upstream 변경을 손으로
  확인한다. 고지는 포크 빌드가 드라이버 crate와 함께 싣는 런타임(ORT, Node runtime)에서 생성하고, GOAT의
  `apps/desktop/src/cua/notices/`와 `third-party-licenses.config.json`은 그 출력에서 온다 (#1591). 포크는 공식 Cua로 보이지
  않는다: README 고지, Cua 로고 없음, GOAT UI는 "Cua"라고 하지 않는다. upstream README 변경은 받고 첫 줄 고지만 다시 얹는다.

### `ci-release` 포크 CI와 릴리스

- 변경: #1590
- 경로: `.github/workflows/` (포크 전용), 릴리스 아카이브
- upstream: 해당 없음 (upstream workflow는 monorepo 루트에 있어 split에 없다)
- 상태: 계획
- 정책: 포크 CI가 darwin universal(arm64·x86_64 lipo), linux x64·arm64, windows x64·arm64를 빌드하고, 아카이브 이름과 배치를
  `packages/shared/src/cuaDriverRelease.ts:11-37`의 이름과 `:66-79` `requiredFiles`에 맞추며, SHA-256과 GitHub build provenance
  attestation을 붙이고, `cargo deny`와 프로토콜 호환성 테스트를 돈다. 서명 비밀은 포크에 두지 않는다: macOS Developer ID 서명은
  GOAT helper 빌드가, Windows 서명은 #1228 경로가 맡는다. upstream의 `cd-rust-cua-driver.yml`과 `ci-rust-*`·`*cua-driver*` workflow는
  사이클마다 diff를 보고 빌드에 영향을 주는 변경(빌드 플래그, toolchain, 아카이브 배치, 새 필수 파일)만 손으로 옮긴다.

### `engine-patches` 드라이버 엔진 패치

- 변경: 없음. 목록은 [computer-use.md](../../docs/internals/computer-use.md)의 Engine patches
- 경로: `rust/crates/` 아래 해당 crate
- upstream: 각 PR마다 trycua/cua PR
- 상태: 계획
- 정책: 묶은 접근성 속성 읽기와 prefetch pool, 입력 취소와 눌린 입력 해제, Unix의 panic 격리와 host pid 감시, 접근성 알림 기반 settle
  대기·텍스트 범위 선택·`setValue` append, 넓힌 keymap은 패치 파일이 아니라 포크 PR 하나씩으로 들어간다. synara(MIT)에서 온 코드는
  PR과 고지에 출처와 저작권을 남긴다. 0.37 이후 upstream에 이미 있는 것은 다시 넣지 않고, 드라이버 설정이 있으면 그것을 쓴다
  (`CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS`, `CUA_DRIVER_KEY_GAP_MS`). 와이어에 보이는 추가는 `protocol-compat`을 따른다.

### `parent-death` 부모가 죽으면 드라이버도 끝난다

- 변경: #1592
- 경로: 드라이버 시작 경로와 플랫폼 crate
- upstream: 포크 PR이 생기면 같은 수정을 trycua/cua에 PR
- 상태: 계획
- 정책: macOS는 시작 때 받은 부모 pid에 kqueue `EVFILT_PROC`/`NOTE_EXIT`, `mcp` 모드의 stdin EOF 종료. Linux는
  `prctl(PR_SET_PDEATHSIG)`와 부모 pid 재확인. Windows는 helper가 건 kill-on-close Job Object 안에 있는지 확인. 드라이버를 자기
  process group에 두어 커서 테마·UIA worker 같은 자식도 함께 끝낸다. GOAT helper의 정리(#1364, #1508)는 그대로 두는 이중
  방어다. upstream이 같은 보장을 넣으면 upstream 쪽을 받고 이 영역을 지운다.

### `privacy-defaults` 텔레메트리와 업데이트 확인

- 변경: 없음 (포크는 기본값을 바꾸지 않았다)
- 경로: `rust/crates/cua-driver/Cargo.toml:37`, `vendor/cua/crates/cua-telemetry/`
- upstream: 해당 없음
- 상태: 적용 (GOAT 쪽 설정으로)
- 정책: upstream 0.37.0부터 드라이버는 `cua-telemetry`를 `default-features = false`로 링크해 HTTP 전송 코드가 빠지고, 이벤트는
  로컬에서만 기록된다. 기본으로 켜진 텔레메트리 설정과 GitHub 업데이트 확인은 GOAT가 환경 변수로 끈다
  (`cuaDriverRelease.ts:85-91`, `:140-148`, [ADR-0022](../../structure/decisions/ADR-0022-cua-driver-computer-use.md)). 사이클마다
  `default-features = false` 줄이 남았는지, 새 전송 경로나 endpoint가 없는지, 그 환경 변수 이름이 그대로인지 확인한다. 이름이
  바뀌면 같은 pin bump에서 `cuaDriverRelease.ts`를 고친다. 포크에서 기본값 자체를 끌지는 [20.001](./20.001_cua_chase_fork_bootstrap.md)의 결정이다.

### `protocol-compat` 0.37.0 프로토콜 표면

- 변경: #1590 (테스트), #1593 (지연 측정)
- 경로: 포크의 호환성 스냅샷과 테스트 (#1590이 정한다)
- upstream: 해당 없음
- 상태: 계획. 게이트가 생기기 전에는 포크 릴리스를 자르지 않는다
- 정책: GOAT helper(macOS·Windows·Linux), lease proxy(`apps/server/src/cua/ComputerUseLeaseProxy.ts`), Codex·Claude MCP 클라이언트, SDK가
  0.37.0의 `tools/list` 이름·입력 스키마와 fixture 앱 결과에 기댄다. 스냅샷은 0.37.0에서 한 번 만들고 출처(원본 커밋, 생성 명령,
  fixture 앱 버전)를 함께 남기며, 자동으로 다시 생성하지 않는다. 도구 이름, 스키마, golden 결과가 바뀌면 추가만 있어도
  `20.NNN` 카드로 명시적 승인을 받고, GOAT 쪽 변경을 같은 pin bump에 싣는다. upstream의 `contract/`·`compat-fixtures/` 테스트는
  upstream 자신의 계약 검사이고 GOAT 게이트를 대신하지 않는다. 지연(#1593)은 먼저 측정하고, 고칠 때도 0.37.0 와이어 프로토콜과
  기본값을 유지한다.

### `screencapture-fallback` macOS 창 캡처 대체 경로

- 변경: #1588, #1600 (GOAT 쪽 우회, 머지하지 않음)
- 경로: `rust/crates/platform-macos/src/capture.rs:245-249`, `:769-782` (0.37.0)
- upstream: trycua/cua#5938
- 상태: 계획
- 정책: ScreenCaptureKit 창 캡처가 실패하면 드라이버가 `screencapture`를 `PATH`에서 이름으로 실행하고, 오디오 권한을 가진 그
  Apple 도구 때문에 helper 이름으로 마이크 권한 창이 뜰 수 있다. 포크에서 절대 경로로 실행하거나 대체 경로를 끄는 옵션을 넣고
  같은 수정을 upstream PR로 보낸다. 수정이 GOAT pin에 들어오면 #1600을 닫는다. upstream이 자기 수정을 내면 그것을 받는다.

### `standalone-build` monorepo 밖 의존성 vendoring

- 변경: goat-si/cua-driver@64ba7cd62620
- 경로: `vendor/`, `rust/crates/cua-driver/Cargo.toml`, `.gitignore`
- upstream: 해당 없음 (monorepo 구조 때문)
- 상태: 적용
- 정책: `cua-driver` crate는 monorepo의 `libs/cua/crates/cua-telemetry`에 기대고, 그 crate는 `libs/cua/crates/cua-teleport/src/ux/targets.json`과
  `libs/images/sandbox-images.json`을 포함한다. split이 셋을 버리므로 포크가 `vendor/` 아래 같은 배치로 싣고, `cua-telemetry/Cargo.toml`의
  workspace 값은 같은 커밋의 `libs/cua/Cargo.toml`에서 풀어 쓴다. 사이클마다 split한 upstream 커밋에서 다시 가져온다(포크
  `vendor/README.md`). `Cargo.lock`은 vendoring으로 바뀌지 않아야 한다.

### `versioning-sdk` 버전과 SDK

- 변경: #1590
- 경로: 릴리스 태그, `typescript/` (SDK와 Node runtime)
- upstream: 해당 없음
- 상태: 계획
- 정책: 릴리스 태그는 `cua-driver-rs-v<upstream version>-goat.<N>`다. upstream 버전을 올리면 N을 새로 센다. SDK와 실행 파일은
  비공개 프로토콜을 공유하므로 같은 커밋에서 빌드하고 함께 낸다. GOAT가 지금 쓰는 npm `@trycua/cua-driver`는 0.37.0에서 멈췄다.
  포크 SDK의 패키지 이름과 게시처는 #1590에서 정하고 [20.001](./20.001_cua_chase_fork_bootstrap.md)에 적는다.

## 깨끗하게 머지되고도 깨지는 것

다음은 `upstream`을 `main`에 텍스트 충돌 없이 머지해도 확인한다.

- **프로토콜 표면.** `tools/list` 이름·스키마나 도구 결과가 바뀌면 `protocol-compat`의 카드 규칙.
- **새 외부 프로세스, 네트워크, 권한.** 새 `Command::new`, 새 endpoint, 새 entitlement·TCC 서비스, 새 `unsafe`·FFI. #1588 같은
  문제가 여기서 들어온다.
- **새 crate의 라이선스.** `Cargo.lock`에 새로 들어온 패키지를 `cargo deny`가 통과시켜도 고지에 반영한다.
- **split 밖 파일.** monorepo 루트의 라이선스 파일과 workflow, `vendor/`의 원본(`libs/cua/crates/cua-telemetry`,
  `libs/cua/Cargo.toml`, `targets.json`, `sandbox-images.json`). split diff에는 보이지 않는다.
- **toolchain과 텔레메트리 feature.** `rust/rust-toolchain.toml`과 `cua-driver/Cargo.toml`의 `default-features = false`.
