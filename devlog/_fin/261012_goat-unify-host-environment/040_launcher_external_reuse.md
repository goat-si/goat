# 040 — SSH 런처가 그 기기의 데스크톱 서버에 붙는다 (wp4)

> 결정 U6, U7 ([000_plan.md](./000_plan.md)). 의존: 010. 기준 origin/dev `390b9fd42`. **이 사이클 P에서 `goat/release-nightly`가 dev에 들어왔는지 먼저 확인한다.** 들어왔으면 그 위로 rebase하고 아래 앵커를 다시 잡는다(그 브랜치는 `tunnel.ts` 프로브와 실행 스크립트를 크게 옮긴다).

## 목표

030 이후 데스크톱과 런타임은 같은 `~/.goat/userdata/server-runtime.json`을 쓰므로 런처는 이미 데스크톱 서버를 찾는다. 남은 두 가지를 고친다.

1. 자기가 띄우지 않은(외부) 살아 있는 서버를 SSH·오케스트레이션 프로토콜 정수가 같으면 버전과 설치된 바이너리에 관계없이 재사용한다. 외부 서버는 교체하지 않는다.
2. 외부 서버에 페어링과 mcp-client 세션을 발급할 때 그 서버와 **버전이 같다고 확인한** CLI만 쓴다. 우선 서버가 `server-runtime.json`에 적은 `cliPath`, 그다음 이 클라이언트가 선택한 런타임 러너. 어느 것도 서버 버전과 같지 않으면 DB를 열지 않고 오류로 끝낸다(리뷰 01a12ca1 블로커 5).

소유 런타임(`LIVE_OWNED=1`)의 선택, 교체, 새로 고침, 레거시 인수 분기는 바꾸지 않는다(release-nightly 몫).

## 변경

### MODIFY `apps/server/src/serverRuntimeState.ts:14-79`

```diff
   serviceManaged: Schema.optional(Schema.Boolean),
+  /**
+   * A goat CLI of this server's own version (the desktop's launcher shim or the
+   * standalone binary). SSH dispatch issues credentials with it so a newer or
+   * older runtime never opens this server's database.
+   */
+  cliPath: Schema.optionalKey(Schema.String),
 });
```

`makePersistedServerRuntimeState` 입력에 `cliPath?: string`. `server.ts:776-786`에서 `apps/server/src/cli/invocation.ts:160-169`의 `resolveInstallLauncher`(export 추가)로 값을 얻어 넘긴다. 저장소 체크아웃 실행(`Option.none`)이면 넣지 않는다.

### MODIFY `packages/ssh/src/tunnel.ts` 프로브 (`:1598-1692`, `:1756-1800`)

셸: 지금은 `live_binary`가 없으면 `liveBinarySignals`를 빼고, TS가 그것을 요구한다. 셸은 그대로 두고 TS 판정을 나눈다.

```diff
     const liveCompatible =
       probe.liveVersion !== undefined &&
       ...
       matchesSignals(probe.liveBinarySignals, version);
+    // A server this target did not launch (the host's desktop app, a service) is
+    // reused when its protocols match, whatever its release. It is never replaced.
+    const externalCompatible =
+      probe.liveStatus === "live" &&
+      probe.liveOwned !== true &&
+      probe.liveVersion !== undefined &&
+      probe.liveSignals !== undefined &&
+      probe.liveSignals.serverVersion === probe.liveVersion &&
+      matchesSignals(probe.liveSignals, version);
     const retainedCompatible =
-      probe.liveStatus === "none" &&
+      (probe.liveStatus === "none" || externalCompatible) &&
       probe.retained === "ready" &&
```

`selectedVersion` 계산은 그대로다. 외부 서버를 재사용할 때도 선택 버전은 이 클라이언트가 쓸 런타임 바이너리(보존 러너 또는 요청 버전)이고, 그 바이너리는 `__ssh-helper` 조회에만 쓴다. `liveCompatible && liveOwned !== true`인 경우(외부 서버의 버전 바이너리가 우연히 설치된 경우)도 같은 외부 재사용 경로로 간다.

### MODIFY `packages/ssh/src/tunnel.ts` `REMOTE_PROTOCOL_GUARD_SCRIPT` `check_live_protocol` (`:727-746`)

```diff
-    if [ "$LIVE_STATUS" = live ] && compatible_fields "$2" "$3" "$4" &&
-       { [ -z "$SELECTED_VERSION" ] || [ "$2" = "$SELECTED_VERSION" ] ||
-         { [ "$REFRESH_IF_IDLE" = 1 ] && [ "$2" = "$REFRESH_LIVE_VERSION" ]; }; }; then LIVE_COMPATIBLE=1; fi
+    if [ "$LIVE_STATUS" = live ] && compatible_fields "$2" "$3" "$4" &&
+       { [ "$LIVE_OWNED" != 1 ] || [ -z "$SELECTED_VERSION" ] || [ "$2" = "$SELECTED_VERSION" ] ||
+         { [ "$REFRESH_IF_IDLE" = 1 ] && [ "$2" = "$REFRESH_LIVE_VERSION" ]; }; }; then LIVE_COMPATIBLE=1; fi
```

