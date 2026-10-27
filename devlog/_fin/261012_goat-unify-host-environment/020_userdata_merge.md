# 020 — userdata 병합 (wp2)

> 결정 U4, U5 ([000_plan.md](./000_plan.md)). 의존: 010의 `acquireServerOwnerLock`과 스키마 게이트. 기준 origin/dev `390b9fd42`. 리뷰 01a12ca1 1차 블로커 3, 4, 7, 8과 2차 블로커 1-3을 반영했다.

## 목표

옛 userdata(원본, 보통 `~/.goat/desktop/userdata`)를 현재 userdata(대상, `~/.goat/userdata`)에 한 번 합친다. 서버가 소유 잠금을 잡은 직후 자동으로 하고(데스크톱이 부트스트랩으로 원본을 알려 준다), 같은 일을 `goat userdata merge`로 손으로도 할 수 있다. 원본은 읽기만 하고 끝에 `MERGED-INTO.json` 표식만 남긴다. 중간에 끊기면 다음 시작이 저널을 보고 이어간다. 다시 실행하면 아무것도 바뀌지 않는다. 새 SQL 마이그레이션은 만들지 않는다(010_fork_delta 마이그레이션 규칙).

## 저널

대상의 `merges/pending.json`(원자적 쓰기, `writeFileStringAtomically`):

```ts
{
  version: 1,
  mode: "adopt" | "merge",
  source: string,                 // 원본 userdata realpath
  sourceEnvironmentId: string,
  phase: "staged" | "files-copied" | "published" | "committed",
  acceptedThreadIds: string[],    // merge: 받아들인 스레드(커밋 뒤 파일 단계가 쓴다)
  providerInstanceIds: string[],  // merge: 대상에 더할 provider 인스턴스
  startedAt: string,
}
```

스테이징 폴더는 `merges/staging/`, 백업은 `backups/`. 둘과 `merges/` 전체는 어떤 복사에서도 제외한다.

## 순서 (서버 시작과 CLI가 같은 함수를 쓴다)

`mergeUserdata({ sourceStateDir, destinationStateDir, dryRun })`:

1. **대상 저널 먼저**: `pending.json`이 있으면 그 `source`와 `mode`로 아래 "재개"를 한다. 인자로 받은 원본과 다르면 저널의 원본을 우선한다.
2. 원본에 `MERGED-INTO.json` → `already-merged`. 원본에 `statev2.sqlite`도 `state.sqlite`도 없음 → `empty-source`.
3. **원본 잠금**: `acquireServerOwnerLock({ stateDir: source, takeover: "never" })`(010, 옛 holder 판정 포함). 실패 → `source-in-use`(아무것도 쓰지 않음).
4. **판정**: 대상에 `statev2.sqlite`, `state.sqlite`, `environment-id`, `secrets/server-signing-key.bin`이 모두 없으면 adopt, 아니면 merge.
5. **원본 스테이징**(원본은 읽기 전용): `merges/staging/`을 비우고 다시 만든다. 원본에 `statev2.sqlite`가 있으면 `VACUUM INTO 'merges/staging/statev2.sqlite'`. 없고 V1 `state.sqlite`만 있으면 `VACUUM INTO 'merges/staging/state.sqlite'` 후 `initializeV2Database('merges/staging/statev2.sqlite')`(`apps/server/src/persistence/initializeV2Database.ts:26-36`, 같은 폴더의 V1을 읽는다). 스테이징 DB에 010 스키마 게이트를 적용하고(더 새 스키마면 `ServerDataTooNewError`로 `skipped: source-too-new`, 스테이징을 지운다), `SqlitePersistence.layerFromPath(staging)`(`apps/server/src/persistence/Sqlite.ts:29`)로 열어 현재 스키마로 올리고, 옛 V1 대화가 남았으면 `LegacyV1ThreadImporter`의 `reconcileShells`와 스레드별 `ensureTranscript`(`apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts:110-113`, 레이어 `:829-832`)를 돌린다. 실패한 스레드는 `skipped: legacy-import-failed`. 그다음 스테이징 레이어를 닫기 전에 `PRAGMA wal_checkpoint(TRUNCATE)`가 성공해야 하고, 레이어 스코프를 닫은 뒤 `statev2.sqlite-wal`/`-shm`이 없거나 비어 있음을 확인한다(`layerFromPath`는 WAL을 켠다, `Sqlite.ts:21`). 스테이징 DB는 옆 파일 없이 혼자 열려야 한다. 이 확인이 끝나야 저널에 `staged`를 쓴다.
6. adopt면 "들이기", merge면 "합치기".

