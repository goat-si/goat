# 030 — 데스크톱 홈을 `~/.goat` 하나로 (wp3)

> 결정 U1, U3, U4 ([000_plan.md](./000_plan.md)). 의존: 010(`takeoverIdleOwner`), 020(`legacyUserdataDirs`). 기준 origin/dev `390b9fd42`.

## 목표

패키지 데스크톱의 기본 홈을 `~/.goat/desktop`에서 `~/.goat`로 바꾼다. 처음 새 버전이 열릴 때 데스크톱 전용 설정 파일을 새 홈으로 옮기고, 서버에 이어받기와 옛 홈 병합을 부트스트랩으로 요청하고, 기다리는 동안 대기 화면을 띄운다. 개발 빌드(`~/.t3`)와 `T3CODE_HOME`을 지정한 경우는 바뀌지 않는다. Electron 프로필, 번들 id, 업데이트 피드도 그대로다.

## 변경

### MODIFY `apps/desktop/src/app/DesktopStatePaths.ts:13-24`

```diff
 export function resolveDesktopBaseDir(input: { ... }): string {
   return Option.getOrElse(normalizeConfiguredBaseDir(input.t3Home), () =>
     input.isDevelopment
       ? input.joinPath(input.homeDirectory, ".t3")
-      : input.joinPath(input.homeDirectory, ".goat", "desktop"),
+      : input.joinPath(input.homeDirectory, ".goat"),
   );
 }
+
+/**
+ * Where packaged builds before goat-si/goat#1 kept their data. Only the
+ * implicit packaged home has one; an explicit T3CODE_HOME or a development
+ * build never migrates.
+ */
+export function resolveLegacyDesktopStateDir(input: {
+  readonly homeDirectory: string;
+  readonly joinPath: JoinPath;
+  readonly t3Home: Option.Option<string>;
+  readonly isDevelopment: boolean;
+}): Option.Option<string> {
+  if (input.isDevelopment || Option.isSome(normalizeConfiguredBaseDir(input.t3Home))) return Option.none();
+  return Option.some(input.joinPath(input.homeDirectory, ".goat", "desktop", "userdata"));
+}
```

`DesktopEnvironment`(`apps/desktop/src/app/DesktopEnvironment.ts:173-221`)에 `legacyStateDir: Option<string>`를 추가해 위 함수로 채운다.

### NEW `apps/desktop/src/app/DesktopLegacyHome.ts`

```ts
// Files the desktop reads itself, before its backend can merge the old home.
export const LEGACY_DESKTOP_FILES = [
  "desktop-settings.json",
  "client-settings.json",
  "saved-environments.json",
  "connection-catalog.json",
] as const;

/** Copies each file that exists in the legacy state dir and is missing in the new one. Never overwrites. */
export function adoptLegacyDesktopFiles(input: {
  readonly legacyStateDir: string;
  readonly stateDir: string;
  readonly fs: Pick<
    typeof import("node:fs"),
    | "existsSync"
    | "mkdirSync"
    | "copyFileSync"
    | "linkSync"
    | "unlinkSync"
    | "readdirSync"
    | "statSync"
  >;
}): ReadonlyArray<string>; // copied names
```

동기 함수다. 원본에 `MERGED-INTO.json`이 있으면 아무것도 하지 않는다. 먼저 새 상태 폴더의 `.*.legacy-tmp-*`를 지운다(이전 실행이 남긴 조각). 파일마다 같은 폴더의 `.<name>.legacy-tmp-<rand>`로 복사하고 크기가 원본과 같은지 확인한 뒤 `linkSync(tmp, dest)`로 놓고 tmp를 지운다. 대상이 이미 있으면 `EEXIST`로 그대로 두고, 링크를 지원하지 않으면(`EPERM`/`ENOTSUP`/`EXDEV`) 그 파일은 옮기지 않는다(로그만; 서버 병합의 `copyFileAtomic`도 같은 이유로 남겨 두므로 덮어쓰거나 잘린 파일이 생기지 않는다). 그래서 중단돼도 대상에는 완전한 파일이나 아무 파일도 없다.

