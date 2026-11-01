# 020 — L2 모바일 GOAT 이름 변경 + TestFlight

[000](000_plan.md) B4-B5.

## 현재

- `apps/mobile/app.config.ts` VARIANT_CONFIG: "T3 Code"(Dev/Preview), 스킴 t3code*, 번들 `com.t3tools.t3code*`, relyingParty clerk.t3.codes, 위젯·공유 확장 번들은 앱 번들에서 파생.
- `eas.json` submit ascAppId 6787819824(upstream 계정). EAS/ASC 인증은 이 Mac에 없다. Xcode 27 설치됨, 서명 인증서는 Developer ID Application(U9ATA49N28)만 있다.
- 데스크톱은 이미 GOAT(`si.goat.desktop`).

## 할 일

1. VARIANT_CONFIG를 GOAT / `si.goat.mobile*` / goat* 스킴으로. 위젯·앱 그룹·공유 확장·딥링크·알림 문구 등 파생 식별자 확인. 브랜드 자산은 데스크톱 GOAT 자산이 있으면 그것을 쓰고, 없으면 그대로 둔다(아이콘 교체는 범위 밖으로 기록).
2. 모바일 사용자 문구의 "T3 Code"를 GOAT로(위젯 설명 포함). 내부 패키지명 `@t3tools/*`는 그대로.
3. upstream 계정 의존(eas projectId/owner, ascAppId, updates URL, Clerk 연관 도메인)을 찾아 사용자 계정에서 깨지지 않게 끄거나 환경변수로 뺀다. 결정은 이 문서에 기록.
4. `scripts/mobile-testflight.ts`(또는 같은 역할): prebuild → `xcodebuild archive`(Release, 팀 U9ATA49N28, 자동 서명, `-allowProvisioningUpdates`) → ExportOptions(method app-store-connect, destination upload) → `-exportArchive`. 인증은 `ASC_KEY_PATH`/`ASC_KEY_ID`/`ASC_ISSUER_ID` 환경변수가 있으면 `-authenticationKey*`로, 없으면 Xcode 계정. 빌드 번호 자동 증가.
5. 인증 없이 가능한 검증: `APP_VARIANT=production expo config --json`로 이름·번들 확인, 시뮬레이터용 Release 빌드(`-sdk iphonesimulator CODE_SIGNING_ALLOWED=NO`) 성공. 업로드 단계는 사용자 인증이 오면 조정자가 실행한다.
6. `docs/operations/`에 TestFlight 절차(인증 준비 포함) 짧게.

## 검증

expo config 출력, 시뮬레이터 빌드 로그 끝부분과 exit 0, 스크립트 dry-run(인증 없음 → 정확한 안내로 종료), 변경 파일 lint/typecheck(mobile).

## 감사 반영 (P1-4, P2-5)

- 팀: `app.config.ts`의 upstream Apple 팀 고정값(258행 근처)을 U9ATA49N28로(환경변수로 덮을 수 있게). 위젯·공유 확장·앱 그룹 `group.si.goat.mobile*`가 같은 팀 자동 서명으로 프로비저닝되는지 확인.
- 푸시: 원격 푸시 등록(`features/agent-awareness/remoteRegistration.ts`)과 relay APNs/FCM 자격은 upstream 소유다. GOAT 빌드는 기본으로 원격 푸시 등록을 끄고(환경변수로 켬), 로컬 알림·Live Activity는 유지 가능한지 판단해 기록한다.
- 인증: Clerk(`clerk.t3.codes` 연관 도메인), Google 클라이언트 id, Sign in with Apple, EAS updates URL·projectId·owner는 소유한 값이 없으면 기본으로 끈다(T3 Connect 클라우드 기능 숨김). 직접 페어링 연결은 그대로 동작해야 한다.
- 스킴 소비처: `src/App.tsx` 링크 접두사, `src/widgets/AgentActivity.tsx` 딥링크, `scripts/mobile-native-client.ts`, 링크 필터와 그 테스트. 스킴·번들은 VARIANT_CONFIG 한 곳에서 파생.
- 파일 소유는 000 B7. `features/goat-bot`과 홈 내비게이션은 L3 소유.