## 들이기 (대상이 비어 있을 때)

환경 id, 서명 키, `auth_sessions`, 클라우드 연결까지 원본 그대로 이어진다.

| phase          | 다음 일                                                                                                                                                                                                          | 끝나면         |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| (5 직후)       | 저널 `{ mode: "adopt", phase: "staged" }`                                                                                                                                                                        | —              |
| `staged`       | 원본의 DB 아닌 파일·폴더를 대상에 복사(덮어쓰기 허용: 대상은 비어 있었다). 제외: `statev2.sqlite*`, `state.sqlite*`, `server-runtime.json`, `server-owner.*`, `logs/`, `merges/`, `backups/`, `MERGED-INTO.json` | `files-copied` |
| `files-copied` | `rename('merges/staging/statev2.sqlite', 'statev2.sqlite')`. 스테이징 파일이 없고 대상 `statev2.sqlite`가 있으면 이미 옮긴 것이다                                                                                | `published`    |
| `published`    | 대상 `merges/<sourceEnvironmentId>.json`, 원본 `MERGED-INTO.json`을 쓰고(이미 있으면 그대로), 스테이징을 지우고, 저널을 지운다                                                                                   | 끝             |

재개 판정은 파일 상태가 저널보다 먼저다: 대상 `statev2.sqlite`가 있고 스테이징 DB가 없으면 저널 단계와 관계없이 `published`로 보고 표식 단계로 간다(rename 직후 저널 쓰기 전에 끊긴 경우). 대상 DB도 스테이징 DB도 없을 때만 5부터 다시 스테이징한다(복사한 파일은 같은 원본에서 다시 덮어쓴다). **adopt 저널이 남아 있는 동안 원본을 잠그지 못하거나 단계가 실패하면 서버는 시작하지 않는다**(`UserdataMergeError`). 빈 대상으로 시작하면 다음 판정이 merge로 바뀌어 원본 세션을 잃기 때문이다. 데스크톱은 백엔드 재시작으로 다시 시도하고, 대기 화면이 이유를 보인다(030).

## 합치기 (둘 다 데이터가 있을 때)

1. **대상 준비**: 대상에 V1 `state.sqlite`만 있으면 `initializeV2Database(config.dbPath)`를 먼저 부른다(`SqlitePersistence.layerConfig`가 하는 일, `Sqlite.ts:54`). 대상에 010 스키마 게이트를 적용한다. 그 뒤 `layerFromPath(config.dbPath)`로 연다.
2. 대상 백업: `VACUUM INTO 'backups/statev2.pre-merge-<UTC>.sqlite'`.
3. 저널 `{ mode: "merge", phase: "staged", acceptedThreadIds, providerInstanceIds }` — 아래 판정 결과를 담는다.
4. 대상 연결에서 `ATTACH DATABASE 'merges/staging/statev2.sqlite' AS src` 후 **한 SQL 트랜잭션**:
   - **프로젝트 판정**: 원본 프로젝트마다(`projection_projects`)
     - 대상에 같은 id + 정규화한 `workspace_root`(`path.resolve`, 끝 `/` 제거)가 같음 → `same`.
     - 대상에 같은 id + 경로가 다름 → `diverged`. 이 프로젝트의 원본 스레드는 모두 `skipped: project-diverged`.
     - 대상에 같은 경로의 살아 있는 다른 id 프로젝트 → `mapped`(원본 → 대상 id). 원본 프로젝트 스트림은 가져오지 않는다.
     - 그 외 → `imported`.
   - **스레드 판정**: `projectId`(`orchestration_v2_projection_threads`)가 `same`/`mapped`/`imported`일 때만 받아들인다. 스트림이 대상에 없으면 가져오고, 있으면 원본 `event_id`가 모두 대상에 있을 때 "이미 있음"(받아들인 것으로 친다), 아니면 `conflict`.
   - **딸린 스트림**: 스레드·프로젝트가 아닌 `aggregate_kind`(사이클 P에서 `SELECT DISTINCT`로 확정; 이 기기 실측은 `project`, `thread`뿐)는 받아들인 스레드나 프로젝트에 속할 때만 같은 규칙.
   - **이벤트 넣기**: 원본 `sequence` 순서로 `sequence`를 빼고 넣는다(`event_id`, `aggregate_kind`, `stream_id`, `stream_version`, `event_type`, `occurred_at`, `command_id`, `causation_event_id`, `correlation_id`, `actor_kind`, `payload_json`, `metadata_json`, `application_event_version`). `mapped` 프로젝트를 가리키는 행은 `payload_json`의 `projectId` 키 값을 대상 id로 바꾼다(`OrchestrationV2AppThread.projectId`, `packages/contracts/src/orchestrationV2.ts:370`). 스트림 버전 빈칸(`ProjectionMaintenance.ts:295-315`)은 그대로.
   - **함께 옮길 행**(받아들인 것에 속한 것만): `scheduled_tasks`(`enabled = 0`, `next_run_at = NULL`, `webhook_token/secret = NULL`, `mapped` 치환, 같은 `task_id`면 건너뜀), `mcp_app_model_context`, `pull_request_files_viewed`(`INSERT OR IGNORE`).
   - **옮기지 않는 행**: 명령 영수증, `orchestration_v2_effect_outbox`, `orchestration_v2_thread_launch_workflows`, 웹훅 전달 큐, `auth_*`, `provider_session_runtime`, `checkpoint_diff_blobs`, 옛 V1 테이블.
   - **프로젝션**: 넣은 이벤트를 새 `sequence` 순서로 프로젝트는 `ProjectStoreV2.apply`(`apps/server/src/orchestration-v2/ProjectStore.ts:216`), 스레드는 `applyStoredEventToProjections`(`ProjectionMaintenance.ts:148-168`에서 꺼냄)로 적용하고, `thread-projections` 메타데이터를 새 최신 순번으로 갱신(`writeThreadProjectionMetadata`, `:174-185`에서 꺼냄).
   - 이 트랜잭션이 실패하면 롤백되고 대상 DB는 그대로다. 저널을 지우고 경고 로그만 남기며 서버는 시작한다(원본도 그대로라 다음 시작 때 다시 시도).
