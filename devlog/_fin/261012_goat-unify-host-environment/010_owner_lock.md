# 010 — 서버 소유 잠금과 데스크톱 이어받기 (wp1)

> 결정 U2, U3 ([000_plan.md](./000_plan.md)). 기준 origin/dev `390b9fd42`. 사이클 P에서 앵커를 다시 확인한다. 리뷰 01a12ca1(FAIL) 블로커 1, 2, 6을 반영했다.

## 목표

한 userdata를 한 서버만 서비스한다. 서버는 DB를 열기 전에 `<userdata>/server-owner.lock`을 잡는다. 이미 다른 서버가 살아 있으면 `goat serve`/`goat start`는 실패하고, 데스크톱이 띄운 서버(`takeoverIdleOwner`)는 조건이 맞을 때만 상대를 내리고 이어받고, 아니면 기다린다. 런타임 기록(`server-runtime.json`)은 자기 PID일 때만 지운다.

## 잠금 원시 연산: SQLite 배타 잠금

`server-owner.lock`은 빈 SQLite 파일이다. 서버는 `node:sqlite` `DatabaseSync`로 열어 `PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE`를 실행하고, 프로세스가 끝날 때까지 그 연결을 연다. 커널이 잠금을 쥐므로 프로세스가 죽으면(SIGKILL 포함) 바로 풀리고, 지울 stale 파일이 없다. 다른 프로세스의 `BEGIN EXCLUSIVE`는 `database is locked`로 즉시 실패한다. 이 기기(node 24.21.0)에서 실측: holder가 잡은 동안 probe 실패, holder SIGKILL 뒤 probe 성공. Windows에서도 SQLite가 `LockFileEx`로 같은 의미를 준다.

잠금을 잡은 서버는 옆에 `server-owner.json`을 원자적으로 쓴다(정보용, 판정의 정본은 잠금):

```ts
export const ServerOwnerRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  mode: Schema.Literals(["web", "desktop"]),
  serverVersion: Schema.String,
  serviceManaged: Schema.Boolean,
  acquiredAt: Schema.String,
});
```

잠금을 잡지 못하면 `server-owner.json`을 읽어 holder를 안다. 파일이 아직 없거나(holder가 막 잡음) 해석이 안 되면 holder 정보 "unknown"으로 기다린다.

## 잠금 없는 옛 서버 (0.0.45 등)

옛 서버는 잠금을 쥐지 않는다. 그래서 잠금을 잡은 **뒤에도** `server-runtime.json`을 확인한다. 기록 PID가 살아 있고 자기 PID가 아니면 옛 holder 후보다.

- PID 재사용 판정: 그 PID의 프로세스 시작 시각(`ps -o lstart= -p <pid>`, `LC_ALL=C TZ=UTC`, Windows는 판정 생략)이 기록 `startedAt`보다 뒤면 다른 프로세스다(서버는 시작 후에 기록을 쓴다, `server.ts:771-783`). 이 경우에만 무시한다.
- 그 외에는 **holder로 본다**(실패 열림 금지). 활동 엔드포인트가 답하지 않아도 holder다.
- 종류 판정: `ps -o command= -p <pid>`에 `--bootstrap-fd`가 있으면 desktop, ` serve`가 있으면 web, 아니면 unknown.

옛 holder가 있는 동안 새 서버는 잠금을 쥔 채로 기다리거나 실패한다. 잠금을 쥐고 있으므로 다른 새 서버가 끼어들지 못한다.

## SSH 런처가 띄운 런타임인지 확인

데스크톱이 내릴 수 있는 holder는 **GOAT SSH 런처가 띄웠다고 증명된 런타임**뿐이다(050 D-8: GOAT가 관리하지 않는 런타임은 바꾸지 않는다). 사람이 직접 띄운 `goat serve --base-dir ~/.goat`는 유휴여도 내리지 않는다. 증명은 런처의 `verify_owned_identity`(`packages/ssh/src/tunnel.ts:1065-1090`)와 같은 판정을 TS로 옮긴 `verifySshManagedOwner({ pid, port, baseDir })`다. `<baseDir>/ssh-launch/*/` 중 하나가 모두 만족해야 한다:

