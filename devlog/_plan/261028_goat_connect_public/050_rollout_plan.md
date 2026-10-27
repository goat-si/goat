# 050 단계별 실행 계획과 사람이 준비할 것

이 문서는 순서와 범위를 정합니다. 각 작업은 별도 PR로 진행하며, 이 브랜치는 문서만 담습니다. 비용은 030, 위험 근거는 040을 따릅니다.

## 0단계: 방향 결정(코드 전에)

1. **Connect를 셋으로 나눕니다.** 계정 + 모바일 푸시, 고정 공개 URL(웹훅·게스트 링크), 어디서나 도달. 푸시는 이미 터널 없이 동작하는 "publish-only" 링크 모드가 있습니다(apps/server/src/cloud/CloudLink.ts:895, infra/relay/src/environments/EnvironmentLinker.ts:290-311). 이것을 먼저 켤 수 있습니다.
2. **관리형 터널 단위를 "사용자당 1개, 허브로"로 바꿉니다.** 기본 제한 3(infra/relay/src/environments/ManagedTunnelLimits.ts:14)을 1로 낮추고, 휴대폰은 허브 프록시로 다른 머신에 붙습니다(docs/user/remote-access.md:574-599). 그러면 1,000명까지 터널 비용이 $0입니다. 지금 Connect 세션은 표준 권한만 받아 허브 프록시가 403을 돌려주므로(apps/server/src/cloud/CloudLink.ts:1629-1634, apps/server/src/hubProxy/http.ts:183-184), 허브 소유자가 Connect 기기에 `hub:proxy`를 승인·회수·재발급하는 경로가 필요합니다. 허브 경유는 채팅 작업까지만 되며, 노드의 터미널·설정·게스트 링크·웹훅은 노드 자신의 경로를 쓰거나 베타에서 유예한다고 정합니다.
3. **공개 단계의 도달 수단은 Durable Object WebSocket relay + 종단 간 암호화와 로컬 기기 승인을 유력 후보로 준비합니다**(020 판단 3). 베타 실측으로 노드별 유료 터널·BYO 터널과 다시 비교합니다.
4. **운영 Cloudflare 계정과 개발 계정을 나눕니다.** preview stage도 같은 계정의 터널 1,000개를 나눠 씁니다(infra/relay/src/previewTunnelSweep.ts:105).

## 1단계: 나만 쓰는 비공개 운영

목표: 실제 사용량을 재고, 문서와 설정의 T3 흔적을 없애고, 운영 절차를 한 번 돌려 봅니다.

| 작업      | 내용                                                                                           | 근거                                    |
| --------- | ---------------------------------------------------------------------------------------------- | --------------------------------------- |
| 게이트    | 상수 `GOAT_CONNECT_ENABLED`를 운영자 빌드에서만 켤 수 있게(빌드 설정 또는 relay URL이 있을 때) | packages/shared/src/goatConnect.ts:6    |
| DB 크기   | IaC의 `PS_80` + 레플리카 2를 PS-5 단일 노드로                                                  | infra/relay/src/db.ts:49-55             |
| 설정 문서 | Clerk 리디렉트·Android 콜백·패스키 App ID를 `si.goat.*`로 고치고 실제 Clerk 앱에 등록          | docs/operations/connect-setup.md:75-112 |
| 문서 정정 | "유휴 터널도 과금"을 "1,000개까지 무료, 이후 $4.50/월"로                                       | docs/internals/goat-connect.md:89-110   |
| 터널 | 회수 `dry-run` → `enabled`. 직접 쓸 때는 머신마다 터널이어도 무료 구간 안 | infra/relay/.env.example:8-16 |
| 모니터 | Axiom 알림 대상 설정 후 실제 알림 수신 확인 | infra/relay/src/monitoring.ts:358-361 |
| 측정      | 사용자당 relay 요청 수, CPU ms, DB 크기, 푸시 건수                                             | 030의 가정 검증                         |

비용: 월 약 $10(Workers $5 + DB $5) + Apple $99/년 + 도메인 등록비. Clerk Hobby $0.

**사람이 준비할 것**