5. 커밋 뒤 저널 `phase: "committed"`. 커밋과 저널 쓰기 사이에 끊기면 다음 실행이 같은 판정을 다시 하는데, 가져온 스트림은 모두 "이미 있음"이라 받아들인 목록과 provider 목록이 같게 나오고 SQL은 아무것도 넣지 않는다.
6. **파일 단계**(`committed`에서, 모두 멱등). 모든 파일 복사는 `copyFileAtomic`: 같은 폴더의 `.<name>.merge-tmp-<rand>`에 쓰고 크기와 SHA-256을 원본과 비교한 뒤 `link(tmp, dest)`로 놓고(대상이 이미 있으면 `EEXIST`로 실패해 덮어쓰지 않는다) tmp를 지운다. 링크를 못 쓰는 파일시스템(`EPERM`/`ENOTSUP`/`EXDEV`)이면 그 파일을 `fileConflicts`에 `publish-unsupported`로 남기고 저널을 지우지 않는다(대상은 그대로, 다음 시작이나 손으로 다시). 덮어쓰지 않는 복사에 `rename`은 쓰지 않는다. 중단되면 tmp만 남고, 재개는 `.*.merge-tmp-*`를 먼저 지운다. 들이기의 파일 복사도 같은 함수를 쓴다(덮어쓰기 허용 모드는 `rename`).
   1. provider 비밀: `providerInstanceIds`마다 원본의 `provider-env-<base64url(instanceId)>-*` 비밀(`apps/server/src/serverSettings.ts:142-147`)을 대상에 없을 때 복사.
   2. `settings.json`: 대상이 이긴다. `providerInstanceIds` 중 대상 `providerInstances`(`packages/contracts/src/settings.ts:1276`)에 없는 id만 원본 설정으로 더해 원자적으로 쓴다. 같은 id에 다른 설정이면 대상 유지, `providerConflicts`. 비밀이 먼저라서 설정이 보일 때 비밀이 비어 있는 일은 없다.
   3. `attachments/`, `browser-artifacts/`: 대상에 없는 항목만. 같은 이름 다른 바이트면 대상 유지, `fileConflicts`.
   4. `client-settings.json`, `desktop-settings.json`, `connection-catalog.json`, `saved-environments.json`, `keybindings.json`, `themes/*`: 대상에 없을 때만(데스크톱 전용 파일은 030이 먼저 옮긴다).
   5. 다른 `secrets/*.bin`과 `environment-id`는 복사하지 않는다(대상 신원과 자격 유지, U5).
   6. 표식: 대상 `merges/<sourceEnvironmentId>.json`, 원본 `MERGED-INTO.json`(`{ version: 1, into, at, serverVersion, sourceEnvironmentId, destinationEnvironmentId, report }`), 스테이징 삭제, 저널 삭제.
      파일 단계가 실패하면 저널(`committed`)을 남기고 경고와 함께 서버는 시작한다. DB는 이미 일관되고, 다음 시작이 저널을 보고 파일 단계만 다시 한다(원본 잠금이 필요하다; 원본이 쓰이는 중이면 다음 기회).

