import { withBase } from "./paths";

const REPOSITORY = "https://github.com/goat-si/goat";

export const LINKS = {
  deleteAccount: "https://app.trygoat.ai/account/delete",
  repository: REPOSITORY,
  guides: withBase("docs/user/"),
  contributing: `${REPOSITORY}/blob/dev/CONTRIBUTING.md`,
  structure: `${REPOSITORY}/blob/dev/structure/INDEX.md`,
  license: `${REPOSITORY}/blob/dev/LICENSE`,
  inheritedSecurityPolicy: `${REPOSITORY}/blob/dev/.github/SECURITY.md`,
  issues: `${REPOSITORY}/issues`,
  releases: "https://github.com/goat-si/goat-releases/releases",
  iosBeta: "https://testflight.apple.com/join/4PXeSgXv",
  testFlightApp: "https://apps.apple.com/app/testflight/id899247664",
  androidBeta: "https://appdistribution.firebase.dev/i/b6f930a2e01c9f53",
  nightlyReleases: "https://github.com/goat-si/goat-releases/releases?q=nightly&expanded=true",
  githubPrivacy:
    "https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement",
  installScript: "https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh",
  installPowerShell: "https://raw.githubusercontent.com/goat-si/goat-releases/main/install.ps1",
  installServer:
    "https://raw.githubusercontent.com/goat-si/goat-releases/main/install-goat-server.sh",
} as const;

/** A user guide in docs/user, with an optional heading anchor. */
export function guide(name: string, anchor?: string): string {
  return `${withBase(`docs/user/${name}/`)}${anchor ? `#${anchor}` : ""}`;
}

export const INSTALL_COMMANDS = {
  unix: `curl -fsSL ${LINKS.installScript} | sh`,
  windows: `irm ${LINKS.installPowerShell} | iex`,
  server: `curl -fsSL ${LINKS.installServer} | sh -s -- --tailscale`,
} as const;