### MODIFY `apps/desktop/src/main.ts` (시작 직후, `DesktopEarlyElectronStartup`의 설정 읽기보다 먼저)

`resolveDesktopBaseDir`/`resolveDesktopStateDir`/`resolveLegacyDesktopStateDir`를 `process.env`와 `os.homedir()`로 계산해 `adoptLegacyDesktopFiles`를 한 번 부른다. 실패는 무시하고 로그만 남긴다(설정이 기본값이 될 뿐 시작은 계속). 정확한 위치는 사이클 P에서 `DesktopEarlyElectronStartup.ts:52-80` `resolveEarlyDesktopSettingsPath` 호출 순서를 보고 정한다. `connection-catalog.json`은 Electron safeStorage로 암호화돼 있지만(`apps/desktop/src/app/DesktopConnectionCatalogStore.ts:403,485`) Electron 프로필이 홈과 따로 정해지므로(`apps/desktop/src/app/DesktopUserData.ts:34`) 그대로 읽힌다.

### MODIFY `apps/desktop/src/backend/DesktopBackendConfiguration.ts:562-585`

```diff
       resourceMonitorPath ...,
       ...buildObservabilityFragment(input.observabilitySettings),
+      // goat-si/goat#1: one server per userdata. Take over an idle SSH runtime
+      // already serving this home, and merge the pre-#1 desktop home once.
+      takeoverIdleOwner: true,
+      ...Option.match(environment.legacyStateDir, {
+        onNone: () => ({}),
+        onSome: (dir) => ({ legacyUserdataDirs: [dir] }),
+      }),
     };
```

WSL 백엔드 부트스트랩(같은 파일의 WSL 경로)에는 넣지 않는다. WSL은 자기 홈을 쓴다.

### MODIFY `apps/desktop/src/window/DesktopWindow.ts:209-219, 904-949`, `apps/desktop/src/app/DesktopApp.ts:245-254`

`buildConnectingSplashDataUrl(shouldUseDarkColors, label)`로 문구를 인자로 받는다. `showConnectingSplash`는 `(label: string) => Effect<void>`가 된다. WSL 호출은 `"Connecting to WSL…"`을 그대로 넘긴다.

`DesktopApp.ts`의 `primaryBackend.start` 직전:

```text
// Inside the existing bootstrap Effect.gen, just before `yield* primaryBackend.start`.
const handoff = yield* detectLocalServerHandoff({
  stateDir: environment.stateDir,
  legacyStateDir: environment.legacyStateDir,
  appVersion: environment.appVersion,
});
const label = HANDOFF_SPLASH_LABELS[handoff]; // undefined for "none"
if (label !== undefined) yield* desktopWindow.showConnectingSplash(label);
```

`HANDOFF_SPLASH_LABELS` (same new module):

| handoff     | label                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `takeover`  | Waiting for remote work on this computer to finish…                                                      |
| `desktop`   | Another GOAT app is using this computer's data. Quit it to continue.                                     |
| `service`   | The GOAT background service is using this computer's data. Stop it with `goat service stop` to continue. |
| `newer`     | A newer GOAT is using this computer's data. Update this app to continue.                                 |
| `unmanaged` | Another GOAT server is using this computer's data. Stop it to continue.                                  |
| `merge`     | Moving GOAT data into one place…                                                                         |

NEW `apps/desktop/src/app/DesktopServerHandoff.ts` `detectLocalServerHandoff`: `<stateDir>/server-owner.json` 또는 `<stateDir>/server-runtime.json`의 PID가 살아 있으면 holder가 있다. 그 기록의 `mode`가 desktop이면 `"desktop"`, `serviceManaged`면 `"service"`, `serverVersion`이 앱 버전보다 새것이면 `"newer"`, `<home>/ssh-launch/*/`에 그 PID·포트를 가진 `managed` 기록이 없으면 `"unmanaged"`, 그 외 `"takeover"`(명령줄 대조까지 하는 정본 판정은 서버의 `verifySshManagedOwner`). holder가 없고 `legacyStateDir`에 `statev2.sqlite`가 있고 `MERGED-INTO.json`이 없으면 `"merge"`, 그 외 `"none"`. 파일 읽기와 `process.kill(pid, 0)`만 한다(판정의 정본은 서버의 010 로직이고, 이것은 화면 문구용이다). 서버가 준비되면 기존 흐름이 대기 화면을 닫고 본 창을 연다(WSL 경로와 같음). 문구는 사실만 말한다: 이어받기 대기는 서버가 실제로 기다리는 동안만 보인다.

