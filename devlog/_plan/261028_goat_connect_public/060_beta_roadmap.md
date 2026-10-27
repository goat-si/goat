# 060 실행 로드맵: 초대제 베타까지

2026-10-28 사용자가 000~050의 방향을 승인하고 초대제 베타까지 구현·배포·게이트 전환·머지를 요청했습니다. 같은 날 인프라 결정도 받았습니다. Cloudflare는 Pos090001 계정을 쓰고, 2단계 인증은 Aside Vault TOTP로 켭니다. Workers Paid로 올리고 Clerk·Postgres 계정은 Aside로 만듭니다. 터널용 도메인은 약 $10 수준이면 구입해도 되고, Apple·Firebase 키는 사용자가 handoff로 줍니다.

1차 독립 감사(VERDICT: FAIL, High 8, Medium 4)를 반영해 다시 썼습니다. 각 단계는 시작 전에 저장소 밖에서 diff 단위 계획을 따로 쓰고 감사를 받습니다. 이 문서는 순서와 경계만 정합니다.

## 순서

| 단계 | 내용                                                                 | 의존               | 등급      |
| ---- | -------------------------------------------------------------------- | ------------------ | --------- |
| wp0  | 이 로드맵                                                            | -                  | C0        |
| wp1  | 문서 정정(산문만)                                                    | wp0                | C0        |
| wp2  | Connect 기기의 허브 접근 동의                                        | wp0                | C4        |
| wp3  | relay 계정 상태(초대·정지)·제한·레이트 리밋                          | wp0                | C4        |
| wp4  | 계정 삭제, 사고 대응 절차                                            | wp3                | C4        |
| wp7  | 인증 강도(MFA·재인증), 로그인 진입점                                 | wp0                | C4        |
| wp5a | 인프라 준비(2FA, 결제, 도메인, Clerk, Postgres, 알림)                | wp0                | 운영      |
| wp8  | 베타 운영 준비(연락처, 처리방침·약관, security.txt, 인원, 대응 담당) | wp0                | C0 + 사람 |
| wp5b | 최종 배포 + 운영자 파일럿 빌드 검증                                  | wp1~wp4, wp7, wp5a | C4        |
| wp6  | 게이트 `true`, 릴리스 설정, 실제 클라이언트 검증, 머지               | wp5b, wp8          | C4        |

## wp1 문서 정정

산문만 고칩니다. 설정·스키마 변경은 넣지 않습니다.

- docs/operations/connect-setup.md:91-112: Android Clerk 콜백을 `clerk://si.goat.mobile.dev.callback` 등(packages/shared/src/mobileAppIdentity.ts:23-37)으로, macOS 패스키 App ID·AASA를 `si.goat.desktop`, `si.goat.desktop.nightly`(scripts/build-desktop-artifact.ts:95, :3039)로 고칩니다. 데스크톱 리디렉트 `goat://app/`, `goat-dev://app/`는 이미 맞습니다(apps/desktop/src/electron/ElectronProtocol.ts:19-30). `t3code://`는 이전 빌드 호환 항목으로 둡니다.
- docs/internals/goat-connect.md:89-110: 터널 과금 문구를 바로잡습니다(1,000개 포함, 이후 구입한 슬롯당 $4.50/월).
- docs/user/t3-connect-troubleshooting.md를 GOAT Connect 문서로 개명합니다.

DB 크기와 기본 라벨은 wp5a·wp3로 옮깁니다(IaC·스키마 변경이라 C4).

## wp2 허브 접근 동의

허브 설정에 "GOAT Connect 기기가 허브를 거쳐 다른 머신에 접근" 동의를 둡니다. 기본은 꺼짐입니다. 이것은 앞으로 연결할 Connect 기기 전체에 대한 계정 단위 상시 동의이고, 기기별 로컬 승인은 아닙니다. 표준 세션에도 `settings:write`가 있으므로, 이 설정을 독립된 기기 승인이라고 설명하지 않습니다.

계획에서 정할 것:

- 권한 경계를 하나로 둡니다. 설정 변경, mint(apps/server/src/cloud/CloudLink.ts:1629-1634), bootstrap 교환(apps/server/src/auth/EnvironmentAuth.ts:976-1007), 철회가 모두 같은 인가 세대값을 확인합니다. 그래서 끄기 직전에 발급됐지만 아직 교환하지 않은 bootstrap도 거부됩니다.
- 끌 때는 대기 중인 grant와 `cloud-connect` 세션 중 `hub:proxy`를 가진 것을 `revokeSession` 경로로 철회합니다. 그래야 열린 프록시 WebSocket이 닫힙니다(apps/server/src/hubProxy/http.ts:450-452). `hub.enabled`를 꺼도 같게 처리합니다.
- 켤 때 이미 연결된 기기가 새 토큰을 받는 경로를 둡니다(packages/client-runtime/src/authorization/service.ts:437-450의 캐시).
- 지속성 실패와 재시작 후에는 닫힌 쪽(fail-closed)으로 동작하게 합니다.
- 진입점은 웹·데스크톱 Settings → Hub, 모바일 Hub devices, MCP입니다. 강제는 서버가 합니다.