`--dry-run`: 대상 저널이 있으면 아무것도 하지 않고 `{ mode: "skipped", reason: "pending", pending: <저널 내용> }`을 보고한다(저널과 `merges/staging/`을 건드리지 않는다). 저널이 없으면 OS 임시 폴더에 원본 스테이징(2-5)과 **대상 스냅숏**(대상 V2는 `VACUUM INTO`, V1만 있으면 그것을 `VACUUM INTO` 후 `initializeV2Database`)을 만들고, 대상 준비(합치기 1)와 판정, SQL 트랜잭션을 그 스냅숏에서 한 뒤 롤백하고, 임시 폴더를 지운 뒤 보고서만 낸다. 실제 대상의 DB 파일, 마이그레이션 기록, 설정, 신원, 저널은 열지도 쓰지도 않는다(스냅숏을 뜨는 읽기만).

보고서(`UserdataMergeReport`): `mode: "adopt" | "merge" | "skipped"`, `reason?`, `resumed: boolean`, `importedProjects`, `mappedProjects: Array<{ from, to, workspaceRoot }>`, `importedThreads`, `conflicts: Array<{ aggregateKind, streamId }>`, `skipped: Array<{ threadId, reason }>`, `fileConflicts: string[]`, `providerConflicts: string[]`.

## 변경

| 종류   | 경로                                                                | 내용                                                                                                                                                                                                  |
| ------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NEW    | `apps/server/src/userdataMerge/UserdataMerge.ts`                    | 위 순서. 원본/대상 `realpath`가 같으면 오류.                                                                                                                                                          |
| NEW    | `apps/server/src/userdataMerge/UserdataMerge.test.ts`               | 아래 테스트                                                                                                                                                                                           |
| MODIFY | `apps/server/src/orchestration-v2/ProjectionMaintenance.ts:148-185` | 루프 본문을 `applyStoredEventToProjections`, 메타데이터 쓰기를 `writeThreadProjectionMetadata`로 꺼내 export. 동작 변화 없음.                                                                         |
| NEW    | `apps/server/src/cli/userdata.ts`                                   | `goat userdata merge --from <userdata 또는 홈> [--base-dir <홈>] [--dry-run] [--json]`. 대상 잠금을 `takeover: "never"`로 잡는다(서버가 떠 있으면 "stop it first").                                   |
| MODIFY | `apps/server/src/binCli.ts:61-80`                                   | `userdataCommand` 등록                                                                                                                                                                                |
| MODIFY | `packages/contracts/src/desktopBootstrap.ts`                        | `legacyUserdataDirs: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString))`                                                                                                                         |
| MODIFY | `apps/server/src/config.ts`, `apps/server/src/cli/config.ts`        | `legacyUserdataDirs?: ReadonlyArray<string>`를 부트스트랩에서 옮김                                                                                                                                    |
| MODIFY | `apps/server/src/cli/server.ts` (010의 `// wp2` 자리)               | 잠금 뒤 대상 저널이 있으면 그것을, 없으면 `config.legacyUserdataDirs`마다 `mergeUserdata`. adopt 실패(저널 남음)는 시작 실패, 그 외 실패는 경고. 결과는 `Effect.logInfo("Merged GOAT data", report)`. |

## 테스트 (`UserdataMerge.test.ts`, 임시 디렉터리, 실제 영속화 레이어)

데이터는 서버 테스트 키트로 만든다(프로젝트·스레드 생성 명령을 `EventSink`로 커밋하는 기존 헬퍼, 사이클 P에서 `apps/server/src/orchestration-v2/testkit`에서 고른다). 중단은 `mergeUserdata`에 테스트 전용 `afterStep` 훅을 주어 그 단계 뒤에 실패시키는 방식으로 넣는다.