- `managed` 파일 내용이 `managed`, `pid`가 holder PID, `port`가 holder 포트.
- `identity` 파일이 있고 내용이 ` --port <port> --base-dir <baseDir>`로 끝난다.
- `ps -o command= -p <pid>`가 identity와 같다(identity가 `<baseDir>/runtime/goat/versions/`로 시작하는 아카이브 런타임), 또는 ` <identity>`로 끝난다(node 셰임).
- 위 파일들을 다시 읽어도 같다(검사 중 바뀌지 않음).

identity가 없는 옛 기록(런처의 레거시 인수 전)은 증명되지 않은 것으로 본다. 이 기기 실측: 0.0.45 런타임 상태 폴더 `~/.goat/ssh-launch/ba30ffcc67a672f3`에 `identity`, `managed`, `pid`, `port`가 모두 있다.

## holder가 있을 때

| 조건                                                                                             | `takeover: "never"` (`goat serve`, `start`) | `takeover: "idle"` (데스크톱)                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 어떤 holder든                                                                                    | `ServerOwnerConflictError`                  | 아래                                                                                                                      |
| holder가 desktop 또는 종류 unknown                                                               | —                                           | 기다림(`reason: "desktop"`/`"unknown"`), 내리지 않음                                                                      |
| holder가 `serviceManaged`(부트 서비스, launchd `KeepAlive`/systemd `Restart=always`가 다시 띄움) | —                                           | 기다림(`reason: "service"`)                                                                                               |
| holder `serverVersion`이 내 버전보다 새것(`compareSemverVersions` > 0)                           | —                                           | 기다림(`reason: "newer"`), 050 D-8 "앱보다 새 런타임은 낮추지 않는다"                                                     |
| 활동 `busy`/`unknown` 또는 포트 모름                                                             | —                                           | 기다림(`reason: "busy"`)                                                                                                  |
| SSH 런처 소유가 증명되지 않음(위 절)                                                             | —                                           | 기다림(`reason: "unmanaged"`)                                                                                             |
| 활동 `idle`(같은 PID로 답함), SSH 런처 소유 증명, 같거나 옛 버전                                 | —                                           | 다시 한 번 활동·PID 확인 후 SIGTERM, 최대 15초 종료 대기, 그 뒤 처음부터. 15초 뒤에도 살아 있으면 SIGKILL하지 않고 기다림 |

기다리는 동안 `onWaiting(holder, reason)`을 부르고 `pollInterval`(기본 2초)마다 다시 판정한다. 새 holder는 잠금 재시도로, 옛 holder는 PID 생존으로 끝남을 안다.

## 스키마 게이트

잠금과 holder 판정을 통과한 뒤, DB를 열기 전에 `statev2.sqlite`를 읽기 전용으로 열어 `effect_sql_migrations`의 최대 `migration_id`가 이 빌드 매니페스트(`apps/server/src/persistence/Migrations.ts`의 `migrationEntries`)의 최대 id보다 크면 `ServerDataTooNewError`로 멈춘다. 지금은 모르는 id를 경고만 한다(`Migrations.ts:214-224`). 옛 서버가 새 스키마 DB를 열어 반쯤 동작하는 것을 막는다. 파일이 없으면 통과.

## 변경

### NEW `apps/server/src/serverOwnerLock.ts`

