import { guide, LINKS } from "../lib/links";
import type { Messages } from "./en";

export const ko: Messages = {
  htmlLang: "ko",
  ogLocale: "ko_KR",
  languageName: "한국어",
  switchLabel: "English",
  switchAria: "이 페이지를 영어로 보기",
  skip: "본문으로 건너뛰기",
  nav: {
    label: "주요 메뉴",
    home: "GOAT 홈",
    download: "다운로드",
    guides: "가이드",
    github: "GitHub",
  },
  meta: {
    homeTitle: "GOAT: 내 모든 머신에서 돌아가는 코딩 에이전트",
    homeDescription:
      "GOAT는 Claude Code, Codex, Cursor 같은 코딩 에이전트를 노트북, 집에 있는 데스크톱, SSH 서버, 클라우드 머신에서 실행하고, 데스크톱 앱이나 브라우저, 휴대폰에서 한곳에서 조종하게 해 줘요. MIT 라이선스 오픈 소스예요.",
    downloadTitle: "GOAT 다운로드",
    downloadDescription:
      "macOS, Windows, Linux용 GOAT 데스크톱 앱을 내려받거나 goat 명령과 서버 전용 머신을 설치하세요.",
    legalTitle: "법적 고지",
    legalDescription:
      "GOAT Connect 초대제 베타의 개인정보처리방침, 약관, 보안 신고와 웹사이트·제품 사용 데이터 처리를 안내해요.",
    privacyTitle: "개인정보처리방침",
    termsTitle: "이용 약관",
    securityTitle: "보안",
    ogAlt: "GOAT: 내 모든 머신에서 돌아가는 코딩 에이전트.",
  },
  home: {
    title: "내 모든 머신에서, 내 코딩 에이전트를.",
    lede: "GOAT는 이미 쓰고 있는 Claude Code, Codex, Cursor 같은 에이전트를 노트북, 집 데스크톱, SSH 서버, 클라우드 머신에서 실행해요. 그리고 데스크톱 앱, 브라우저, 휴대폰 어디서든 전부 조종할 수 있어요.",
    primary: "GOAT 다운로드",
    secondary: "가이드 읽기",
    note: "MIT 라이선스로 무료 공개된 오픈 소스예요. macOS, Windows, Linux에서 쓸 수 있어요.",
    captureAlt:
      "trailhead라는 데모 프로젝트의 스레드를 띄운 GOAT 앱. Codex가 elevationGainM 헬퍼를 추가했고, 답변에는 npm test 6개 통과가, 옆 diff 패널에는 src/format.ts 변경이 보여요.",
    captureCaption: "데모 프로젝트예요. 요청과 답변, diff는 GOAT에서 실제로 실행한 Codex 결과예요.",
    machines: {
      title: "머신마다 하나의 환경",
      body: "작업하는 머신마다 GOAT 서버가 돌아가요. 그 서버와 서버가 가진 상태(프로젝트, 스레드, 프로바이더 로그인, 메모리)를 합쳐 환경이라고 불러요. 데스크톱 앱, 브라우저, 휴대폰은 원하는 만큼 여러 환경에 연결할 수 있고, 환경끼리도 서로 닿을 수 있어요.",
      points: [
        {
          title: "SSH 호스트",
          body: "Settings → Connections에서 호스트를 추가하면 처음 쓸 때 호스트가 직접 GOAT 런타임을 내려받아요. Boat 클라우드 머신도 다른 SSH 호스트와 똑같이 동작해요.",
        },
        {
          title: "연결된 GOAT 서버",
          body: "이미 운영 중인 GOAT 서버를 페어링 링크로 연결하면, 에이전트가 그 서버에서 스레드를 시작하고 읽고 메시지를 보낼 수 있어요.",
        },
        {
          title: "WSL",
          body: "Windows에서는 WSL 배포판이 자체 환경을 갖고, 그 안에 설치한 프로바이더 CLI를 써요.",
        },
        {
          title: "다른 화면들",
          body: "휴대폰이나 다른 브라우저를 직접, 같은 로컬 네트워크에서, 또는 Tailscale로 페어링하세요.",
        },
      ],
      guide: "원격 접속 가이드",
      guideHref: guide("remote-access"),
      diagram: {
        label: "GOAT가 화면과 머신을 연결하는 방식",
        clients: "내 화면",
        clientItems: ["데스크톱 앱", "브라우저", "휴대폰"],
        environment: "GOAT 환경",
        environmentNote: "내 머신 위",
        environmentItems: ["프로젝트", "스레드", "프로바이더", "GOAT Bot", "메모리"],
        reaches: "연결 대상",
        reachItems: ["SSH 호스트", "연결된 GOAT 서버", "WSL 배포판", "Boat 클라우드 머신"],
      },
    },
    flow: {
      title: "한 머신에서 시작해 다른 머신에서 마무리",
      lede: "GOAT의 에이전트는 머신을 넘나들고, 내 작업도 함께 움직여요.",
      phoneAlt:
        "휴대폰 크기 브라우저에서 연 같은 스레드: 요청, npm test 6개 통과를 알리는 답변, 바뀐 파일 목록.",
      steps: [
        {
          title: "노트북에서 스레드 시작",
          body: "프로젝트와 프로바이더를 고르세요. 에이전트가 로컬 Git 체크아웃에서 일하면 턴마다 체크포인트가 남아서, 무엇이 바뀌었는지 정확히 확인하고 되돌릴 수 있어요.",
        },
        {
          title: "더 큰 머신으로 옮기기",
          body: "커밋하지 않은 변경까지 그대로 SSH 호스트로 스레드를 옮기거나, 에이전트가 그곳에서 스레드나 워크트리를 시작하고 결과를 기다리게 하세요.",
        },
        {
          title: "어디서든 이어 보기",
          body: "그 환경과 페어링한 휴대폰이나 다른 브라우저에서 같은 스레드를 열고, 에이전트가 기다릴 때 답하세요.",
        },
        {
          title: "브랜치 가져오기",
          body: "SSH 워크트리의 브랜치를 이 기기의 저장소로 가져와요. 지금 체크아웃한 브랜치와 작업 파일은 그대로예요.",
        },
      ],
    },
    agents: {
      title: "이미 쓰는 에이전트 그대로",
      lede: "GOAT는 작업할 머신에 이미 로그인해 둔 각 프로바이더의 에이전트를 그대로 실행해요.",
      localLabel: "내 머신에서",
      local: [
        "Claude Code",
        "Codex",
        "Cursor",
        "Grok Build",
        "OpenCode",
        "Antigravity",
        "Pi",
        "Muse Code",
        "ACP 에이전트",
      ],
      cloudLabel: "벤더 클라우드에서",
      cloud: ["Claude Cloud", "Cursor Cloud", "Devin Cloud"],
      guide: "프로바이더 설정하기",
      guideHref: guide("install", "providers"),
    },
    features: {
      title: "GOAT가 더하는 것",
      readGuide: "가이드 읽기",
      items: [
        {
          title: "GOAT Bot",
          body: "프로젝트에 묶이지 않은 상시 대화 창이에요. 일을 부탁하면 알맞은 프로젝트와 머신에 코딩 스레드를 시작하고 결과를 알려 줘요. Slack에서도 답하고, 서버가 Mac에서 돌면 iMessage로도 답해요.",
          href: guide("slack"),
        },
        {
          title: "Fleet",
          body: "연결된 모든 머신과 그 위에서 일하는 에이전트를 한 화면에서 보고, 실행 중이거나 나를 기다리는 스레드 수를 확인해요. Fleet 목표는 정한 조건이 충족될 때까지 작업자를 계속 띄워요.",
          href: guide("fleet-goals"),
        },
        {
          title: "메모리",
          body: "끝난 대화가 전체 프로젝트, 한 프로젝트, 한 스레드 범위의 메모리가 돼요. Codex, Claude, OMO의 메모리를 가져오고, 허브를 통해 기기끼리 공유할 수 있어요.",
          href: guide("memory"),
        },
        {
          title: "오케스트레이션 도구",
          body: "GOAT MCP 서버는 에이전트에게 스레드를 띄우고 지켜보고, 시작한 스레드에 결과를 보고하는 도구를 줘요. Claude Code, Codex, ChatGPT 같은 외부 에이전트도 같은 서버에 연결할 수 있어요.",
          href: guide("outside-agents"),
        },
        {
          title: "컴퓨터, 브라우저, 기기",
          body: "에이전트가 GOAT를 실행하는 컴퓨터의 앱을 내 커서를 뺏지 않고 써요. 데스크톱 앱에는 스레드마다 브라우저 패널이 있고, Device 패널에서는 에이전트가 다루는 iOS 시뮬레이터나 Android 에뮬레이터를 볼 수 있어요.",
          href: guide("computer-use"),
        },
        {
          title: "소스 관리와 풀 리퀘스트",
          body: "저장소를 클론하고 게시하고, 풀 리퀘스트를 열고, 턴마다 바뀐 내용만 리뷰해요. GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps, GitCafe를 지원해요.",
          href: guide("source-control"),
        },
        {
          title: "시각적 답변",
          body: "차트나 표, 다이어그램을 부탁하면 에이전트가 스레드 안에 샌드박스 페이지로 답해요. 모든 프로바이더에서, 웹과 데스크톱, 모바일 모두에서 동작해요.",
          href: guide("html-renders"),
        },
      ],
    },
    openSource: {
      title: "공개적으로 만드는 오픈 소스",
      body: "GOAT는 MIT 라이선스로 공개 저장소에서 개발하고, 작업은 GitHub 이슈와 풀 리퀘스트로 추적해요. T3 Code의 포크로 시작해 이벤트 소싱 코어를 그대로 쓰고, 지금도 업스트림 변경을 합치고 있어요.",
      links: [
        { label: "GitHub 소스", href: LINKS.repository },
        { label: "기여하기", href: LINKS.contributing },
        { label: "GOAT의 구조", href: LINKS.structure },
      ],
    },
  },
  install: {
    title: "GOAT 설치",
    lede: "데스크톱 앱은 스스로 업데이트해요. goat 설치 스크립트는 GOAT_CHANNEL=stable을 설정하지 않으면 Nightly 빌드를 따라가요.",
    desktopTitle: "데스크톱 앱",
    desktopBody:
      "macOS, Windows, Linux용이에요. 서버와 goat 명령이 함께 들어 있어서, 다른 화면이 연결할 환경을 직접 띄울 수도 있어요.",
    desktopCta: "다운로드 고르기",
    cliTitle: "goat 명령",
    cliBody:
      "서버를 시작하고 웹 앱을 열어요. Windows에서는 두 번째 줄을 PowerShell에서 실행하세요.",
    serverTitle: "서버 전용 머신",
    serverBody:
      "다른 기기에서 접속하는 VPS나 남는 Mac에 쓰세요. 서버를 백그라운드 서비스로 설치하고 페어링 링크를 출력해요.",
    copyHint: "명령을 선택해서 복사하세요.",
  },
  download: {
    title: "GOAT 다운로드",
    lede: "모든 빌드는 GitHub의 goat-si/goat-releases 저장소에서 받아요. 데스크톱 앱은 스스로 업데이트해요.",
    checking: "GitHub에서 최신 빌드를 찾고 있어요.",
    stable: "최신 안정 릴리스: {tag}, {date} 공개.",
    nightly: "아직 안정 릴리스가 없어서 최신 Nightly 빌드로 연결해요: {tag}, {date} 공개.",
    failed: "GitHub에 연결하지 못해서 릴리스 페이지로 연결해요.",
    platforms: [
      {
        name: "macOS",
        builds: [
          { label: "Apple 실리콘", file: ".dmg", pattern: "-arm64\\.dmg$" },
          { label: "Intel", file: ".dmg", pattern: "-x64\\.dmg$" },
        ],
        note: "Intel Mac에서는 데스크톱 앱을 쓸 수 있지만 goat 명령은 제공되지 않아요.",
      },
      {
        name: "Windows",
        builds: [
          { label: "x64", file: ".exe", pattern: "-x64\\.exe$" },
          { label: "ARM64", file: ".exe", pattern: "-arm64\\.exe$" },
        ],
        note: "",
      },
      {
        name: "Linux",
        builds: [
          { label: "x86_64", file: "AppImage", pattern: "-x86_64\\.AppImage$" },
          { label: "ARM64", file: "AppImage", pattern: "-arm64\\.AppImage$" },
          { label: "Debian·Ubuntu amd64", file: ".deb", pattern: "-amd64\\.deb$" },
          { label: "Debian·Ubuntu arm64", file: ".deb", pattern: "-arm64\\.deb$" },
        ],
        note: ".deb는 sudo apt install ./<file>.deb로 설치하세요. 업데이트할 때마다 비밀번호를 물어봐요.",
      },
    ],
    mobileTitle: "휴대폰과 태블릿",
    mobileBody:
      "iPhone, iPad, Android용 GOAT 앱은 개발 중이고 아직 App Store와 Google Play에 없어요. iPhone과 iPad 빌드는 지금은 초대 전용인 TestFlight로 받거나 소스에서 직접 빌드할 수 있어요. 그전까지는 휴대폰 브라우저를 환경과 페어링해서 쓰세요.",
    mobileWarning:
      "스토어에 있는 T3 Code 앱은 GOAT가 포크한 원래 프로젝트의 앱이에요. GOAT가 아니고 GOAT 서버에 연결할 수 없어요.",
    mobileGuide: "모바일 앱 가이드",
    mobileGuideHref: guide("install", "mobile-app"),
    allBuilds: "모든 빌드와 체크섬",
    nightlyBuilds: "Nightly 빌드",
    installGuide: "설치 가이드",
    installGuideHref: guide("install"),
  },
  legal: {
    title: "법적 고지",
    lede: "최대 50명만 초대하는 GOAT Connect 베타의 정책이에요.",
    updated: "2026년 10월 28일 개정",
    operatorTitle: "운영자와 연락처",
    operator:
      "GOAT Connect 운영자는 김병준 (Kim Byungjun)이며, 보안 사고 대응도 담당해요. 개인정보 열람·정정, 계정 삭제, 지원 요청이나 악용 신고는 아래 이메일로 보내 주세요.",
    policyLinks: "베타 정책",
    privacy: {
      lede: "최대 50명만 초대하는 GOAT Connect 베타가 개인정보를 처리하는 방법이에요.",
      sections: [
        {
          id: "scope",
          title: "이 방침의 범위",
          paragraphs: [
            "이 방침은 호스팅되는 GOAT Connect 서비스와 이 마케팅 웹사이트에 적용돼요. Connect는 선택 기능이에요. 자신의 머신에서 GOAT를 실행하는 것만으로 프로젝트나 대화가 Connect에 업로드되지는 않아요. 코딩 에이전트 프로바이더의 데이터 처리에는 각 업체의 정책이 적용돼요.",
          ],
        },
        {
          id: "account",
          title: "로그인과 계정 정보",
          paragraphs: [
            "Clerk가 Connect 로그인, 계정 식별자, 이메일 주소, 직접 제공한 프로필 정보와 인증 정보를 처리해요. relay는 Clerk 자격을 검증하고 계정 식별자로 기기와 환경을 연결해요. 로그인 서비스는 세션 자격을 사용하며 쿠키를 사용할 수 있어요. 정적 마케팅 웹사이트는 쿠키를 저장하지 않아요.",
          ],
        },
        {
          id: "connections",
          title: "환경과 기기 기록",
          paragraphs: [
            "머신을 연결하고 접속 경로를 제공하기 위해 relay는 계정·환경 식별자, 라벨, 공개키, 엔드포인트 URL, 터널·DNS 할당 정보, 터널의 로컬 연결 대상, 링크 설정과 시각을 저장해요. 환경 자격의 해시, 철회 기록, 재전송 공격 방지를 위한 단기 증명 식별자도 저장해요.",
            "모바일 알림에는 기기 식별자와 라벨, 플랫폼·OS 버전, 앱 버전과 번들 식별자, 알림 설정, APNs 또는 FCM 푸시 토큰이 쓰여요. 제공된 경우 iOS Live Activity 토큰도 저장해요. 이 토큰으로 기기에 업데이트를 전달해요.",
          ],
        },
        {
          id: "activity",
          title: "활동 업데이트와 푸시 알림",
          paragraphs: [
            "relay는 환경·스레드 식별자, 프로젝트·스레드 제목, 모델 이름, 상태, 요약 문구, 선택적인 상세 문구, 시각과 스레드로 돌아가는 링크를 처리해요. 제목과 상태 문구에는 작업 정보가 들어갈 수 있어요. 업데이트와 알림 내용은 전달 큐에 보관될 수 있고, 기기와 설정에 따라 Apple APNs 또는 Google FCM으로 전송돼요.",
            "전달 기록에는 계정·환경·스레드·기기 식별자, 전달 결과, 오류와 토큰 끝부분이 들어가요. 알림 내용은 잠금 화면에 표시될 수 있어요. 설정에서 알림이나 Live Activities를 끌 수 있어요.",
          ],
        },
        {
          id: "traffic",
          title: "터널 트래픽과 선택적인 웹훅 보관",
          paragraphs: [
            "Cloudflare가 관리형 터널을 제공하고 IP 주소와 요청 메타데이터를 포함한 네트워크 요청을 처리해요. 접속 초기 절차가 끝나면 일반 HTTP·WebSocket 앱 트래픽은 relay Worker 대신 Cloudflare를 거쳐 환경으로 가요. Cloudflare에서 HTTPS가 종료되므로 인프라 제공자에게도 앱 내용을 숨기는 종단 간 암호화는 아니에요. relay는 신뢰를 전제로 접속을 중개하는 서비스예요.",
            "자동화 웹훅은 relay가 전달해요. 기본 설정에서는 웹훅 요청을 영구 저장하지 않아요. 오프라인 중 웹훅 보관을 켜면 재전달을 위해 Cloudflare Durable Object에 본문, 헤더, 쿼리, 훅 토큰을 포함한 원시 요청을 저장해요. 필요하지 않은 비밀이나 개인정보는 웹훅에 넣지 마세요.",
          ],
        },
        {
          id: "providers",
          title: "처리 목적, 서비스 제공자와 진단 정보",
          paragraphs: [
            "이 정보는 인증, 머신 연결, 알림·웹훅 전달, 장애 진단과 서비스 보호에 쓰여요. 구성된 인프라는 인증에 Clerk, relay·터널·큐·웹훅 보관에 Cloudflare, relay 기록에 PlanetScale Postgres, 진단에 Axiom, iOS 전달에 Apple APNs, Android 전달에 Google FCM을 사용해요.",
            "relay 요청과 GOAT 클라이언트 진단에는 Axiom 추적이 구성돼 있어요. 추적에는 식별자, 요청 메서드·경로, 응답 상태, 소요 시간과 오류가 들어갈 수 있어요. 웹훅 전달 경로는 추적에서 훅 토큰을 가리고 웹훅 본문을 첨부하지 않아요. GOAT 제품 사용 통계를 꺼도 Connect 운영 진단은 꺼지지 않아요.",
            "이 업체들은 거주 국가 밖에서 데이터를 처리할 수 있어요. 현재 relay 데이터베이스 구성은 PlanetScale의 미국 서부 리전을 선택해요. 다른 처리 위치와 업체별 보존 기간은 서비스와 배포에 따라 달라지며, 이 방침은 국내에만 데이터를 보관한다고 약속하지 않아요.",
          ],
        },
        {
          id: "retention",
          title: "보관 기간과 현재의 한계",
          paragraphs: [
            "보관 웹훅은 환경의 응답을 받은 뒤, 24시간이 지난 뒤, 또는 환경에 연결된 사용자가 아무도 남지 않았을 때 삭제돼요. 만료 처리는 백그라운드 작업이 하므로 장애가 있으면 늦어질 수 있어요. 유지보수 작업은 만료된 재전송 방지 증명과 종료 상태가 된 지 30분이 지난 활동 행도 지워요. Axiom 추적 데이터셋은 30일 보존으로 설정돼 있어요.",
            "현재 relay에는 전달 시도, 철회된 자격, 종료되지 않은 활동 등 여러 기록의 자동 만료가 없어요. 환경 연결 해제는 링크를 철회하고 터널 정리를 시도하지만 계정 전체 삭제는 아니에요. Connect 데이터 전체나 업체 백업의 자동 삭제 기한은 보장할 수 없어요.",
          ],
        },
        {
          id: "rights",
          title: "열람·정정과 계정 삭제 요청",
          paragraphs: [
            "개인정보 열람·정정, Connect 이용 중단, Connect 계정과 관련 호스팅 데이터 삭제를 원하면 위 연락처로 이메일을 보내 주세요. 계정 이메일로 요청 내용을 알려 주시되 비밀번호, 인증 코드나 푸시 토큰은 보내지 마세요. 계정 소유 여부를 확인할 수 있어요.",
            "현재 베타 구현에는 계정 전체를 직접 삭제하는 기능이 없어요. 요청은 운영자가 Clerk, relay 기록, 푸시 등록, 보관 웹훅과 터널 자원을 확인하며 처리해야 해요. 로그아웃, 연결 해제 또는 Clerk 계정 삭제만으로 모든 Connect 데이터나 이미 발급된 환경 세션이 삭제·철회된다고 생각하면 안 돼요. 프로젝트 파일과 스레드 기록은 자신의 머신에 남으며 그곳에서 관리해야 해요.",
            "개인정보 관련 문의나 적용 법령에 따른 권리 행사도 같은 연락처로 보내 주세요. 방침이 바뀌면 이 페이지에 개정일과 함께 게시해요.",
          ],
        },
      ],
    },
    terms: {
      lede: "최대 50명만 초대하는 GOAT Connect 베타 이용약관이에요.",
      sections: [
        {
          id: "beta",
          title: "베타 참여와 이용",
          paragraphs: [
            "이 약관은 김병준 (Kim Byungjun)이 운영하는 호스팅 GOAT Connect 베타에 적용돼요. Connect를 이용하면 이 약관에 동의하는 것으로 봐요. 초대받은 최대 50명만 참여하며, 초대가 지속적인 접속이나 정식 출시를 보장하지는 않아요. 오픈 소스 GOAT 소프트웨어에는 자체 라이선스가 적용돼요.",
            "Connect는 로그인한 기기에서 연결된 GOAT 환경에 접속하고 알림을 받도록 해요. 소유하거나 제어 권한을 받은 머신만 연결하세요. 계정, 기기와 복구 수단을 보호하세요. 연결된 환경에 접근하면 그 머신에서 에이전트나 터미널 명령을 실행할 수 있어요.",
          ],
        },
        {
          id: "acceptable-use",
          title: "허용되는 이용",
          paragraphs: [
            "피싱, 악성코드, 무단 접근, 괴롭힘, 불법 행위 또는 다른 사용자·서비스 공격에 Connect를 쓰지 마세요. 접속 권한 재판매, 오픈 프록시 운영, 초대·제한 우회나 서비스 과부하도 금지해요. 에이전트 동작과 웹훅을 포함해 자신의 환경을 통해 보내는 내용과 행동은 이용자가 책임지며, 제3자의 권리와 서비스 약관을 지켜야 해요.",
          ],
        },
        {
          id: "availability",
          title: "가용성과 지원",
          paragraphs: [
            "실험적인 베타이며 제공 가능한 상태로 운영해요. 서비스 수준 협약(SLA), 가동 시간, 지원 응답 시간이나 알림·웹훅 도착을 보장하지 않아요. 기능, 제한과 가용성이 바뀌거나 베타가 종료될 수 있어요. 백업과 다른 머신 접속 수단을 유지하고, 응급 상황이나 안전에 중요한 작업을 Connect에 의존하지 마세요.",
            "적용 법령이 허용하는 범위에서 중단·오류 없는 서비스나 특정 목적에 적합함을 보증하지 않아요. 이 약관은 법으로 배제할 수 없는 권리나 책임을 배제하지 않아요.",
          ],
        },
        {
          id: "suspension",
          title: "접속 정지와 종료",
          paragraphs: [
            "운영자는 악용, 보안 위험, 법적 요구나 용량 문제에 대응하거나 베타를 끝내기 위해 접속을 정지·종료할 수 있어요. 긴급한 경우 사전 통지 없이 조치할 수 있어요. 정지나 로그아웃만으로 환경과 이미 직접 맺은 세션까지 끝나는 것은 아니므로, 침해가 의심되면 자신의 머신에서도 접근을 차단하세요.",
          ],
        },
        {
          id: "leaving",
          title: "이용 중단, 삭제와 문의",
          paragraphs: [
            "언제든 Connect 이용을 중단할 수 있어요. 계정 삭제는 계정 이메일에서 위 연락처로 요청하세요. 현재는 운영자의 후속 처리가 필요하며 로그아웃이나 연결 해제는 계정 전체 삭제가 아니에요. 처리하는 정보와 현재 정리의 한계는 개인정보처리방침에서 확인할 수 있어요. 호스팅된 Connect 데이터를 삭제해도 자신의 머신에 있는 프로젝트나 스레드 기록은 지워지지 않아요.",
            "지원, 악용 신고와 약관 문의도 같은 연락처로 보내 주세요. 약관이 바뀌면 이 페이지에 개정일과 함께 게시하니 베타를 계속 이용하기 전에 확인하세요.",
          ],
        },
      ],
    },
    security: {
      lede: "GOAT와 GOAT Connect 취약점은 비공개로 알려 주세요. Connect는 최대 50명만 초대하는 베타예요.",
      sections: [
        {
          id: "report",
          title: "취약점 신고 방법",
          paragraphs: [
            "위 연락처로 한국어나 영어로 이메일을 보내 주세요. 사고 대응 담당자는 김병준 (Kim Byungjun)이에요. 영향받는 구성 요소와 버전, 영향 설명, 최소한의 재현 방법을 포함해 주세요. 제목은 GOAT 보안 신고처럼 적어 주세요. 실제 자격 증명, 비공개 대화나 다른 사용자의 데이터는 넣지 마세요.",
            "평가하고 수정 일정을 조율할 수 있도록 공격 방법을 먼저 공개 이슈에 게시하지 말아 주세요. 노출된 개인정보를 발견하면 더 접근하지 말고, 보고서에 복사하는 대신 발견 위치를 설명해 주세요. 공개 시점은 함께 조율해요. 베타에는 보장된 응답·수정 기한이나 약속된 포상금이 없어요.",
          ],
        },
        {
          id: "research",
          title: "조사할 때 지켜 주세요",
          paragraphs: [
            "자신의 계정과 환경을 사용하거나 소유자의 명시적 허가를 받으세요. 다른 사람의 데이터에 접근하거나 서비스를 방해하거나 파괴적인 시험·사회공학을 하지 마세요. 이 페이지는 제3자 업체나 제어 권한이 없는 시스템의 시험을 허가하지 않아요.",
          ],
        },
        {
          id: "incident",
          title: "계정이나 환경이 위험할 때",
          paragraphs: [
            "바로 연락하고 로그인·복구 수단을 보호하며 자신의 환경에서도 영향을 받은 접근 권한을 철회하세요. Connect 로그인은 연결된 머신의 제어 권한으로 이어질 수 있어요. 로그아웃만으로 기존 환경 세션이 끝난다고 보장할 수는 없어요. 운영자가 사고 대응을 조율하며, 이 페이지는 계획된 베타 보안 통제가 모두 배포됐다고 주장하지 않아요.",
          ],
        },
      ],
    },
    siteTitle: "이 웹사이트",
    site: [
      "이 사이트는 분석 스크립트를 불러오지 않고 쿠키도 저장하지 않아요.",
      "정적 사이트예요. 호스팅 업체는 IP 주소를 포함한 요청 기록을 남길 수 있어요. 이 사이트의 미리보기를 제공하는 GitHub Pages는 보안 목적으로 기록을 남겨요.",
      "다운로드 페이지는 최신 릴리스를 찾으려고 브라우저에서 GitHub API에 요청을 보내요. 그래서 GitHub도 그 요청을 받아요.",
    ],
    githubPrivacy: "GitHub 개인정보 처리방침",
    usageTitle: "제품 사용 데이터",
    usage: [
      "GOAT 서버는 해시된 계정 또는 설치 식별자와 연결된 제품 사용 이벤트를 GOAT 자체 엔드포인트로 보내요. 엔드포인트는 이벤트를 받은 뒤 180일 안에 삭제하고 다른 곳으로 전달하지 않아요. 삭제된 이벤트는 데이터베이스 복구 백업에 최대 30일 더 남을 수 있고, 정리 작업이 멈춘 동안에는 삭제가 늦어져요. 이벤트에는 프로바이더, 모델, 권한 모드, 턴 결과, 소요 시간이 들어가요.",
      "프롬프트, 응답, 파일 내용, 인증 토큰, 대화 ID는 들어가지 않고, 엔드포인트는 IP 주소를 저장하지 않아요.",
      "끄려면 서버 환경에 GOAT_TELEMETRY_ENABLED=false를 설정하세요.",
    ],
    usageGuide: "제품 사용 데이터 가이드",
    usageGuideHref: guide("telemetry"),
    licenseTitle: "라이선스",
    license:
      "GOAT 소스 코드는 MIT 라이선스로 공개돼 있어요. 라이선스 파일에는 GOAT의 저작권 표시와 함께 원래 T3 Code의 저작권 표시가 남아 있어요.",
    licenseLink: "라이선스 읽기",
    noticesLink: "GOAT의 오픈 소스 라이선스",
    noticesHref: guide("open-source-licenses"),
  },
  accountDeletion: {
    title: "GOAT Connect 계정 삭제",
    description:
      "앱 설치나 머신 연결 없이 브라우저에서 GOAT Connect 릴레이 데이터와 로그인 계정의 영구 삭제를 요청할 수 있어요.",
    action: "계정 삭제 계속하기",
    instructions:
      "삭제할 계정으로 로그인하고 최근 10분 이내에 다중 요소 인증(MFA)을 완료한 뒤 삭제를 확인하세요. 릴레이 정리가 먼저 진행돼요. 상태를 새로고침하여 계속하고, 로그인 계정 삭제에 실패하면 같은 계정으로 돌아와 마무리하세요.",
    dataTitle: "삭제되는 데이터",
    data: [
      "릴레이 링크, 푸시 등록, 라이브 액티비티, 전송 기록, 보관된 웹훅을 영구 삭제한 다음 로그인 계정을 삭제해요. 되돌릴 수 없어요.",
      "로컬 프로젝트, 스레드 기록, 프로바이더 자격 증명과 독립적인 LAN, Tailscale, SSH 연결은 각 머신에 남아요.",
    ],
    retentionTitle: "접근 차단과 정리를 위해 남는 정보",
    retention: [
      "접근 복구를 막고 뒤늦게 생성된 터널 리소스를 찾기 위해 해시된 계정 차단 기록과 폐기된 엔드포인트 이름은 베타 동안 보관해요. 최소한의 호스트 철회 다이제스트는 각 머신이 정리를 확인할 때까지 남으며 베타 동안 만료되지 않아요. 닫힌 웹훅 수신함과 요청 제한 표시는 베타 동안 유지되고, 재전송 방지 기록은 자체 기한에 만료돼요.",
      "삭제 작업의 상태와 시각은 완료 후 90일 동안 남아요. 프로바이더 터널 정리는 이후에도 계속될 수 있어요. 큐, 프로바이더 로그, 백업에는 각 제공자의 보관 기간이 적용되며 이 절차로 해당 사본을 개별 삭제하지는 않아요. 삭제 화면은 남은 정리와 로그인 계정 삭제 상태를 구분해서 보여줘요.",
    ],
    machinesTitle: "오프라인이거나 업데이트가 필요한 머신",
    machines: [
      "지원되는 머신은 다시 연결될 때 GOAT Connect 접근 권한을 제거해요. 구버전이거나 다시 연결되지 않는 머신의 기존 로컬 세션은 업데이트하거나 로컬에서 연결을 해제할 때까지 남을 수 있어요. 삭제 화면의 정리 대기 상태는 모든 머신에서 로그아웃됐다는 뜻이 아니에요.",
      "베타가 끝날 때까지 오프라인인 머신은 로컬에서 연결을 해제하세요. 머신이나 프로바이더 정리가 확인되지 않아도 계정 삭제를 마칠 수 있어요.",
    ],
  },
  footer: {
    tagline: "MIT 라이선스. GOAT는 T3 Code의 포크로 시작했어요.",
    label: "바닥글",
    links: {
      download: "다운로드",
      guides: "가이드",
      github: "GitHub",
      releases: "릴리스",
      legal: "법적 고지",
    },
  },
};
