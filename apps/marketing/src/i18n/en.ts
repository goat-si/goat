import { guide, LINKS } from "../lib/links";

export const en = {
  htmlLang: "en",
  ogLocale: "en_US",
  languageName: "English",
  switchLabel: "한국어",
  switchAria: "Read this page in Korean",
  skip: "Skip to content",
  nav: {
    label: "Main",
    home: "GOAT home",
    download: "Download",
    guides: "Guides",
    github: "GitHub",
  },
  meta: {
    homeTitle: "GOAT: your coding agents, on every machine you own",
    homeDescription:
      "GOAT runs Claude Code, Codex, Cursor and other coding agents on your laptop, your desktop at home, SSH servers and cloud machines, and lets you steer them from the desktop app, a browser or your phone. Open source under the MIT license.",
    downloadTitle: "Download GOAT",
    downloadDescription:
      "Download the GOAT desktop app for macOS, Windows and Linux, or install the goat command and a server-only machine.",
    legalTitle: "Legal",
    legalDescription:
      "Which GOAT policies are published, what this website does with your visit, product usage data and the license.",
    privacyTitle: "Privacy",
    termsTitle: "Terms",
    securityTitle: "Security",
    ogAlt: "GOAT: your coding agents, on every machine you own.",
  },
  home: {
    title: "Your coding agents, on every machine you own.",
    lede: "GOAT runs the agents you already use, like Claude Code, Codex and Cursor, on your laptop, a desktop at home, an SSH server or a cloud machine. Steer all of them from the desktop app, a browser or your phone.",
    primary: "Download GOAT",
    secondary: "Read the guides",
    note: "Free and open source under the MIT license, for macOS, Windows and Linux.",
    captureAlt:
      "The GOAT app showing a thread in a demo project called trailhead. Codex added an elevationGainM helper; its reply reports npm test with 6 passed, and the diff panel beside it shows the change to src/format.ts.",
    captureCaption:
      "A demo project. The request, the reply and the diff come from a real Codex run in GOAT.",
    machines: {
      title: "Every machine is an environment",
      body: "Each machine you work on runs a GOAT server. That server and the state it owns (projects, threads, provider sign-ins and memory) form an environment. The desktop app, a browser or your phone can connect to as many environments as you like, and an environment can reach others.",
      points: [
        {
          title: "SSH hosts",
          body: "Add a host in Settings → Connections. It downloads its own GOAT runtime on first use. Boat cloud machines work like any other SSH host.",
        },
        {
          title: "Linked GOAT servers",
          body: "Link a GOAT server you already run with a pairing link, so agents can start, read and message threads there.",
        },
        {
          title: "WSL",
          body: "On Windows, a WSL distro runs its own environment with the provider CLIs installed inside it.",
        },
        {
          title: "Your other screens",
          body: "Pair a phone or another browser directly, over your local network, or over Tailscale.",
        },
      ],
      guide: "Remote access guide",
      guideHref: guide("remote-access"),
      diagram: {
        label: "How GOAT connects your screens and machines",
        clients: "Your screens",
        clientItems: ["Desktop app", "Browser", "Phone"],
        environment: "GOAT environment",
        environmentNote: "on your machine",
        environmentItems: ["Projects", "Threads", "Providers", "GOAT Bot", "Memory"],
        reaches: "Reaches",
        reachItems: ["SSH hosts", "Linked GOAT servers", "WSL distros", "Boat cloud machines"],
      },
    },
    flow: {
      title: "Start on one machine, finish on another",
      lede: "Agents in GOAT can cross machines, and so can your work.",
      phoneAlt:
        "The same thread in a phone-sized browser: the request, the reply reporting npm test with 6 passed, and the changed files.",
      steps: [
        {
          title: "Start a thread on your laptop",
          body: "Pick a project and a provider. When the agent works in a local Git checkout, each turn saves a checkpoint, so you can review exactly what it changed and restore it.",
        },
        {
          title: "Move it to a bigger machine",
          body: "Move a thread to an SSH host with its uncommitted changes, or let an agent start a thread or worktree there and wait for the result.",
        },
        {
          title: "Follow it from anywhere",
          body: "Open the same thread from your phone or another browser paired with that environment, and answer when it needs you.",
        },
        {
          title: "Bring the branch back",
          body: "Fetch the branch from an SSH worktree into the repository on this device. Your current branch and working files stay as they are.",
        },
      ],
    },
    agents: {
      title: "Use the agents you already have",
      lede: "GOAT runs each provider's own agent with the sign-in you already set up on the machine that does the work.",
      localLabel: "On your machines",
      local: [
        "Claude Code",
        "Codex",
        "Cursor",
        "Grok Build",
        "OpenCode",
        "Antigravity",
        "Pi",
        "Muse Code",
        "ACP agents",
      ],
      cloudLabel: "In the vendor's cloud",
      cloud: ["Claude Cloud", "Cursor Cloud", "Devin Cloud"],
      guide: "Set up a provider",
      guideHref: guide("install", "providers"),
    },
    features: {
      title: "What GOAT adds",
      readGuide: "Read the guide",
      items: [
        {
          title: "GOAT Bot",
          body: "One standing conversation that is not tied to a project. Ask it for work and it starts a coding thread in the right project and machine, then reports back. It also answers in Slack, and over iMessage when the server runs on a Mac.",
          href: guide("slack"),
        },
        {
          title: "Fleet",
          body: "One view of every connected machine and the agents working on it, with counts of threads that are running or waiting for you. Fleet goals keep starting workers until the conditions you set hold.",
          href: guide("fleet-goals"),
        },
        {
          title: "Memory",
          body: "Finished conversations become memories scoped to all projects, one project or one thread. Import memories from Codex, Claude and OMO, and share them between devices through a hub.",
          href: guide("memory"),
        },
        {
          title: "Orchestration tools",
          body: "The GOAT MCP server gives agents tools to launch threads, watch them and report results to the thread that started them. Outside agents such as Claude Code, Codex and ChatGPT can connect to the same server.",
          href: guide("outside-agents"),
        },
        {
          title: "Computer, browser and devices",
          body: "Agents can use apps on the computer that runs GOAT without taking over your cursor. The desktop app has a browser panel beside each thread, and a Device panel shows an iOS Simulator or Android Emulator an agent can drive.",
          href: guide("computer-use"),
        },
        {
          title: "Source control and pull requests",
          body: "Clone and publish repositories, open pull requests and review each turn's own changes. GitHub, GitLab, Forgejo, Gitea, Bitbucket, Azure DevOps and GitCafe are supported.",
          href: guide("source-control"),
        },
        {
          title: "Visual replies",
          body: "Ask for a chart, a table or a diagram and the agent answers with a sandboxed page in the thread. It works with every provider, on web, desktop and mobile.",
          href: guide("html-renders"),
        },
      ],
    },
    openSource: {
      title: "Open source, built in public",
      body: "GOAT is MIT licensed and developed in a public repository, with its work tracked in GitHub issues and pull requests. It began as a fork of T3 Code, keeps its event-sourced core, and still merges upstream changes.",
      links: [
        { label: "Source on GitHub", href: LINKS.repository },
        { label: "Contributing", href: LINKS.contributing },
        { label: "How GOAT is built", href: LINKS.structure },
      ],
    },
  },
  install: {
    title: "Install GOAT",
    lede: "The desktop app updates itself. The goat install script follows the Nightly train unless you set GOAT_CHANNEL=stable.",
    desktopTitle: "Desktop app",
    desktopBody:
      "For macOS, Windows and Linux. It includes the server and the goat command, so it can also host the environment your other screens connect to.",
    desktopCta: "Choose a download",
    cliTitle: "The goat command",
    cliBody:
      "Starts the server and opens the web app. On Windows, run the second line in PowerShell.",
    serverTitle: "A server-only machine",
    serverBody:
      "For a VPS or a spare Mac you reach from other devices. Installs the server as a background service and prints pairing links.",
    copyHint: "Select the command to copy it.",
  },
  download: {
    title: "Download GOAT",
    lede: "Every build comes from the goat-si/goat-releases repository on GitHub. The desktop app updates itself.",
    checking: "Finding the newest build on GitHub.",
    stable: "Newest stable release: {tag}, published {date}.",
    nightly:
      "No stable release is published yet, so these links point to the newest Nightly build: {tag}, published {date}.",
    failed: "GitHub could not be reached, so the links open the releases page.",
    platforms: [
      {
        name: "macOS",
        builds: [
          { label: "Apple silicon", file: ".dmg", pattern: "-arm64\\.dmg$" },
          { label: "Intel", file: ".dmg", pattern: "-x64\\.dmg$" },
        ],
        note: "Intel Macs get the desktop app; the goat command is not built for them.",
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
          { label: "Debian and Ubuntu, amd64", file: ".deb", pattern: "-amd64\\.deb$" },
          { label: "Debian and Ubuntu, arm64", file: ".deb", pattern: "-arm64\\.deb$" },
        ],
        note: "Install a .deb with sudo apt install ./<file>.deb. It asks for your password to install each update.",
      },
    ],
    mobileTitle: "Phone and tablet",
    mobileBody:
      "The GOAT app for iPhone, iPad and Android is in development and is not in the App Store or Google Play yet. iPhone and iPad builds come through TestFlight, which is invite-only for now, or you can build the app from source. Until then, pair your phone's browser with an environment.",
    mobileWarning:
      "The T3 Code app in the stores belongs to the project GOAT is forked from. It is not GOAT and cannot connect to a GOAT server.",
    mobileGuide: "Mobile app guide",
    mobileGuideHref: guide("install", "mobile-app"),
    allBuilds: "All builds and checksums",
    nightlyBuilds: "Nightly builds",
    installGuide: "Install guide",
    installGuideHref: guide("install"),
  },
  legal: {
    title: "Legal",
    lede: "What is and is not published yet, stated plainly.",
    notPublishedTitle: "Policies that are not published yet",
    notPublished:
      "GOAT has not published its own privacy policy, terms of service or security contact yet. They will appear on this page before GOAT launches. Until then, nothing on this site is an agreement with you, and GOAT does not adopt policies written for other projects, including T3 Code, the project GOAT is forked from.",
    siteTitle: "This website",
    site: [
      "This site loads no analytics scripts and sets no cookies.",
      "It is a static site. Its host may log requests, including your IP address. GitHub Pages, which serves the preview of this site, does this for security purposes.",
      "The download page asks the GitHub API for the newest release from your browser, so GitHub receives that request too.",
    ],
    githubPrivacy: "GitHub's privacy statement",
    usageTitle: "Product usage data",
    usage: [
      "The GOAT server sends product usage events, associated with a hashed account or installation identifier, to GOAT's own endpoint, which deletes them within 180 days of arrival and forwards them to no one. Deleted events can remain in the database's recovery backups for up to 30 more days, and deletion is delayed while cleanup is down. Events include the provider, model, permission mode, turn result and duration.",
      "Events do not include prompts, responses, file contents, authentication tokens or conversation IDs, and the endpoint does not store your IP address.",
      "Set GOAT_TELEMETRY_ENABLED=false in the server's environment to turn them off.",
    ],
    usageGuide: "Product usage data guide",
    usageGuideHref: guide("telemetry"),
    securityTitle: "Security",
    security:
      "GOAT has not published a security contact yet. Please do not post details of a vulnerability in a public issue. The security policy file in the repository was written for T3 Code and does not name a GOAT contact.",
    securityFile: "Inherited security policy file",
    licenseTitle: "License",
    license:
      "GOAT's source code is available under the MIT License. The license file keeps the original T3 Code copyright notice next to GOAT's.",
    licenseLink: "Read the license",
    noticesLink: "Open source licenses in GOAT",
    noticesHref: guide("open-source-licenses"),
  },
  footer: {
    tagline: "MIT licensed. GOAT began as a fork of T3 Code.",
    label: "Footer",
    links: {
      download: "Download",
      guides: "Guides",
      github: "GitHub",
      releases: "Releases",
      legal: "Legal",
    },
  },
};

export type Messages = typeof en;