```ts
export const SERVER_OWNER_LOCK_FILE = "server-owner.lock";
export const SERVER_OWNER_RECORD_FILE = "server-owner.json";

export type ServerOwnerHolder = {
  readonly pid: number | undefined;
  readonly mode: "web" | "desktop" | "unknown";
  readonly serverVersion: string | undefined;
  readonly serviceManaged: boolean;
  readonly port: number | undefined; // server-runtime.json
  readonly origin: string | undefined;
  readonly legacy: boolean; // 잠금 없는 옛 서버
};
export type ServerOwnerWaitReason =
  "busy" | "desktop" | "unknown" | "service" | "newer" | "unmanaged";

export class ServerOwnerConflictError extends Schema.TaggedError<ServerOwnerConflictError>()(
  "ServerOwnerConflictError",
  {
    stateDir: Schema.String,
    pid: Schema.optional(Schema.Int),
    origin: Schema.optional(Schema.String),
  },
) {
  /* "A GOAT server is already running for <stateDir> (pid …, origin). Connect to that server or stop it first." */
}
export class ServerDataTooNewError extends Schema.TaggedError<ServerDataTooNewError>()(
  "ServerDataTooNewError",
  { dbPath: Schema.String, recordedMigration: Schema.Int, supportedMigration: Schema.Int },
) {
  /* "This GOAT data was written by a newer GOAT. Update GOAT to open it." */
}

// OS 경계. 테스트는 가짜를 넣는다.
export interface ServerOwnerProbe {
  readonly tryLock: (lockPath: string) => Option.Option<{ readonly release: () => void }>;
  readonly isAlive: (pid: number) => boolean;
  readonly processStart: (pid: number) => Option.Option<Date>;
  readonly processCommand: (pid: number) => Option.Option<string>;
  readonly activity: (port: number, pid: number) => Effect.Effect<"idle" | "busy" | "unknown">;
  readonly terminate: (pid: number) => void;
}

export const acquireServerOwnerLock: (input: {
  readonly stateDir: string;
  readonly runtimeStatePath: string;
  readonly dbPath: string;
  readonly mode: "web" | "desktop";
  readonly serverVersion: string;
  readonly serviceManaged: boolean;
  readonly takeover: "never" | "idle";
  readonly onWaiting?: (
    holder: ServerOwnerHolder,
    reason: ServerOwnerWaitReason,
  ) => Effect.Effect<void>;
  readonly probe?: ServerOwnerProbe;
  readonly pollInterval?: Duration.Duration;
}) => Effect.Effect<
  void,
  ServerOwnerConflictError | ServerDataTooNewError | ServerOwnerLockError,
  Scope.Scope | FileSystem.FileSystem
>;
```

스코프가 닫히면 `server-owner.json`을 (내 PID일 때만) 지우고 잠금 연결을 닫는다. `activity` 기본 구현은 `apps/server/src/cli/sshHelper.ts:400-440`의 `/.well-known/t3/activity` 조회(같은 PID 확인 포함)를 이 모듈로 옮기고 `sshHelper.ts`가 그것을 호출하게 한다. `serviceManaged`는 `ServiceLauncherClient`가 정하는 값과 같아야 한다(`server.ts:777-781`). 잠금 단계에서 그 서비스를 쓸 수 없으면 사이클 P에서 같은 판정 함수를 꺼내 쓴다.

### MODIFY `apps/server/src/cli/server.ts:15-27` `runServerCommand`

```diff
     const config = yield* resolveServerConfig(flags, logLevel, options);
-    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
+    return yield* Effect.scoped(
+      Effect.gen(function* () {
+        yield* acquireServerOwnerLock({
+          stateDir: path.dirname(config.dbPath),
+          runtimeStatePath: config.serverRuntimeStatePath,
+          dbPath: config.dbPath,
+          mode: config.mode,
+          serverVersion: packageJson.version,
+          serviceManaged: /* 위 판정 */,
+          takeover: config.takeoverIdleOwner ? "idle" : "never",
+          onWaiting: (holder, reason) =>
+            Effect.logInfo("Waiting for the GOAT server using this data", { pid: holder.pid, reason }),
+        });
+        // wp2: mergeLegacyUserdata(config) 자리
+        return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
+      }),
+    );
```