외부 서버는 `compatible_fields`(정수 두 개 일치, 또는 신호 없는 정확한 버전)만 통과하면 된다. `reuse_live_server`(`:1154-1171`)는 이미 소유가 아니면 `REMOTE_MANAGED=external`로 표시하고 PID·identity 파일을 지운다. 그대로 쓴다.

같은 블록에 함수 추가:

```sh
# A CLI of the live server's exact release, so credentials never open its
# database with another release's migrations. Owned servers keep the runner.
select_auth_cli() {
  AUTH_CLI="$RUNNER_FILE"
  [ "$LIVE_STATUS" = live ] && [ "$LIVE_OWNED" != 1 ] && [ "$LIVE_COMPATIBLE" = 1 ] || return 0
  rec_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$DEFAULT_RUNTIME_FILE" 2>/dev/null || true)"
  rec_cli="$(sed -n 's/.*"cliPath"[[:space:]]*:[[:space:]]*"\([^"\\]*\)".*/\1/p' "$DEFAULT_RUNTIME_FILE" 2>/dev/null || true)"
  for cli in "$rec_cli" "$RUNNER_FILE"; do
    [ -n "$cli" ] && [ -x "$cli" ] || continue
    [ "$cli" = "$RUNNER_FILE" ] || [ "$rec_pid" = "$LIVE_PID" ] || continue
    if [ "$("$cli" --version 2>/dev/null || true)" = "goat v$LIVE_VERSION" ]; then AUTH_CLI="$cli"; return 0; fi
  done
  printf 'GOAT v%s on this host has no CLI of its own release; open or update GOAT there and reconnect.\n' "$LIVE_VERSION" >&2
  exit 1
}
```

### MODIFY `packages/ssh/src/tunnel.ts` `REMOTE_PAIRING_SCRIPT`(`:1279-1286`), `REMOTE_MCP_SESSION_SCRIPT`(`:1302-1316`)

```diff
 recheck_selected_before_use
-"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
+check_live_protocol
+select_auth_cli
+"$AUTH_CLI" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
```

MCP 세션도 같은 방식으로 `AUTH_CLI`를 고르고 두 호출(`--runtime-mode-ceiling` 시도와 기본값 재시도)에 쓴다. `check_live_protocol`이 이 스크립트에서 이미 불리는지(`@@T3_RUNNER_SETUP@@`, `:1480-1532`)는 사이클 P에서 확인하고, 이미 불린다면 결과 변수만 읽는다. `--base-dir`은 그대로 `$DEFAULT_SERVER_HOME`이다(홈이 하나라서).

### MODIFY `apps/server/src/sshRemote/SshRemoteDispatch.ts`

코드 변경 없음을 기본으로 한다. 같은 홈이라 이어받기 전후로 서명 키와 `auth_sessions`가 같아 캐시된 토큰이 계속 유효하고, 401이면 이미 버리고 다시 발급한다(`:459`, `:759-769`). 사이클 C에서 이 가정을 fixture로 확인한다.

### MODIFY `packages/ssh/src/fixtures/remote-runner-baseline.json`

스크립트 텍스트가 바뀌므로 다시 만든다. 방법은 `packages/ssh/src/tunnel.core.test.ts:55-80`과 `tunnel.fixture.ts:185-198`(Vite가 아닌 Node로 렌더링)을 따른다.

## 테스트

- MODIFY `packages/ssh/src/tunnel.protocol-compat.test.ts`: "reuses an external live server of another release when both protocol integers match, without its binary installed" → 결과 `managed: "external"`, 실행 스크립트가 `kill`을 부르지 않는다.
- MODIFY 같은 파일: "rejects an external live server whose protocol differs" → 지금과 같은 오류, 서버는 그대로.
- MODIFY `packages/ssh/src/tunnel.mcpSession.test.ts`: 외부 서버 기록에 `cliPath`가 있고 PID가 맞고 `--version`이 서버 버전이면 그 CLI로 발급한다. `cliPath`가 없거나 다른 버전(셰임이 새 앱으로 바뀐 경우)이면 선택한 러너가 같은 버전일 때만 러너로 발급한다. 둘 다 아니면 `auth`를 실행하지 않고 오류로 끝난다(더 새 러너, 더 옛 러너 각각). 소유 런타임은 지금처럼 러너로 발급한다.
- MODIFY `tunnel.protocol-refresh.test.ts`, `tunnel.protocol-replacement.test.ts`: 소유 런타임의 기존 결과가 그대로인지(회귀).
- MODIFY `apps/server/src/serverRuntimeState.test.ts`: `cliPath`가 기록되고 읽힌다.

## 검증

```sh
(cd packages/ssh && vp test run src/tunnel.protocol-compat.test.ts src/tunnel.mcpSession.test.ts src/tunnel.protocol-refresh.test.ts src/tunnel.protocol-replacement.test.ts src/tunnel.core.test.ts)
(cd apps/server && vp test run src/serverRuntimeState.test.ts)
```

이 fixture들은 실제 셸로 스크립트를 실행한다(`tunnel.protocol.fixture.ts:368-403`). 실제 SSH 대상에는 연결하지 않는다.