증명할 것: 켜고 끈 뒤 미교환 bootstrap 거부, 동시 mint·교환이 끄기 뒤에 살아남지 않음, 열린 프록시 WS 종료, 켠 뒤 기존 기기 승격, 재시작 후 유지.

## wp3 relay 계정 상태·제한·레이트 리밋

- **계정 상태가 기준입니다.** `relay_account_access`(allowed | suspended)를 bearer, DPoP 미들웨어(infra/relay/src/http/Api.ts:386-419), 토큰 교환(:1022-1046), 환경 bearer 경로(:353-380), 복구(:1355-1376), 활동 발행에서 모두 확인합니다.
- **정지 처리.** 정지하면 재프로비저닝을 막고 그 계정의 터널을 해제합니다. 대기 중인 푸시·웹훅 처리 규칙도 정합니다. Clerk 차단·삭제와의 동기화 방식(서명된 Clerk 이벤트 수신과 누락분 재조정, 또는 운영자 스크립트가 둘을 함께 갱신)과 전파 지연 상한을 계획에서 고릅니다. 이미 환경과 직접 맺은 세션에 대해서는 남는 지연을 문서에 적습니다.
- **터널 제한.** 기본 1로 둡니다. 사용자 단위로 안정적인 행(예: `relay_account_access`의 해당 행)을 잠그고, 같은 트랜잭션에서 개수 확인과 예약을 함께 합니다. 자원을 가진 진행 중·실패 예약은 세고, 해제된 행은 세지 않습니다. 재링크, publish-only→관리형 전환, 복구, 해제 경로를 각각 정합니다.
- **개수 상한.** 사용자당 환경 링크(publish-only 포함)와 기기 수를 제한합니다.
- **레이트 리밋.** 링크 챌린지, 링크, DPoP 교환, connect(mint)에는 Durable Object 카운터로 엄격하게 겁니다. 기기 등록과 활동 발행에는 Workers Rate Limiting을 씁니다. 초과 시 429와 `Retry-After`를 주고, 클라이언트 오류 표시도 갱신합니다.
- **스키마.** 기본 라벨 "T3 Environment"를 바꾸는 작업도 이 단계의 마이그레이션에 넣습니다.

증명할 것: 이미 발급된 DPoP·환경 bearer를 쥔 채 정지했을 때 교환·mint·복구·발행이 즉시 거부되고 터널이 해제됨, 재허용해도 철회된 신뢰가 되살아나지 않음, 동시 링크가 제한을 넘지 못함, 429.

## wp4 계정 삭제, 사고 대응

- **삭제는 단계별이고 반복 가능해야 합니다.** 순서는 다음과 같습니다. 새 작업을 먼저 막습니다. 소유한 환경·키·엔드포인트를 스냅숏합니다. 자격과 환경 쪽 cloud grant·세션을 철회합니다. 터널을 해제합니다. 소유 데이터와 보관 웹훅을 지우고 대기 중인 전달을 처리합니다. 마지막으로 Clerk를 삭제합니다. 실패하면 이어서 재시도합니다.
- **삭제 기준은 소유 관계입니다.** `user_id` 조건만으로 지우지 않습니다. 환경 자격, 활동 행처럼 `user_id`가 없는 테이블도 있습니다(schema.ts:129-164, :194-205). 최소한의 거부 표식은 의도적으로 남깁니다.
- **진입점.** 웹·데스크톱·모바일과 공개 웹 URL이 하나의 삭제 서비스를 부릅니다. Clerk 쪽에서 시작한 삭제도 같은 정리를 일으킵니다.
- **사고 대응.** mint 중지 스위치는 relay 발급·비용을 멈추는 장치로만 표시합니다. 서명 키 유출에는 별도 절차를 둡니다. 신뢰된 경로(로컬·Tailscale·SSH)로 각 환경의 링크를 끊고, 대기 grant와 cloud 세션을 철회하고, 키를 교체한 뒤 새 신뢰를 다시 설치합니다. 오프라인 호스트에 대해 즉시 막을 수 있는 것과 없는 것을 적습니다.

증명할 것: 삭제가 링크·발행과 경합하는 경우, 부분 실패 뒤 재시도, 겹치는 환경 ID를 가진 두 사용자. 사고 절차 후 옛 키로 서명한 증명이 환경에서 거부되고 옛 세션이 남지 않음.

## wp7 인증 강도와 로그인 진입점

- **MFA·패스키 필수와 재인증.** 링크·새 기기·복구 변경에는 최근 재인증을 요구합니다. 강도와 신선도 정보가 Clerk 설정에서 시작해 토큰 claim이나 서버 확인, relay DPoP 발급, CLI OAuth(코드·device grant)까지 어떻게 전달되는지 경로를 정합니다. 강제할 수 없는 흐름은 베타에서 빼거나 사용자 승인을 받습니다.
- **로그인 진입점.** 일반 `goat connect` 로그인은 호스팅 앱의 `/connect`가 필요합니다(apps/server/src/cloud/CliTokenManager.ts:508-548, apps/server/src/cloud/publicConfig.ts:108-110). GOAT 소유 호스팅 인증 앱(도메인, Clerk origin, `GOAT_HOSTED_APP_URL`)을 배포할지, 베타 CLI 경로를 device grant로 정할지 고릅니다. 페어링되지 않은 브라우저가 로그인해 허브를 찾는 경로도 정합니다.

