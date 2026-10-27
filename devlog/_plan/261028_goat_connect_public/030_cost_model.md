# 030 비용 모델

확인일 2026-10-28, USD/월, 세금 제외. 가정을 바꾸면 결과가 크게 바뀌므로 표마다 가정을 적었습니다. 실제 relay 사용량을 잰 값은 없습니다.

## 고정비

| 항목                    | 비공개 운영                             | 초대 베타                  | 공개                                      | 근거                                                                                                                                                             |
| ----------------------- | --------------------------------------- | -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloudflare Workers Paid | $5                                      | $5                         | $5 + 사용량                               | [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/), 2026-10-28 확인. Free는 요청당 CPU 10ms라서 JWT·DPoP 검증이 들어간 relay에는 빠듯함 |
| Postgres                | PlanetScale PS-5 단일 노드 $5           | PS-5 HA 약 $15             | 실측 후 결정                              | [PlanetScale 가격](https://planetscale.com/pricing), [SKU 표](https://planetscale.com/pricing.md), 2026-10-28 확인(us-east-1 기준, us-west 가격 미확인)          |
| 현재 IaC 설정(참고)     | PS_80 + 레플리카 2                      |                            |                                           | infra/relay/src/db.ts:49-55. us-east-1 기준 HA 약 $148~179(2차 출처 https://www.stackwrite.com/blog/planetscale-pricing-2026/ , 2026-10-28 확인, 1차 확인 못 함) |
| Clerk                   | Hobby $0                                | Pro $25(연간 결제 시 $20)  | Pro $25. 5만 MRU까지 포함, 이후 $0.02/MRU | [Clerk 가격](https://clerk.com/pricing), 2026-10-28 확인. 패스키·MFA는 Pro부터                                                                                   |
| Axiom                   | Personal 무료(월 500GB 수집, 30일 보관) | 무료                       | 무료 범위 확인 필요                       | [Axiom 가격](https://axiom.co/pricing), 2026-10-28 확인(웹 검색 요약, 1차 페이지 직접 확인 안 함)                                                                |
| 터널 전용 도메인        | 별도 apex 도메인 1개(등록비)            | 같음                       | 같음                                      | 하위 도메인을 별도 존으로 쓰려면 Enterprise 필요 → [subdomain setup](https://developers.cloudflare.com/dns/zone-setups/subdomain-setup/), 2026-10-28 확인        |
| Cloudflare DNS 존       | Free(신규 존 레코드 200개)              | Free 또는 Pro $25(3,500개) | 설계에 따라 다름                          | [DNS 레코드 한도](https://developers.cloudflare.com/dns/manage-dns-records/), 2026-10-28 확인                                                                    |
| Apple Developer         | $99/년(APNs, 서명)                      | 같음                       | 같음                                      | origin 확인 사실                                                                                                                                                 |
| Google Play             | 1회 $25                                 | 같음                       | 같음                                      | [Play Console 시작](https://support.google.com/googleplay/android-developer/answer/6112435/), 2026-10-28 확인(웹 검색)                                           |
| FCM                     | $0                                      | $0                         | $0                                        | origin 확인 사실                                                                                                                                                 |

비공개 운영의 월 고정비는 **약 $10**(Workers $5 + DB $5)에 연간 비용(Apple $99, 도메인)입니다. 초대 베타는 **약 $45~50**(Workers $5 + DB HA $15 + Clerk Pro $25)입니다.

## 도달 방식별 변동비

### 가정

- 사용자 1명 = GOAT 머신 1.5대(현 설계는 머신마다 터널 1개).
- relay HTTP 호출 100회/사용자/일, 푸시 20건/사용자/일, 보관 웹훅 1건/사용자/일(Cloudflare 레인 가정과 같음).
- DO relay 시나리오는 사용자 1명이 하루 2시간 앱을 열어 둔 채 에이전트를 지켜본다고 가정합니다. 그 동안 Durable Object는 깨어 있고(128MB × 초 단위 과금), 나머지 시간은 hibernation으로 과금되지 않습니다. 들어오는 WebSocket 메시지는 20개당 요청 1회로 과금되며 월 10만 개/사용자로 둡니다.
- Cloudflare의 Workers·Queues·DO 기본 사용량은 Cloudflare 레인 계산을 그대로 씁니다(10/100명 $5, 1,000명 약 $6, 1만 명 약 $32).

### 결과

| 사용자 | A. 현 설계(머신마다 터널)                    | B. 사용자당 터널 1개(허브)                       | C. DO WebSocket relay(터널 없음)              |
| ------ | -------------------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| 10     | 터널 15개, $0                                | 터널 10개, $0                                    | DO 시간 27.6만 GB-s(무료 40만 이내), $0       |
| 100    | 150개, $0. 신규 Free 존 200레코드에 근접     | 100개, $0                                        | 276만 GB-s → 초과분 백만 단위 올림 $37.50     |
| 1,000  | 1,500개 → **$2,250** + Pro 존 $25            | 1,000개 → $0(여유 0) + Pro 존 $25                | 2,765만 GB-s → **$350** + 요청 $0.60          |
| 10,000 | 15,000개 → **$63,000** + Enterprise DNS 견적 | 10,000개 → **$40,500** + 다중 존 또는 Enterprise | 2억 7,648만 GB-s → **$3,462.50** + 요청 $7.35 |

여기에 각 열 공통으로 Workers 기본 사용량과 위 고정비가 더해집니다.

계산식:

```text
A 터널 = 4.50 × max(0, ceil(1.5 × U) − 1,000)
B 터널 = 4.50 × max(0, U − 1,000)
C DO 시간(GB-s) = U × 7,200초 × 30일 × 0.128GB
C 시간 요금 = 12.50 × ceil(max(0, GB-s − 400,000) / 1,000,000)
C 요청 요금 = 0.15 × max(0, U × 100,000 / 20 − 1,000,000) / 1,000,000
```

단가 출처: [Tunnels for Platforms](https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/), [Durable Objects 가격](https://developers.cloudflare.com/durable-objects/platform/pricing/), 모두 2026-10-28 확인.

### 읽는 법

- **A와 B는 등록된 머신·사용자 수에 비례하고, C는 실제 사용 시간에 비례합니다.** 터널은 잠든 노트북도 슬롯을 차지합니다. 무료 사용자가 많은 공개 서비스에서는 이 차이가 결정적입니다.
- **B는 1,000명까지 $0입니다.** 비공개 운영과 초대 베타를 터널 비용 없이 운영할 수 있습니다. 단, 개인·preview stage의 터널도 같은 계정의 1,000개를 나눠 씁니다(infra/relay/src/previewTunnelSweep.ts:105). 운영 계정과 개발 계정을 분리해야 합니다.
- **C는 상한이 아니라 가정치입니다.** 사용 시간이 4시간이면 두 배이고, 실제로 메시지가 없을 때 잠드는지(hibernation 조건)를 측정해야 합니다. 사용자가 하루 종일 연결해 두면 사용자당 최대 약 $4.15/월(30일 × 24시간)까지 갈 수 있어, 이 경우 터널과 비슷해집니다. 유휴 연결은 클라이언트가 끊었다가 필요할 때 다시 붙는 설계가 전제입니다.
- **Cloudflare API 한도(1,200회/5분)는 A·B의 확장 속도를 묶습니다.** 신규 프로비저닝 한 번에 API 호출이 최소 6회라서 5분에 약 200건이 최대입니다(infra/relay/src/environments/ManagedEndpointProvider.ts 기준, Cloudflare 레인 계산).
- **TURN·WebRTC**는 직결이 되면 0이고 Cloudflare TURN은 월 1,000GB 무료, 이후 $0.05/GB입니다. 1만 명이 월 10GB씩 릴레이되면 $4,950입니다([Realtime 가격](https://developers.cloudflare.com/realtime/sfu/platform/pricing/), 2026-10-28 확인).

## 인증·DB 비용은 작습니다

Clerk Pro는 1만 명이어도 $25입니다(5만 MRU 포함). WorkOS AuthKit은 100만 MAU까지 무료지만 패스키에 커스텀 도메인($99/월)이 사실상 필요합니다([WorkOS 가격](https://workos.com/pricing), 2026-10-28 확인). relay DB는 1만 명 기준 기본 상태 0.3~0.7GB로 추정되며, 보존 정책이 없는 `relay_delivery_attempts`(infra/relay/src/persistence/schema.ts:167)만 정리하면 작은 SKU로 충분합니다. **비용을 결정하는 것은 인증이나 DB가 아니라 도달 방식입니다.**