1. 대상 비어 있음 → adopt. `environment-id`, `auth_sessions`, 서명 키가 이어져 원본에서 발급한 세션 토큰이 대상 `SessionStore`로 검증된다. `server-runtime.json`은 복사되지 않는다.
2. adopt 중단: `staged` 뒤, `files-copied` 뒤(rename 전), rename 직후(저널 쓰기 전), `published` 뒤(표식 사이) 각각 → 재실행 결과가 1과 같다. rename 뒤에는 다시 스테이징하지 않는다. 스테이징을 마이그레이션과 V1 대화 가져오기로 만든 경우, 스테이징 옆 파일을 지운 뒤에도 가져온 대화가 대상에 보인다(WAL 체크포인트 확인).
   2a. 저널이 있을 때 `--dry-run` → `reason: "pending"`, 저널과 스테이징 바이트가 그대로다(진행 중 adopt와 `committed` merge 각각).
   2b. 저널이 없을 때 `--dry-run`, 대상이 V1만/옛 V2 각각 → 보고서는 나오고 대상 디렉터리의 모든 파일 바이트와 `effect_sql_migrations`가 그대로다.
   2c. 비밀과 첨부 복사 도중 중단(tmp 쓰기 뒤, 링크 전) → 대상에 잘린 파일이 없고 재개 뒤 바이트가 원본과 같으며 표식은 그 뒤에만 생긴다.
   2d. 링크 직전에 대상 파일이 새로 생김(훅으로 써 넣음) → 그 바이트가 그대로이고 `fileConflicts`에 남는다. 링크가 지원되지 않는 경우(가짜 `link`가 `ENOTSUP`) → 대상 그대로, 저널이 남는다.
3. adopt 저널이 남은 채 원본이 사용 중 → `UserdataMergeError`, 서버 시작 함수가 실패한다.
4. 원본 V1만, 대상 비어 있음 → adopt 결과에 V1 스레드가 V2로 보인다. 원본 `state.sqlite`의 바이트는 그대로다.
5. 대상 V1만 → merge(adopt 아님). 대상의 V1 스레드와 `environment-id`가 남는다.
6. 원본이 더 새 스키마 → `skipped: source-too-new`, 대상이 비어 있어도 들이지 않는다.
7. 서로 다른 프로젝트와 스레드 → merge. 양쪽이 프로젝션에 다 있고, 전역 `sequence`는 겹치지 않고, 원본 `stream_version`이 보존되고, 메타데이터 순번이 최신이다.
8. 같은 `workspace_root` 다른 id → 원본 스레드가 대상 프로젝트 아래로, 예약 작업 `project_id`도 바뀌고 `enabled = 0`.
9. 같은 프로젝트 id 다른 경로 + 새 원본 스레드와 예약 작업 → 둘 다 `skipped: project-diverged`.
10. 같은 병합 두 번 → `already-merged`. 표식을 지우고 다시 돌려도 행 수 그대로.
11. 같은 스레드 id에 다른 이벤트 → `conflicts`, 대상 스트림 그대로.
12. 원본에 holder → `source-in-use`, 아무것도 쓰지 않음.
13. 원본의 보류 효과·영수증은 대상에 생기지 않는다.
14. 원본에만 있는 provider 인스턴스를 쓰는 스레드 → 대상 `settings.json`에 인스턴스와 비밀. 비밀 복사 뒤·설정 쓰기 전에 중단 → 재실행이 설정을 더한다. 커밋 뒤 저널 쓰기 전에 중단 → 재실행이 같은 결과(행 수 그대로, 설정 더해짐). 같은 id 다른 설정 → 대상 유지, `providerConflicts`.

## 검증

```sh
cd apps/server && vp test run src/userdataMerge/UserdataMerge.test.ts src/cli/config.test.ts
```

`ProjectionMaintenance`에서 꺼낸 함수는 위 테스트 7과 기존 V2 프로젝션 테스트(사이클 P에서 `rg -l ProjectionMaintenance apps/server/src`로 고름)로 회귀를 본다.

실제 데이터 건조 실행은 복사본으로만 한다: `sqlite3 '<src>' ".backup /tmp/goat-merge-dry/..."`로 두 DB를 `/tmp/goat-merge-dry/{desktop,runtime}/userdata`에 떠서 `node apps/server/src/bin.ts userdata merge --from /tmp/goat-merge-dry/desktop/userdata --base-dir /tmp/goat-merge-dry/runtime --dry-run --json`. 실제 `~/.goat` 경로를 인자로 주지 않는다.