증명할 것: MFA가 없거나 오래된 로그인은 보호 동작이 실패함, 브라우저·Electron·iOS·Android·CLI 일반·device 로그인 모두 규칙을 만족함, 캐시된 토큰이 없는 새 상태에서 확인.

## wp5a 인프라 준비

사용자 결정에 따라 Aside exec로 진행합니다.

1. Cloudflare Pos090001 계정에 2단계 인증을 켭니다(TOTP는 Aside Vault에 저장).
2. Workers Paid로 업그레이드합니다.
3. 도메인을 정합니다. relay API는 `trygoat.ai` 아래, 터널은 별도 apex(약 $10 이하 구입)에 둡니다. T3도 같은 구조(`RELAY_API_ZONE_NAME`과 `RELAY_TUNNEL_ZONE_NAME` 분리, upstream .github/workflows/deploy-relay.yml)입니다.
4. Clerk 앱(Restricted)을 만들고, JWT 템플릿 `goat-relay`, CLI OAuth 앱과 device grant를 설정하고, 네이티브 콜백을 `si.goat.*`로 맞춥니다.
5. Postgres: 지원되는 PlanetScale 작은 SKU를 확인하고 IaC를 바꿉니다(infra/relay/src/db.ts:49-55, C4). Neon을 고르면 DB 프로비저닝 코드부터 바꿔야 하므로 별도 작업으로 둡니다.
6. Axiom을 만들고 실제 알림 수신자를 정해 시험합니다.

비밀 값은 handoff로만 저장합니다.

## wp5b 최종 배포와 파일럿

wp1~wp4, wp7이 머지된 커밋을 배포합니다. 배포한 커밋·마이그레이션 버전을 기록합니다. 게이트를 켠 운영자 전용 파일럿 빌드(분리된 상태·자격)로 링크·mint, 초대·정지·제한·삭제의 부정 케이스를 실제 relay에 대해 실행합니다. Worker 롤백 절차와 스키마 호환성도 확인합니다.

## wp8 베타 운영 준비

- 운영 주체와 연락처, 개인정보처리방침·약관·보존 기간·지원 한계, security.txt와 취약점 공개 정책을 준비합니다. 마케팅 사이트에는 아직 없습니다(apps/marketing/src/i18n/en.ts:237-257).
- 베타 인원 상한, 장애·보안 대응 담당, 알림 수신 경로, 롤백 절차를 정합니다.
- Cloudflare 약관 문의는 베타 동안 진행하고, 결과는 공개 전 조건으로 둡니다.

## wp6 게이트 전환

- `packages/shared/src/goatConnect.ts:6`을 `true`로 바꿉니다.
- 런타임과 빌드를 구분합니다. 릴리스 CI는 공개 설정이 없으면 실패합니다(.github/workflows/release.yml:431-483). Electron은 게이트만으로 Clerk 브리지를 만듭니다(apps/desktop/src/app/DesktopClerk.ts:124-145). 모바일은 EAS 공개 설정이 따로입니다(apps/mobile/app.config.ts:455-464). 게이트 × 설정(완전·부분·없음·낡음) × 클라이언트(웹·Electron·모바일·서버) 표로 확인합니다.
- 베타에 푸시를 넣을지, 도달만 할지 명시합니다.
- 사용자 문서를 초대제 베타 안내로 바꿉니다(docs/user/remote-access.md:6-18 등).
- 실제 클라이언트 검증(test-goat-app, test-goat-mobile)과 서명된 데스크톱·네이티브 콜백 확인, `vp run check:changed`, goat-ci-result SUCCESS 뒤에 머지합니다.

## 계획 단계로 넘기는 잔여 항목(2차 감사 NEAR-PASS)

- R2-1(wp4): 환경이 오프라인일 때 삭제 완료의 의미를 정합니다. 서버 쪽 즉시 거부와 터널 해제, 재연결 시 철회를 재시도하는 정책, 남는 직접 접근의 한계, 사용자에게 보여 줄 정직한 완료 상태가 필요합니다. 증명에는 활성 세션, 미교환 bootstrap, 대기 중인 전달, Clerk에서 시작한 삭제, 오프라인 후 돌아온 호스트를 넣습니다.
- R2-2(wp8): 040·050의 베타 체크리스트 항목마다 담당·증거·결정(수용한 잔여 포함)을 옮겨 적습니다.
- R2-3(wp7·wp6): 인증 origin과 터널 origin, 새 자격과 남아 있는 자격·링크 상태, 구·신 호스트와 클라이언트 조합을 표에 더합니다. 최소 지원 버전 정책, EAS 공개 설정·배포 증거, 푸시·Live Activity 포함 여부도 정합니다.