두 오류는 기존 CLI 오류 매핑으로 `CliError.UserError`가 되게 한다. `resolveServerConfig`의 첨부 정리(`config.ts:192`)는 잠금보다 먼저 돈다. 만료된 업로드 임시 파일만 지우는 일이라 그대로 둔다.

### MODIFY `packages/contracts/src/desktopBootstrap.ts:5-37`

```diff
   resourceMonitorPath: Schema.optionalKey(TrimmedNonEmptyString),
+  // Set by the desktop: when another server serves this userdata, wait for it
+  // and take over an idle, older-or-equal, unsupervised web server instead of failing.
+  takeoverIdleOwner: Schema.optionalKey(Schema.Boolean),
```

### MODIFY `apps/server/src/config.ts:85-108`, `apps/server/src/cli/config.ts:360-475`

`ServerConfig`에 `readonly takeoverIdleOwner?: boolean | undefined`. `resolveServerConfig`는 `bootstrap?.takeoverIdleOwner`를 옮긴다(`shellEnvironmentPrepared`와 같은 모양, `:363`, `:472`).

### MODIFY `apps/server/src/serverRuntimeState.ts:99-110`, `apps/server/src/server.ts:792-797`

`clearPersistedServerRuntimeState(path, options?: { ownerPid?: number })`: `ownerPid`가 있으면 기록 PID가 같을 때만 지운다. `server.ts:793`은 `{ ownerPid: process.pid }`를 넘긴다. `cli/project.ts:373`은 그대로.

## 테스트

NEW `apps/server/src/serverOwnerLock.test.ts`:

1. 실제 `tryLock`: 자식 프로세스가 잡은 동안 실패, 자식 SIGKILL 뒤 성공(stale 정리 없이).
2. 비어 있으면 잡고 `server-owner.json`을 쓰고, 스코프가 끝나면 지운다.
3. 새 holder + `never` → `ServerOwnerConflictError`(pid, origin).
4. `idle` + web holder 유휴, 같은 버전, SSH 런처 소유 기록(임시 `ssh-launch/<key>/`의 `managed`/`pid`/`port`/`identity`와 같은 가짜 명령줄) → `terminate` 한 번, 종료 뒤 잡는다.
5. `idle` + 4와 같은 소유 기록의 holder가 바쁨 → `onWaiting(…, "busy")`, `terminate` 없음. 활동이 idle로 바뀌면 이어받는다(TestClock).
6. `idle` + holder desktop / `serviceManaged` / 더 새 버전 / 종류 unknown → 각각 해당 이유로 기다림, `terminate` 없음.
   6a. `idle` + 유휴 web holder: 임시 `ssh-launch/<key>/`에 맞는 `managed`/`pid`/`port`/`identity`와 같은 명령줄이 있으면 이어받고, 사람이 띄운 서버(상태 폴더 없음), identity 없음, 명령줄 불일치면 `reason: "unmanaged"`로 기다린다.
7. 옛 holder: 런타임 기록 PID가 살아 있고 활동이 무응답 → holder(기다림/충돌). 프로세스 시작이 기록 `startedAt`보다 뒤 → 무시하고 시작. 명령줄에 `--bootstrap-fd` → desktop으로 보호.
8. 스키마 게이트: 기록된 최대 migration id가 매니페스트보다 크면 `ServerDataTooNewError`, 같거나 작으면 통과.

MODIFY `apps/server/src/serverRuntimeState.test.ts`: `ownerPid`가 다르면 기록을 남긴다.

## 검증

```sh
cd apps/server && vp test run src/serverOwnerLock.test.ts src/serverRuntimeState.test.ts src/cli/config.test.ts src/cli/sshHelper.test.ts
```

typecheck는 `apps/server`에서 패키지 스크립트로(사이클 P에서 이름 확인). 임시 HOME 재현은 050.
