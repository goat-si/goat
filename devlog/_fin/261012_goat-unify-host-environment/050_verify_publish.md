# 050 — 종단 재현, 문서, PR (wp5)

> 의존: wp1-wp4. 기준은 그 시점 브랜치 head.

## 임시 HOME 종단 재현

실제 `~/.goat`와 사용 중인 서버(3773, 3774)는 건드리지 않는다. 모든 서버는 `HOME=$T`와 `--base-dir`로 임시 디렉터리에서 띄우고, 띄운 PID만 기록해 끈다(AGENTS.md 규칙 1). 포트는 `ss`/`lsof`로 비어 있는 것을 골라 쓴다.

스크립트 `/tmp/goat-unify-e2e/run.sh`(작업 트리 밖, 커밋하지 않음):

1. **준비**: `T=/tmp/goat-unify-e2e/home`. 옛 데스크톱 홈 `$T/.goat/desktop`에 서버를 잠깐 띄워(`node apps/server/src/bin.ts serve --base-dir $T/.goat/desktop --port $P1`) 프로젝트 하나와 스레드 하나를 `goat project`/MCP로 만들고 끈다. `$T/.goat`에도 같은 방식으로 다른 프로젝트와 스레드를 만든다(같은 작업공간 경로의 프로젝트 하나 포함).
2. **런타임이 먼저**: SSH 런처가 띄운 것과 같은 모양의 런타임을 만든다. 040의 `buildRemoteLaunchScript`(fixture가 쓰는 node 러너 모드, `packages/ssh/src/tunnel.protocol.fixture.ts:388-403`)를 `HOME=$T sh -s -- <stateKey>`로 실행해 `$T/.goat/ssh-launch/<stateKey>/`에 `managed`, `pid`, `port`, `identity`가 생기고 그 명령줄로 `$T/.goat`를 서비스하는 서버가 뜨게 한다. 같은 홈으로 `serve`를 한 번 더 → 즉시 `A GOAT server is already running` 실패(010).
   2a. **손으로 띄운 서버는 내리지 않는다**: 별도 홈 `$T2/.goat`에 평범한 `serve`를 띄우고 그 홈으로 데스크톱 부트스트랩을 시작 → `reason: "unmanaged"` 기다림 로그, 그 서버는 살아 있다. 데스크톱 프로세스를 끄고 그 서버도 끈다.
3. **데스크톱이 이어받기**: 데스크톱 부트스트랩 JSON(`mode: "desktop"`, `t3Home: $T/.goat`, `takeoverIdleOwner: true`, `legacyUserdataDirs: ["$T/.goat/desktop/userdata"]`, 토큰과 포트)을 fd 3으로 넘겨 `node apps/server/src/bin.ts --bootstrap-fd 3` 실행. 런타임이 유휴라 내려가고, 데스크톱 서버가 뜨고, 옛 홈이 합쳐진다. 확인: `$T/.goat/userdata/server-runtime.json`의 pid가 데스크톱 서버, `$T/.goat/desktop/userdata/MERGED-INTO.json` 존재, `sqlite3`로 양쪽 프로젝트·스레드가 대상에 보이고 같은 경로 프로젝트가 하나다.
4. **세션 유지**: 2에서 런타임 CLI로 발급해 둔 mcp-client 세션(`auth session issue --base-dir $T/.goat --subject mcp-client ...`)으로 데스크톱 서버의 `/mcp`를 호출해 200을 받는다(U5).
5. **바쁜 런타임**: 2와 같은 방식(런처 스크립트)으로 런타임을 다시 띄우고 활동을 바쁨으로 만든 뒤(가짜 provider로 턴 시작, 또는 `/.well-known/t3/activity`를 busy로 답하는 테스트 서버) 데스크톱 부트스트랩 시작 → 기다림 로그, 런타임이 살아 있음. 바쁨이 끝나면 이어받는다.
6. **다시 실행**: 데스크톱 부트스트랩으로 한 번 더 시작 → 병합 `already-merged`, 행 수 그대로.
7. **런처 외부 재사용**: 040의 fixture 테스트가 실제 셸로 같은 판정을 돈다. 여기서는 `$T`의 데스크톱 서버 기록(`cliPath` 포함)을 대상으로 `buildRemoteRuntimeProbeScript`와 실행 스크립트를 `HOME=$T sh -s`로 돌려 `managed: external`과 `AUTH_CLI` 선택을 확인한다(SSH 연결 없이 스크립트만).
8. **정리**: 띄운 PID를 모두 끄고 `$T`를 지운다.