- Cloudflare 계정(Workers Paid 결제), 운영용·개발용 분리 여부 결정.
- 도메인 2개: 서비스용(relay API, 로그인)과 **터널 전용 별도 apex**.
- PlanetScale 조직(또는 다른 Postgres), Axiom 조직.
- Clerk 앱(Restricted 또는 Invite-only 모드), CLI OAuth 앱과 device grant 활성화 요청.
- Apple Developer 팀의 APNs 키, Firebase 프로젝트(FCM 서비스 계정).
- 비밀 값 보관 위치: Clerk secret, APNs 키, FCM 서비스 계정, Alchemy state(relay 서명 키 포함)에 접근할 수 있는 사람을 정합니다.

종료 조건: 한 달 사용, 사용량 측정값 확보, 키 교체와 DB 복구를 한 번씩 연습.

## 2단계: 초대제 베타(약 200명 이하)

목표: 남이 써도 안전하고 비용이 터널 무료 구간 안에 머무는 상태.

| 작업                                                                                      | 심각도 | 근거                                     |
| ----------------------------------------------------------------------------------------- | ------ | ---------------------------------------- |
| 허브 프록시 권한: 허브 소유자가 Connect 기기에 `hub:proxy`를 승인·회수·재발급. 수용 조건은 Connect 로그인만 한 휴대폰, 기존 세션 갱신, 철회, 연결된 노드 등록. 터널 제한 1로 변경 | 차단 | apps/server/src/cloud/CloudLink.ts:1629-1634, apps/server/src/hubProxy/http.ts:183-184, apps/server/src/hubProxy/http.test.ts:296-309 |
| 터널 제한을 원자적으로(사용자 단위 잠금, 진행 중 할당 포함) | 차단 | 040 표 |
| 사용자당 환경·기기 개수 상한                                                              | 차단   | 040 표                                   |
| 링크·DPoP 교환·mint·기기 등록·푸시 발행에 계정 단위 레이트 리밋(엄격 상한은 DO)           | 차단   | 040 표                                   |
| Clerk Pro, MFA·패스키 필수, 링크·새 기기·복구 변경에 재인증. CLI·device grant 경로도 확인 | 차단   | 040 첫 절                                |
| relay 쪽 초대·정지 목록(Clerk 설정만 믿지 않음)                                           | 차단   | docs/operations/connect-setup.md:146-152 |
| 계정 삭제: Clerk, relay 행, 푸시 등록, 보관 웹훅, 환경 세션까지. 앱 안 + 웹 URL           | 차단   | 040 표, Apple 5.1.1(v), Google 계정 삭제 |
| 서명 키 보관·mint 전체 중지 스위치·재링크 절차 문서                                       | 차단   | infra/relay/src/worker.ts:110            |
| `relay_delivery_attempts` 보존 기간                                                       | 권장   | schema.ts:167                            |
| 푸시 토큰 소유 확인                                                                       | 권장   | Devices.ts:85-102                        |
| relay 배포 CI와 롤백                                                                      | 권장   | infra/relay/README.md:118-123            |
| 사용자 문서: T3 Connect 문서 개명, 원격 접속 문서에 Connect 절                            | 권장   | docs/user/t3-connect-troubleshooting.md  |

비용: 월 약 $45~50(Workers $5 + DB HA $15 + Clerk Pro $25) + 연간 비용. 터널 비용 $0(사용자당 1개 기준 1,000명까지).

**사람이 준비할 것**

- 운영 주체(개인 또는 사업자)와 공개 연락처: 지원, 개인정보, 보안, abuse 주소.
- 개인정보처리방침, 이용약관 + 금지 행위 정책. 위탁사·국외 이전 표(Clerk, Cloudflare, PlanetScale, Axiom, Apple, Google). 가능하면 전문가 검토.
- `security.txt`와 짧은 취약점 공개 정책.
- relay와 별도 위치의 상태 페이지.
- Clerk Pro 결제.
- **Cloudflare에 GOAT Connect 형태가 약관 2.2.1(j) 프록시 제한에 해당하는지 문의.** 공개 전 답이 필요합니다.
- 베타 인원과 초대 방식, 장애·보안 대응 담당자(혼자라면 대응 공백을 공지).
- 스토어 배포를 함께 한다면 App Store 개인정보 라벨, Google Play Data safety(closed testing부터 필요).

