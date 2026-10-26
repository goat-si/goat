import type { KeepRule } from "./engine.ts";

const serviceEndpointPaths = new Set([
  ".github/triage/PLAYBOOK.md",
  "AGENTS.md",
  "apps/desktop/gnome-extension/bundle.json",
  "apps/desktop/gnome-extension/metadata.json",
  "apps/mobile/src/features/settings/lib/legal-document-url.ts",
  "apps/server/src/telemetry/AnalyticsService.ts",
  "apps/web/src/legalLinks.ts",
  "docs/internals/linux-snap-shot.md",
  "docs/internals/product-analytics.md",
  "docs/user/telemetry.md",
  "scripts/build-desktop-artifact.ts",
  "structure/decisions/ADR-0014-desktop-runtime-identity.md",
]);

const exactLines = (...lines: readonly string[]) =>
  new RegExp(
    lines.map((line) => `^${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).join("|"),
    "g",
  );

// Match the existing upstream phrases before other keeps strip repository URLs or legacy tokens.
const upstreamProductPhrases: readonly (readonly [string, RegExp])[] = [
  [
    ".agents/skills/contribution-triage/SKILL.md",
    exactLines(
      "description: Enforce T3 Code's PR contribution policy by closing ineligible submissions and triggering Macroscope review for eligible work within authorized scope. Supports explicit dry runs. Use for contribution moderation, not installation diagnostics or a full code review.",
    ),
  ],
  [
    ".github/triage/PLAYBOOK.md",
    exactLines(
      "# T3 Code triage playbook",
      "You are a support engineer for T3 Code (https://github.com/pingdotgg/t3code), working",
      "- How is T3 Code running on this machine: `npx t3 serve` in a terminal, the",
      "Do not patch the T3 Code source as a fix. A good issue with strong repro steps",
    ),
  ],
  [
    "AGENTS.md",
    exactLines(
      "GOAT began as a fork of [T3 Code](https://github.com/pingdotgg/t3code). It keeps that event-sourced core and still merges upstream changes, so many files here are shared with upstream. [Fork delta](devlog/_chase/010_fork_delta.md) records the areas where the two differ.",
      "# T3 Code",
      "T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs and agents (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity) and serves web, desktop, and mobile clients.",
      'You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.',
      "## What makes T3 Code special?",
      "We have over 500,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.",
      "T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.",
      'Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we\'re proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.',
      "The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.",
      "T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.",
      '**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.',
      "**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.",
      "**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.",
      "Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.",
      "- **you** means the agent reading this file and changing T3 Code.",
      "- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.",
      "- **user** means the person using T3 Code to direct coding agents.",
      "- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.",
      "- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.",
      "- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.",
      "- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.",
      "2. **Writing to the live install.** `~/.goat/userdata` is the developer's real database, and `~/.t3/userdata` is the fallback when that file is absent. Both are in use while you work. Reading them and copying from them are fine, and a good way to get real test data (see Test data). Never start a server against either, never open one read-write, never clean one up.",
      "- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.goat` (a worktree created earlier keeps its `.t3`), which deliberately outranks an ambient `GOAT_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.",
      "- Run `vp run migrate-dev-db` with your dev server stopped to refresh. It rebuilds `<worktree>/.goat/userdata/statev2.sqlite` from a read-only snapshot of `~/.goat/userdata/statev2.sqlite`, or `~/.t3/userdata/statev2.sqlite` when the GOAT database is absent. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.",
      "- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed T3 Code server in the user guides.",
    ),
  ],
  [
    "README.md",
    exactLines(
      "GOAT began as a fork of [T3 Code](https://github.com/pingdotgg/t3code) and keeps its fast, event-sourced core. On top of it, GOAT adds:",
      "- **Its own desktop app.** The GOAT desktop app has its own app ID, data folder and update feed, so it installs beside the T3 Code app without sharing state. Its command line is `goat`.",
      "GOAT is a fork of [T3 Code](https://github.com/pingdotgg/t3code) by Ping and shares its git history. We merge upstream every cycle, and [devlog/_chase](./devlog/_chase/README.md) records how far GOAT has followed and where it deliberately differs. Thank you to the T3 Code team for the foundation.",
      "MIT. [LICENSE](./LICENSE) keeps the original T3 Code copyright notice. Icons: [Solar](https://www.figma.com/community/file/1166831539721848736) by 480 Design, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).",
    ),
  ],
  ["apps/desktop/package.json", /(?:"productName": "T3 Code \(Alpha\)")/g],
  ["apps/desktop/scripts/electron-launcher.mjs", /(?:"T3 Code \(Dev\)"|"T3 Code \(Alpha\)")/g],
  ["apps/desktop/src/app/DesktopLegacyLocalStorage.ts", /(?:"T3 Code \(Alpha\)")/g],
  [
    "apps/server/scripts/acp-mock-agent.ts",
    exactLines(
      '              Content: { url: "https://t3.codes", content: "T3 Code page" },',
      '            content: [{ type: "content", content: { type: "text", text: "T3 Code page" } }],',
    ),
  ],
  [
    "apps/server/src/cloud/bootService.ts",
    /(?:\.replace\(\/\^Description=T3 Code server\$\/m, "Description=GOAT server"\))/g,
  ],
  ["apps/server/src/provider/CodexChatGptAuth.ts", /(?:agent_name_hint: "T3 Code")/g],
  ["apps/server/src/provider/CodexProvider.ts", /(?:CODEX_CLIENT_NAME = "T3 Code")/g],
  [
    "apps/server/src/telemetry/AnalyticsService.ts",
    exactLines(" * Events go to the T3 Code ingest endpoint, which keeps a copy and forwards"),
  ],
  [
    "docs/operations/mobile-app-store-screenshots.md",
    exactLines(
      "2. Creates T3 Code, React, and Linux Git repositories with recognizable favicons, feature branches,",
      "   and a deterministic T3 Code review diff.",
      "The Pending rows use the production offline outbox and point at the real T3 Code and React fixture",
    ),
  ],
  ["packages/contracts/src/relay.ts", /(?:"T3 Code Relay API")/g],
  [
    "packages/provider-muse/src/server/sdk.ts",
    /(?:clientInfo: \{ name: "t3_code", title: "T3 Code", version: "1" \})/g,
  ],
  ["packages/shared/src/goatHome.ts", /(?:T3 Code may be using `~\/\.t3` at the same time\.)/g],
  [
    "packages/shared/src/usageLimits.ts",
    /(?:I've reached the limit for using my ChatGPT plan in T3 Code\. Could you increase our workspace's usage limits so I can continue\?)/g,
  ],
  [
    "scripts/mobile-showcase-environment.ts",
    exactLines(
      '    title: "T3 Code",',
      '      "Give T3 Code a remote-first command center. Make three machines feel one tap away, keep agent work in sync, and make every handoff feel instant.",',
      '      "T3 Code now treats every machine like it is right here in the room. ✦\\n\\n- Moonbase, Suspense Station, and Kernel Cabin stay live together\\n- Terminal state follows you without losing a single line\\n- Agent work remains perfectly in sync across devices\\n- Handoffs land before your train of thought can wander\\n\\nI also ran the changed workspace: **612 tests passed**.",',
    ),
  ],
  [
    "structure/decisions/ADR-0005-desktop-home.md",
    exactLines(
      "- 목적과 의도: Package GOAT as its own desktop app, with its own data directory and update feed, so it can sit beside an upstream T3 Code install.",
      '- 기존 구현 및 제약 조건: The message says a packaged build was still "T3 Code" with upstream\'s bundle id, Electron profile, and `~/.t3/userdata`, and that its update feed followed `GITHUB_REPOSITORY`. That could collide with an upstream install or update into upstream T3.',
    ),
  ],
  [
    "structure/decisions/ADR-0006-goat-cli-and-ssh-home.md",
    exactLines(
      "- 검토한 주요 대안: The message does not record a third directory layout. It rejects sharing `~/.t3` on a host that also runs upstream T3 Code.",
    ),
  ],
  [
    "structure/decisions/ADR-0007-mcp-tool-names.md",
    exactLines(
      '- 기존 구현 및 제약 조건: The message says agents saw `t3_thread_list`, `t3_ssh_thread_launch`, and the rest, from a server named "T3 Code".',
    ),
  ],
  [
    "structure/decisions/ADR-0014-desktop-runtime-identity.md",
    exactLines(
      "  `T3 Code <stage>` on `t3code://app`, without losing saved secrets or renderer storage and with a",
      '  from `app.name` as it stands before the event loop starts. `app.setName("T3 Code <stage>")` ran',
      "    copy the key of the initial package name (or `T3 Code <stage>`) to the new name. All ciphertext",
    ),
  ],
  [
    "structure/decisions/ADR-0022-cua-driver-computer-use.md",
    exactLines(
      "  - Upstream T3 Code had two open, unmerged Cua Driver stacks. The newer one (#21694-#21697, by",
    ),
  ],
];