결과는 `evidence/e2e-<UTC>.md`에 명령과 출력 끝부분으로 남긴다.

## 문서

### MODIFY `docs/internals/remote.md` (SSH 단락 `:78-90` 뒤)

```md
### One server per data directory

A host has one GOAT data home, `~/.goat`, shared by the desktop app, the CLI, and servers that
SSH dispatch launches. Only one server may serve a `userdata` directory: two servers on one
database cancel each other's work at startup recovery and never see each other's events. The
server takes `<userdata>/server-owner.lock` before opening the database
([serverOwnerLock.ts](../../apps/server/src/serverOwnerLock.ts)). A desktop backend that finds an
SSH-launched server there waits until it is idle, stops it, and takes over. It stops only a server the SSH launcher
proved it launched; it never stops another desktop, a server someone started by hand, one
supervised by the background service, or a newer GOAT, and waits for them instead. The SSH launcher reuses any live server it did not launch when both protocol integers
match, and issues credentials with the CLI that server advertises in `server-runtime.json`, so a
client of another release never migrates that server's database.
```

### MODIFY `docs/user/remote-access.md` (`:167-170`, Desktop-managed SSH)

```diff
 server, launch state, and data on the host under `~/.goat`, apart from any T3
 Code install in `~/.t3`.
+If the GOAT app is open on that host, SSH work joins the app's server, so
+threads started from another computer show up for the person at that machine.
+When the app opens while such work is running, it waits for the work to finish
+and then takes over. If a newer GOAT or the GOAT background service is using
+that data, the app says so and waits until you update it or stop the service.
```

### MODIFY `docs/user/updating.md`

업데이트 후 첫 실행에서 옛 `~/.goat/desktop` 데이터가 `~/.goat`로 한 번 합쳐지고, 옛 폴더는 남는다는 한 문장. 직접 하려면 `goat userdata merge --from ~/.goat/desktop/userdata`. 사이클 P에서 그 파일의 적절한 절을 고른다.

## PR

- 브랜치 `goat/unify-host-environment`, 최신 `origin/dev`로 rebase.
- 변경 파일 lint, `vp fmt --check`, server·desktop·ssh·contracts typecheck, 사이클별 focused 테스트를 다시 돌린다.
- `gh pr create -R goat-si/goat --base dev`, 제목 `fix: one GOAT environment per host for the desktop app and SSH dispatch`, 본문: 문제 두 문장, 해결(U1-U7 요약), 검증(테스트 목록과 임시 HOME 재현), 남는 위험, `Fixes #1`, 모델과 하네스. UI 변경은 대기 화면 문구뿐이고 실제 데스크톱 실행은 허락 없이 하지 않으므로 스크린샷 대신 그 사실을 적는다.
- `link_pull_request`로 이 스레드에 연결. 머지하지 않는다.

## 기록

이 단위의 D에서 `devlog/_chase/010_fork_delta.md`에 영역 행을 추가한다: G15 "한 기기 한 홈" — `apps/desktop/src/app/DesktopStatePaths.ts`, `apps/server/src/serverOwnerLock.ts`, `apps/server/src/userdataMerge`, `packages/ssh/src/tunnel.ts`(외부 재사용), 충돌 정책 "upstream 데스크톱 홈 변경을 받되 GOAT는 `~/.goat` 하나를 유지, 소유 잠금과 병합은 GOAT 전용".