### 테스트가 고정한 옛 경로

`apps/desktop/src/app/DesktopEnvironment.test.ts:182-183`, `DesktopEarlyElectronStartup.test.ts:25`, `DesktopCliShim.test.ts:115`, `backend/DesktopBackendConfiguration.test.ts:240`의 `.goat/desktop`를 `.goat`로 바꾸고, 부트스트랩 테스트에 `takeoverIdleOwner`와 `legacyUserdataDirs`(패키지 기본 홈일 때만) 단언을 더한다.

### 따라 움직이는 것 (코드 변경 없음, 확인만)

CLI 셰임 `<home>/bin/goat` → `~/.goat/bin/goat`(`DesktopCliShim.ts:131,160`, 표식이 없는 파일은 덮어쓰지 않는다 `:163-164`; `scripts/install.sh:23`은 `~/.local/bin`을 써서 겹치지 않는다). 런타임 아카이브 캐시 `~/.goat/runtime/archives`(`main.ts:118`, SSH 런타임의 `runtime/goat/versions`와 다른 폴더). 업데이트 재시작 표식 `~/.goat/runtime`(`updates/DesktopUpdates.ts:522`). 워크트리 `~/.goat/worktrees`, 스크래치 `~/.goat/scratch`(서버 `config.ts:156`, `ManagedProjectFolders.ts:267`). 옛 `~/.goat/desktop/worktrees` 안의 작업공간은 그 경로에 그대로 있고 병합된 프로젝트가 그 경로를 가리킨다.

## 테스트

- NEW `apps/desktop/src/app/DesktopLegacyHome.test.ts`: 없는 파일만 복사, 있는 파일은 그대로, 표식이 있으면 복사 없음, tmp 조각이 남은 상태에서 다시 실행하면 조각을 지우고 완전한 파일을 놓음, 링크 직전에 대상이 생기면 그 바이트 유지, 가짜 `linkSync`가 `ENOTSUP`면 대상 파일이 생기지 않음.
- NEW `apps/desktop/src/app/DesktopServerHandoff.test.ts`: 살아 있는 web PID 기록 + 같은 PID·포트의 `ssh-launch/<key>/managed` 기록 → takeover, 그 기록 없음 → unmanaged, desktop/service/더 새 버전 기록 → 각 이유, 옛 DB만 → merge, 표식 있음 → none, 죽은 PID → none.
- NEW `apps/desktop/src/app/DesktopStatePaths.test.ts`: 패키지 기본 홈 `~/.goat`, 개발 `~/.t3`, `T3CODE_HOME` 우선, `resolveLegacyDesktopStateDir`는 패키지 기본 홈일 때만 값.
- MODIFY 위 네 테스트 파일.

## 검증

```sh
vp run --filter @t3tools/desktop ensure:electron
cd apps/desktop && vp test run src/app/DesktopStatePaths.test.ts src/app/DesktopLegacyHome.test.ts src/app/DesktopServerHandoff.test.ts src/app/DesktopEnvironment.test.ts src/app/DesktopEarlyElectronStartup.test.ts src/app/DesktopCliShim.test.ts src/backend/DesktopBackendConfiguration.test.ts src/window/DesktopWindow.test.ts
```

실제 데스크톱 실행 검증은 사용자 허락 없이 하지 않는다(AGENTS.md). 050에서 서버 부트스트랩을 손으로 만들어 같은 경로를 임시 HOME에서 재현한다.
