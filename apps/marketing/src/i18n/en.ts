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
      "Privacy, terms and security disclosure for the GOAT Connect invite-only beta, plus website and product usage data practices.",
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
    lede: "Policies for the GOAT Connect invite-only beta, limited to 50 users.",
    updated: "Updated 28 October 2026",
    operatorTitle: "Operator and contact",
    operator:
      "GOAT Connect is operated by 김병준 (Kim Byungjun), who also handles security incidents. For privacy requests, account deletion, support or abuse reports, email:",
    policyLinks: "Beta policies",
    privacy: {
      lede: "How the GOAT Connect invite-only beta processes your data. The beta is limited to 50 users.",
      sections: [
        {
          id: "scope",
          title: "What this policy covers",
          paragraphs: [
            "This policy covers the hosted GOAT Connect service and this marketing website. Connect is optional: running GOAT on your own machines does not by itself upload your projects or conversations to Connect. Your coding agent providers have their own data practices.",
          ],
        },
        {
          id: "account",
          title: "Sign-in and account data",
          paragraphs: [
            "Clerk handles Connect sign-in, account identifiers, email addresses, profile information you supply and authentication data. The relay verifies Clerk credentials and uses your account identifier to associate your devices and environments. The sign-in service uses session credentials and may use cookies; the static marketing website does not set cookies.",
          ],
        },
        {
          id: "connections",
          title: "Environment and device records",
          paragraphs: [
            "To link your machines and route connections, the relay stores account and environment identifiers, labels, public keys, endpoint URLs, tunnel and DNS allocation details, the local tunnel origin, link preferences and timestamps. It also stores hashed environment credentials, revocation records and short-lived proof identifiers used to prevent replay.",
            "For mobile notifications, it stores device identifiers and labels, platform and OS version, app version and bundle identifier, notification preferences, APNs or FCM push tokens, and iOS Live Activity tokens when supplied. These tokens let us deliver updates to your device.",
          ],
        },
        {
          id: "activity",
          title: "Activity updates and push notifications",
          paragraphs: [
            "The relay processes agent activity updates: environment and thread identifiers, project and thread titles, model names, status, headline, optional detail, timestamps and links back to the thread. Titles and status text can contain information about your work. Updates and notification payloads may be held in delivery queues and sent to Apple APNs or Google FCM, depending on your device and preferences.",
            "Delivery records include account, environment, thread and device identifiers, delivery results, errors and a token suffix. Notification content can appear on your lock screen. You can disable notifications or Live Activities in your preferences.",
          ],
        },
        {
          id: "traffic",
          title: "Tunnel traffic and optional held webhooks",
          paragraphs: [
            "Cloudflare provides the managed tunnels and handles network requests, including IP addresses and request metadata. After connection bootstrap, normal HTTP and WebSocket application traffic goes through Cloudflare to your environment, rather than through the relay Worker. Cloudflare terminates HTTPS; this is not end-to-end encryption that hides application content from the infrastructure provider. The relay is a trusted connection broker, not a zero-knowledge service.",
            "Automation webhooks are forwarded by the relay. By default it does not persist webhook requests. If you enable holding webhooks while offline, a Cloudflare Durable Object stores the raw request, including its body, headers, query and hook token, so it can retry delivery. Do not send secrets or personal data you do not need in webhooks.",
          ],
        },
        {
          id: "providers",
          title: "Service providers and diagnostics",
          paragraphs: [
            "We use this data to authenticate you, connect your machines, deliver notifications and webhooks, diagnose failures and protect the service. The configured infrastructure uses Clerk for identity, Cloudflare for the relay, tunnels, queues and held webhooks, PlanetScale Postgres for relay records, Axiom for diagnostics, Apple APNs for iOS delivery and Google FCM for Android delivery.",
            "Axiom tracing is configured for relay requests and first-party client diagnostics. Traces can include identifiers, request methods and paths, response status, timing and errors. The webhook forwarding path redacts hook tokens and does not attach webhook bodies to its traces. Turning off GOAT product usage telemetry does not turn off Connect operational diagnostics.",
            "These providers may process data outside your country. The current relay database configuration selects PlanetScale's US West region. Other processing locations and provider retention depend on the service and deployment; this policy does not promise that data stays in Korea.",
          ],
        },
        {
          id: "retention",
          title: "How long data remains",
          paragraphs: [
            "Held webhooks are removed after an environment response, after 24 hours, or when the environment has no remaining linked user. Expiry is enforced by background processing, so cleanup can be delayed by failures. Maintenance also removes expired replay proofs and terminal activity rows older than 30 minutes. The Axiom trace dataset is configured for 30-day retention.",
            "The current relay has no automatic expiry for several other records, including delivery attempts, revoked credentials and non-terminal activity. Unlinking an environment revokes its link and attempts tunnel cleanup; it is not account-wide erasure. We cannot promise an automatic deletion deadline for all Connect data or provider backups.",
          ],
        },
        {
          id: "rights",
          title: "Access, correction and account deletion",
          paragraphs: [
            "Email the contact above to request access to or correction of your data, stop using Connect, or request deletion of your Connect account and associated hosted data. Use your account email and describe the request; do not send passwords, authentication codes or push tokens. We may need to verify that the account is yours.",
            "Account-wide self-service deletion is not available in the current beta implementation. Requests require operator follow-up across Clerk, relay records, push registrations, held webhooks and tunnel resources. Signing out, unlinking, or deleting a Clerk account alone should not be treated as deletion of all Connect data or revocation of every existing environment session. Your local project files and thread history remain on your machines; manage them there.",
            "If you have a privacy concern or want to exercise rights available under applicable law, use the same contact. We will post policy revisions here with an updated date.",
          ],
        },
      ],
    },
    terms: {
      lede: "Terms for the GOAT Connect invite-only beta, limited to 50 users.",
      sections: [
        {
          id: "beta",
          title: "Joining and using the beta",
          paragraphs: [
            "These terms apply to the hosted GOAT Connect beta operated by 김병준 (Kim Byungjun). By using Connect, you agree to these terms. Access is by invitation only, with a maximum of 50 beta users; an invitation is not a promise of continued access or a public launch. The open-source GOAT software remains governed by its own license.",
            "Connect lets your signed-in devices reach linked GOAT environments and receive notifications. Link only machines you own or have permission to control. Protect your account, devices and recovery methods: access to a linked environment can allow running agents and terminal commands on that machine.",
          ],
        },
        {
          id: "acceptable-use",
          title: "Acceptable use",
          paragraphs: [
            "Do not use Connect for phishing, malware, unauthorized access, harassment, unlawful activity or attacks on other users or services. Do not resell access, operate an open proxy, bypass invitations or limits, or overload the service. You are responsible for the content and actions you send through your environments, including agent actions and webhooks, and for respecting third-party rights and service terms.",
          ],
        },
        {
          id: "availability",
          title: "Availability and support",
          paragraphs: [
            "This is an experimental beta provided as available. There is no service-level agreement (SLA), uptime guarantee, guaranteed support response time or promise that notifications and webhooks will arrive. Features, limits and availability may change, and the beta may end. Keep backups and another way to reach your machines; do not rely on Connect for emergency or safety-critical work.",
            "To the extent permitted by applicable law, the beta comes without warranties of uninterrupted, error-free or fit-for-purpose service. Nothing in these terms excludes rights or liability that applicable law does not allow us to exclude.",
          ],
        },
        {
          id: "suspension",
          title: "Suspension and ending access",
          paragraphs: [
            "The operator may suspend or end access to address abuse, security risks, legal requirements or capacity constraints, or to end the beta. Urgent action may happen without advance notice. Suspension or sign-out does not necessarily terminate sessions already established directly with an environment; secure your machines separately if you suspect compromise.",
          ],
        },
        {
          id: "leaving",
          title: "Leaving, deletion and contact",
          paragraphs: [
            "You may stop using Connect at any time. To request account deletion, email the contact above from your account address. Deletion currently needs operator follow-up; signing out or unlinking is not account-wide erasure. The privacy policy explains the data involved and the current cleanup limits. Deleting hosted Connect data does not delete the projects or thread history on your own machines.",
            "Send support, abuse reports and questions about these terms to the same contact. Revisions will be posted on this page with an updated date; review them before continuing to use the beta.",
          ],
        },
      ],
    },
    security: {
      lede: "Report GOAT or GOAT Connect vulnerabilities privately. Connect is an invite-only beta limited to 50 users.",
      sections: [
        {
          id: "report",
          title: "How to report a vulnerability",
          paragraphs: [
            "Email the contact above in Korean or English. 김병준 (Kim Byungjun) is the incident owner. Include the affected component and version, a description of the impact and minimal steps to reproduce. Use a subject such as GOAT security report. Do not include live credentials, private conversations or other users' data.",
            "Do not publish exploit details in a public issue before we can assess and coordinate a fix. If you encounter exposed personal data, stop accessing it and describe where you found it without copying it into your report. We will work with you on disclosure timing; the beta has no guaranteed response or remediation deadline and no promised bounty.",
          ],
        },
        {
          id: "research",
          title: "Research boundaries",
          paragraphs: [
            "Use your own accounts and environments, or obtain explicit permission from their owners. Do not access another person's data, disrupt service, run destructive tests or use social engineering. This page does not authorize testing of third-party providers or systems you do not control.",
          ],
        },
        {
          id: "incident",
          title: "If your account or environment is at risk",
          paragraphs: [
            "Contact us promptly, secure your sign-in and recovery methods, and revoke affected access on your own environments. Connect sign-in can grant control of linked machines. Signing out alone is not a guarantee that existing environment sessions have ended. The operator coordinates incident response; this page does not claim that every planned beta security control is already deployed.",
          ],
        },
      ],
    },
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
