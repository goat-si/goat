# 021 — L2 diff 수준 계획 (모바일 GOAT 이름 + TestFlight)

> 레인 L2 세션 `01a130d2` · 기준 origin/dev `8e1642dee` · 브랜치 `goat/mobile-rename-testflight` · 상위 [020](020_mobile_rename_testflight.md), [000](000_plan.md) B4/B5/B7

## 조사 결과

- 사용자에게 보이는 "T3 Code"는 `app.config.ts`(앱 이름, 권한 문구 4개, 위젯 설명 2개)와 Android 작성기 모듈 클립보드 라벨뿐이다. `apps/mobile/src` UI 문구에는 없다.
- 스킴 소비처: `src/App.tsx:43` 링크 접두사, `src/lib/appLinking.ts` 스킴만 있는 URL 필터 정규식, `src/widgets/AgentActivity.tsx:175` 위젯 딥링크(`t3code://`), `features/agent-awareness/androidNotifications.ts` 기본 스킴 `t3code`, Android 네이티브 `AgentNotifications.kt:130` 기본값 `t3code`, `scripts/mobile-native-client.ts`(`com.t3tools.t3code.dev`, `T3CodeDev.xcworkspace`), `scripts/mobile-showcase.ts`(`com.t3tools.t3code`, `t3code`, `T3Code.xcworkspace`/`.app`). `t3code://pair` 같은 링크를 만드는 서버·웹 코드는 없다.
- upstream 계정 값: `appleTeamId: "ARK85ZXQ4Z"`, `updates.url` + `extra.eas.projectId`(`d763fcb8…`), `owner: "pingdotgg"`, `eas.json` `submit.production.ios.ascAppId`, Clerk `relyingParty: clerk.t3.codes`(연관 도메인), Clerk 플러그인 `appleSignIn`.
- Clerk·relay·관측은 이미 환경변수에서 오고 없으면 null이다(`features/cloud/publicConfig.ts` `hasCloudPublicConfig`). 원격 푸시 등록은 relay 토큰 공급자가 없으면 등록하지 않는다(`remoteRegistration.ts`). 이 Mac과 메인 체크아웃에는 `.env`가 없다.
- 저장 키(`t3code.*`, `t3code-client.db`)는 바꾸지 않는다. 새 번들이라 어차피 새 저장소이고, 같은 번들의 개발 빌드에서 데이터를 잃지 않게 한다.
- `ios/`, `android/`는 gitignore된 prebuild 산출물이다. Xcode 작업공간 이름은 앱 이름에서 공백을 뺀 것(GOAT, GOATPreview, GOATDev).

## 변경

1. **새 `apps/mobile/appIdentity.ts`** (RN 의존 없음, app.config·스크립트·앱 코드가 공유): 변형별 `{ appName, scheme, iosBundleIdentifier, androidPackage, xcodeName }`, `APP_SCHEMES`(goat, goat-dev, goat-preview), `PRODUCTION_SCHEME = "goat"`, `DEFAULT_IOS_TEAM_ID = "U9ATA49N28"`, `isSchemeOnlyUrl(url)`.
2. **`app.config.ts`**: VARIANT_CONFIG의 이름·스킴·번들·패키지를 appIdentity에서. 권한·위젯 문구 "GOAT". `appleTeamId: repoEnv.GOAT_IOS_TEAM_ID ?? DEFAULT_IOS_TEAM_ID`. Clerk 키가 있을 때만 `associatedDomains`와 `appleSignIn`(`hasClerk = Boolean(EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY)`). EAS: `GOAT_MOBILE_EAS_PROJECT_ID`가 있을 때만 `updates.url`, `extra.eas.projectId`, `owner`(`GOAT_MOBILE_EAS_OWNER`); 없으면 `updates.enabled: false`이고 url·projectId·owner를 넣지 않는다. `ios.buildNumber`/`android.versionCode`는 `GOAT_MOBILE_BUILD_NUMBER`가 있을 때만. slug `goat`.
3. **`eas.json`**: `submit.production.ios.ascAppId` 제거(사용자 앱 id가 생기면 다시 넣는다).
4. **링크**: `App.tsx` 접두사 = `[Linking.createURL("/"), ...APP_SCHEMES.map(s => s + "://")]`. `appLinking.ts`는 `isSchemeOnlyUrl` 사용. `AgentActivity.tsx`는 `${PRODUCTION_SCHEME}://`. `androidNotifications.ts` 기본값 `PRODUCTION_SCHEME`. Kotlin `AgentNotifications.kt` 기본값 `"goat"`, 그 테스트의 `t3code-dev://` 기대값을 `goat-dev://`로. 관련 TS 테스트(appLinking, AgentActivity, SubscriptionUsage.android, pairing) 기대값 갱신.
5. **Android 작성기 클립 라벨** "T3 Code" → "GOAT".
6. **스크립트**: `mobile-native-client.ts`, `mobile-showcase.ts`가 appIdentity에서 번들·패키지·스킴·Xcode 이름을 읽는다.
7. **새 `scripts/mobile-testflight.ts`** (plain Node): 인자 `--variant production|preview`(기본 production), `--build-number <n>`(기본 UTC `yyMMddHHmm`), `--simulator`(서명 없이 시뮬레이터 Release 빌드만), `--export-only`(업로드 없이 IPA), `--dry-run`(명령만 출력). 순서: 인증 사전 확인(`ASC_KEY_PATH`/`ASC_KEY_ID`/`ASC_ISSUER_ID` 셋 다 있으면 API 키, 아니면 Xcode 계정 목록 `defaults read com.apple.dt.Xcode DVTDeveloperAccountManagerAppleIDLists`가 비어 있지 않아야 함; `--simulator`·`--dry-run`은 생략) → `APP_VARIANT=<v> GOAT_MOBILE_BUILD_NUMBER=<n> EXPO_NO_GIT_STATUS=1 vp exec expo prebuild --clean --platform ios`(pod install 포함) → `xcodebuild archive -workspace ios/<Xcode>.xcworkspace -scheme <Xcode> -configuration Release -destination generic/platform=iOS -archivePath <out>/<Xcode>.xcarchive -allowProvisioningUpdates DEVELOPMENT_TEAM=<team> CODE_SIGN_STYLE=Automatic CURRENT_PROJECT_VERSION=<n>` → ExportOptions.plist(`method app-store-connect`, `destination upload|export`, `teamID`, `signingStyle automatic`) → `xcodebuild -exportArchive ... -allowProvisioningUpdates`. 출력은 `apps/mobile/.testflight/<n>/`(gitignore). 비밀값은 인자로 경로만 넘기고 출력하지 않는다. 실패 시 App Store Connect 앱 레코드가 없을 가능성을 안내.
8. **`apps/mobile/package.json`**: `dev:client*`·`showcase`의 `--scheme t3code*`를 goat*로, `testflight`/`ios:simulator-release` 스크립트 추가.
9. **문서**: `docs/operations/mobile-testflight.md`(Xcode 로그인 또는 API 키, ASC 앱 레코드 `si.goat.mobile` 만들기, 명령), `apps/mobile/README.md` 이름·번들·스킴 갱신, `docs/operations/android-notifications.md`의 `T3CODE_MOBILE_UPDATES_ENABLED` 문장을 새 EAS 스위치로 고침.

