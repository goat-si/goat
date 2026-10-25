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
      "게시된 GOAT 정책과 아직 없는 정책, 이 웹사이트가 방문을 다루는 방식, 제품 사용 데이터와 라이선스를 안내해요.",
    privacyTitle: "개인정보",
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
    lede: "게시된 것과 아직 없는 것을 있는 그대로 적었어요.",
    notPublishedTitle: "아직 게시되지 않은 정책",
    notPublished:
      "GOAT는 아직 자체 개인정보 처리방침, 이용 약관, 보안 연락처를 게시하지 않았어요. GOAT 출시 전에 이 페이지에 올라와요. 그전까지 이 사이트의 어떤 내용도 여러분과의 계약이 아니며, GOAT는 GOAT가 포크한 T3 Code를 포함해 다른 프로젝트를 위해 쓰인 정책을 자기 정책으로 쓰지 않아요.",
    siteTitle: "이 웹사이트",
    site: [
      "이 사이트는 분석 스크립트를 불러오지 않고 쿠키도 저장하지 않아요.",
      "정적 사이트예요. 호스팅 업체는 IP 주소를 포함한 요청 기록을 남길 수 있어요. 이 사이트의 미리보기를 제공하는 GitHub Pages는 보안 목적으로 기록을 남겨요.",
      "다운로드 페이지는 최신 릴리스를 찾으려고 브라우저에서 GitHub API에 요청을 보내요. 그래서 GitHub도 그 요청을 받아요.",
    ],
    githubPrivacy: "GitHub 개인정보 처리방침",
    usageTitle: "제품 사용 데이터",
    usage: [
      "GOAT 서버는 해시된 계정 또는 설치 식별자와 연결된 제품 사용 이벤트를 GOAT 자체 엔드포인트로 보내요. 엔드포인트는 이벤트를 최대 180일 동안 보관하고 다른 곳으로 전달하지 않아요. 이벤트에는 프로바이더, 모델, 권한 모드, 턴 결과, 소요 시간이 들어가요.",
      "프롬프트, 응답, 파일 내용, 인증 토큰, 대화 ID는 들어가지 않고, 엔드포인트는 IP 주소를 저장하지 않아요.",
      "끄려면 서버 환경에 GOAT_TELEMETRY_ENABLED=false를 설정하세요.",
    ],
    usageGuide: "제품 사용 데이터 가이드",
    usageGuideHref: guide("telemetry"),
    securityTitle: "보안",
    security:
      "GOAT는 아직 보안 연락처를 게시하지 않았어요. 취약점의 세부 내용은 공개 이슈에 올리지 말아 주세요. 저장소에 있는 보안 정책 파일은 T3 Code를 위해 쓰인 것이라 GOAT 연락처가 없어요.",
    securityFile: "물려받은 보안 정책 파일",
    licenseTitle: "라이선스",
    license:
      "GOAT 소스 코드는 MIT 라이선스로 공개돼 있어요. 라이선스 파일에는 GOAT의 저작권 표시와 함께 원래 T3 Code의 저작권 표시가 남아 있어요.",
    licenseLink: "라이선스 읽기",
    noticesLink: "GOAT의 오픈 소스 라이선스",
    noticesHref: guide("open-source-licenses"),
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