export const EXTERNAL_KEEP_RULES: readonly KeepRule[] = [
  ...upstreamProductPhrases.map(([path, pattern]) => ({
    id: `upstream-product-identity:${path}`,
    pattern,
    scope: (candidate: string) => candidate === path,
    reason:
      path === "packages/shared/src/usageLimits.ts"
        ? "source comment says the request wording is prescribed by OpenAI partner guidelines (classification D-PARTNER); revisit with approved GOAT wording"
        : "#99/R6: exact existing external provider identity, upstream attribution or compatibility phrase.",
  })),
  {
    id: "upstream-repository-links",
    pattern: /pingdotgg\/t3code/g,
    reason: "Upstream repository attribution, retained by #99 (D12).",
  },
  {
    id: "upstream-copyright",
    pattern: /Copyright \(c\) \d{4} T3 Tools Inc\./g,
    reason: "Authorship is upstream license provenance, never GOAT branding (#99/D12).",
  },
  {
    id: "upstream-product-context",
    pattern:
      /[Uu]pstream T3 Code|fork of (?:\[T3 Code\]|T3 Code)|any T3 Code install|original T3 Code (?:artwork|copyright)/g,
    scope: (path) => /^(?:apps|packages|docs|structure|scripts)\//.test(path),
    reason:
      "#99/R2: these existing phrases name the upstream product, installation or original artwork/copyright.",
  },
  {
    id: "relay-service-copy",
    pattern: /T3 Connect|T3 [Aa]ccount/g,
    scope: (path) =>
      // The mirror of upstream's guide keeps its wording so its heading anchors match the help URLs (W11).
      path === "docs/user/t3-connect-troubleshooting.md",
    reason: "Byte-stable mirror of the upstream troubleshooting page the help URLs open (W11).",
  },
  {
    id: "upstream-service-endpoints",
    pattern: /t3\.codes/g,
    scope: (path) => serviceEndpointPaths.has(path),
    reason:
      "Existing hosted services, schema URLs and the ADR-0014 frozen GNOME uuid retain their upstream domain (D12/D14).",
  },
  {
    id: "external-chat-service",
    pattern: /T3 Chat|t3\.chat/g,
    scope: (path) =>
      [
        "apps/web/index.html",
        "apps/web/src/index.css",
        "packages/shared/src/themePalettes.ts",
        "packages/contracts/src/previewAutomation.ts",
        "packages/contracts/src/agentSurface/registry.ts",
        "apps/server/src/preview/ServerBrowserAddress.ts",
        "apps/server/src/preview/ServerBrowserPage.ts",
        "apps/web/src/components/preview/browserAddress.ts",
      ].includes(path),
    reason: "Theme attribution and example URLs name the external T3 Chat service (D12).",
  },
];