## 검증

- `APP_VARIANT={production,preview,development} vp exec expo config --json --type public`(apps/mobile)에서 name, scheme, bundleIdentifier, package, appleTeamId, owner 없음, updates.enabled false 확인.
- `vp test run` 바뀐 테스트 파일들(apps/mobile 패키지 기준), `scripts/mobile-native-client.test.ts`·`mobile-showcase.test.ts`가 있으면 함께.
- mobile `tsc --noEmit`, 바뀐 파일 `vp lint`, `vp fmt --check`.
- `node scripts/mobile-testflight.ts --simulator` exit 0(prebuild + 시뮬레이터 Release 빌드).
- 업로드: Xcode 계정이 보이면 `node scripts/mobile-testflight.ts`; 없으면 NEEDS_HUMAN.

## 위험

- 위젯·공유 확장·앱 그룹·푸시·Sign in with Apple 기능은 자동 서명이 App ID에 켜야 한다. Clerk 키가 없으면 Sign in with Apple과 연관 도메인을 빼서 필요한 기능을 줄인다.
- 시뮬레이터 런타임이 설치돼 있지 않아 앱 실행 확인은 못 하고 빌드까지만 확인한다.
- Kotlin 테스트는 Android prebuild와 JDK 21이 필요해 이 레인에서는 실행하지 않는다(기대값만 갱신).

## 감사 1차 반영 (gpt-6.1-sol, FAIL)

- **환경 유지**: 스크립트는 `APP_VARIANT`, `GOAT_MOBILE_BUILD_NUMBER`, `EXPO_NO_GIT_STATUS`를 한 번 정해 prebuild, `xcodebuild archive`, `-exportArchive` 모든 하위 프로세스에 같은 환경으로 넘긴다(Xcode 빌드 단계가 `expo-constants`/`expo-updates`로 설정을 다시 평가하기 때문). 업로드 전 아카이브 안 `EXConstants.bundle/app.config`의 name·bundle을 확인하고, 앱·위젯·공유 확장 Info.plist의 CFBundleVersion이 모두 같은지 확인한다.
- **빌드 번호**: 기본값은 `floor(Date.now()/60000)`(에포크 기준 분, 약 2,980만, 단조 증가, Android 한도 21억 이하). `--build-number`는 양의 정수만 받는다. `ios.buildNumber`만 설정하고 `android.versionCode`는 이 레인에서 건드리지 않는다. ExportOptions에 `manageAppVersionAndBuildNumber = false`. 위젯은 prebuild 시 번호를 그대로 굽으므로 prebuild에 번호를 넘기는 것이 필수다.
- **Clerk 도메인**: VARIANT_CONFIG에서 `relyingParty`(clerk.t3.codes)를 뺀다. 연관 도메인은 `GOAT_MOBILE_CLERK_DOMAIN`이 있을 때만, Sign in with Apple은 Clerk 키가 있을 때만.
- **EAS 업데이트 끄기 스위치**: `T3CODE_MOBILE_UPDATES_ENABLED`를 `GOAT_MOBILE_UPDATES_ENABLED`로 옮기고 `eas.json` v2-preview도 같이 바꾼다. 업데이트는 프로젝트 id가 있고 이 값이 "0"이 아닐 때만 켜진다.
- **범위 밖 보고**: `apps/web/src/components/NightlyMobileBeta.tsx`가 upstream TestFlight/Play 링크를 광고한다. 웹 소유라 이 레인은 고치지 않고 조정자에게 보고한다.
- 인증: API 키를 쓰면 `-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID` 셋을 archive와 export 둘 다에 넘긴다.