종료 조건: 보안 사고 없음, 사용자당 실제 비용 측정, Cloudflare 답변 확보, 외부 보안 검토 범위 확정.

## 3단계: 공개

목표: 비용이 사용량에 비례하고, relay가 털려도 사용자 머신이 바로 열리지 않는 구조.

| 작업                                                                                             | 이유                                                                                              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Durable Object WebSocket relay(양쪽이 바깥으로 연결) + 페어링 키로 종단 간 암호화 | 터널 비용이 등록 머신 수에 비례하는 문제를 줄임(020, 030) |
| 로컬 기기 승인: 환경이 승인한 기기 공개키·권한을 보관, 새 기기·복구는 relay 로그인과 독립된 승인, 기존 mint 경로를 끄거나 약한 옵션으로 격리, 기존 세션 이전·철회. 서명 키만으로 만든 새 기기가 거부되는지 검증 | relay 서명 키의 마스터 키 문제는 암호화가 아니라 이 권한 변경으로 줄어듦(CloudLink.ts:1597-1634) |
| 브라우저 웹 앱 배포와 버전 호환, 브라우저·네이티브 키 보관과 최초 페어링, HTTP·WS·파일 경로 대응 | 지금 웹 자산은 환경 서버가 제공(apps/server/src/http.ts:740-758). 서명 키 유출, relay 코드 침해, 웹 자산 배포 침해를 구분해 보장 범위를 적음 |
| 새 웹훅 전달 프로토콜: 터널과 독립된 endpoint ID와 소유권, 환경 인증 fetch/ack, 재전달·순서·삭제, 발신자 응답(202 또는 동기), 기본 저장 여부 | 공개 URL에 터널이 필요 없어짐. 보관 저장소·제한·delivery ID는 재사용(infra/relay/src/hooks/HookInboxStore.ts), 조회는 터널에서 분리(HeldHooks.ts:60-100) |
| 게스트 링크를 relay 경로 위로: 무계정 게스트의 권한 전달, 만료·철회, 첨부 파일 | 지금은 환경의 Connect 주소에 묶임(docs/user/guest-links.md:9-11, apps/server/src/guest/GuestShareService.ts:313-326) |
| 관리형 터널은 유료·옵션으로 남기거나 제거                                                        | 1,000개 초과 시 $4.50/개/월                                                                       |
| relay 서명 키 교체 경로(환경이 새 키를 받는 방법)                                                | 040                                                                                               |
| 외부 보안 검토: mint 권한, 계정·환경 분리, OAuth·device 승인 피싱, 서명 키와 Cloudflare API 토큰 | 040                                                                                               |
| 남용 대응: 계정·호스트 정지, 신고 처리 절차, 터널 도메인 PSL 신청(수천 명 규모 이후)             | 040                                                                                               |
| 가입·mint·푸시·웹훅의 전체 비용 상한과 발급 중지 스위치                                          | 030                                                                                               |

비용(030 C열 가정): 1,000명 약 $400/월, 1만 명 약 $3,500/월 + 고정비. 관리형 터널을 유지하면 1만 명에서 $40,500~63,000/월.

**사람이 준비할 것**

- 무료로 둘지, 유료 단계를 둘지. 유료라면 결제 수단(Paddle은 "VPN and Proxies"가 제한 범주라 사전 확인), 사업자 등록, 환불 정책.
- GDPR 적용 판단(EU 대상 서비스인지)과 EU 대표 지정 여부.
- 외부 보안 검토 예산.
- 상시 대응 인력(최소 2명)과 SLA 문구.

## 하지 않는 것으로 정한 것

- Headscale 자체 운영, tsnet 내장, libp2p: 운영 부담이나 클라이언트 지원이 GOAT 규모에 맞지 않습니다(020).
- 지금 Clerk을 다른 인증으로 바꾸기: 비용 차이가 작고, 웹·Electron·모바일·CLI 로그인과 패스키 재등록 비용이 큽니다. 공개 후 비용이나 기능이 문제가 될 때 WorkOS나 Better Auth를 다시 봅니다.
- relay DB를 D1로 옮기기: 할당 행 잠금(`SELECT ... FOR UPDATE`) 의미를 다시 설계해야 해서, 몇 달러 절감에 비해 위험이 큽니다.
