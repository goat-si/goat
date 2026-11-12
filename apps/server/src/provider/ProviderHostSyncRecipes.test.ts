import { describe, expect, it } from "@effect/vitest";

import {
  PROVIDER_HOST_SYNC_DRIVERS,
  describeInstall,
  describeInstallFailure,
  installCommand,
  installMethod,
  parseDeviceLogin,
  relayableBrowserUrl,
  trustedLogin,
  versionCore,
} from "./ProviderHostSyncRecipes.ts";

describe("installCommand", () => {
  const npmCli = {
    codex: "@openai/codex",
    claudeAgent: "@anthropic-ai/claude-code",
    grok: "@xai-official/grok",
    opencode: "opencode-ai",
    omo: "omo-ai",
    pi: "@earendil-works/pi-coding-agent",
  } as const;

  it.each(["darwin", "linux", "win32"] as const)(
    "installs every npm-published CLI on %s from npm at the requested version, as one argument",
    (platform) => {
      for (const [driver, pkg] of Object.entries(npmCli)) {
        const command = installCommand(driver as keyof typeof npmCli, platform, "1.2.3");
        expect(command).toMatchObject({ method: "npm", command: "npm" });
        expect(command?.method === "npm" && command.args.slice(0, 3)).toEqual([
          "install",
          "-g",
          `${pkg}@1.2.3`,
        ]);
      }
      expect(installCommand("pi", platform, null)).toEqual({
        method: "npm",
        command: "npm",
        args: ["install", "-g", "@earendil-works/pi-coding-agent@latest", "--ignore-scripts"],
      });
    },
  );

  it("never pipes a downloaded script into a shell, for any provider, platform or version", () => {
    for (const driver of PROVIDER_HOST_SYNC_DRIVERS)
      for (const platform of ["darwin", "linux", "win32"] as const)
        for (const version of [null, "1.2.3", "2026.11.11-b912975"]) {
          const command = installCommand(driver, platform, version);
          if (command === null) continue;
          expect(["npm", "tar"]).toContain(command.command);
          expect(describeInstall(command)).not.toMatch(/\|\s*(?:sh|bash|iex)\b|\birm\b|\bcurl\b/u);
        }
  });

  it("installs Cursor on macOS and Linux only from its pinned, checksummed release", () => {
    for (const platform of ["darwin", "linux"] as const) {
      const command = installCommand("cursor", platform, null);
      if (command?.method !== "script") return expect.unreachable();
      expect(command.command).toBe("tar");
      expect(command.artifact.assets).toHaveProperty(`${platform}-arm64`);
      expect(command.artifact.assets).toHaveProperty(`${platform}-x64`);
      for (const asset of Object.values(command.artifact.assets)) {
        expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(asset.bytes).toBeGreaterThan(0);
      }
      expect(command.artifact.url.startsWith("https://downloads.cursor.com/")).toBe(true);
      expect(installCommand("cursor", platform, command.artifact.version)).toEqual(command);
      // No pin for another version, so GOAT does not guess one.
      expect(installCommand("cursor", platform, "1.0.0")).toBeNull();
    }
  });

  it("leaves Cursor on Windows to a person, since it has no pinned Windows build", () => {
    expect(installCommand("cursor", "win32", null)).toBeNull();
    expect(installMethod("cursor", "win32")).toBe("manual");
  });

  it.each([
    "1.0.0; rm -rf ~",
    "$(whoami)",
    "1.0.0 && curl evil",
    "latest|id",
    "1.0.0' | iex #",
    "../../etc",
  ])("refuses a version that is not a plain release: %s", (version: string) => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(installCommand("claudeAgent", platform, version)).toBeNull();
      expect(installCommand("opencode", platform, version)).toBeNull();
    }
  });

  it("leaves unknown platforms to a person", () => {
    expect(installCommand("codex", "other", null)).toBeNull();
    expect(installMethod("codex", "other")).toBe("manual");
  });
});

describe("parseDeviceLogin", () => {
  it("relays the vendor's page and code from colored CLI output", () => {
    const output =
      "\u001b[1mWelcome\u001b[0m\nOpen \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\nEnter this one-time code \u001b[94mABCD-12345\u001b[0m\n";
    expect(parseDeviceLogin("codex", output)).toEqual({
      type: "device_code",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-12345",
    });
  });

  it("ignores a page on any other host", () => {
    expect(
      parseDeviceLogin("codex", "Open https://auth.openai.com.evil.test/device code ABCD-12345"),
    ).toBeNull();
    expect(parseDeviceLogin("claudeAgent", "https://claude.ai/x ABCD-12345")).toBeNull();
  });
});

describe("relayableBrowserUrl", () => {
  it("relays only the driver's own vendor-hosted approval page", () => {
    expect(
      relayableBrowserUrl("cursor", "https://cursor.com/loginDeepControl?challenge=abc", false),
    ).toBe("https://cursor.com/loginDeepControl?challenge=abc");
    expect(
      relayableBrowserUrl("cursor", "https://evil.example/login?challenge=abc", false),
    ).toBeNull();
    expect(relayableBrowserUrl("codex", "https://cursor.com/loginDeepControl", false)).toBeNull();
  });

  it("never relays a page that carries a credential", () => {
    for (const url of [
      "https://cursor.com/login?access_token=FAKE",
      "https://cursor.com/login?code_verifier=FAKE",
      "https://cursor.com/login?code=FAKE",
      "https://cursor.com/login#code_verifier=FAKE",
    ])
      expect(relayableBrowserUrl("cursor", url, false)).toBeNull();
  });

  it("keeps flows that call back to the target machine on that machine", () => {
    expect(
      relayableBrowserUrl(
        "cursor",
        "https://cursor.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback",
        false,
      ),
    ).toBeNull();
    expect(relayableBrowserUrl("cursor", "http://127.0.0.1:8080/login", false)).toBeNull();
    expect(relayableBrowserUrl("cursor", "https://cursor.com/login", true)).toBeNull();
  });
});

describe("describeInstallFailure", () => {
  it("never repeats installer output, which can hold registry tokens", () => {
    const output =
      "npm ERR! code E401\nnpm ERR! //registry.npmjs.org/:_authToken=npm_SECRETTOKEN123\nEACCES: permission denied";
    const message = describeInstallFailure(1, output);
    expect(message).not.toContain("SECRETTOKEN");
    expect(message).not.toContain("registry.npmjs.org");
    expect(message).toMatch(/could not write its install folder/);
    expect(describeInstallFailure(7, "token=abc")).toBe("The installer exited with code 7.");
    expect(describeInstallFailure(null, "")).toMatch(/did not finish/);
  });
});

describe("pinned prerelease versions", () => {
  it("regression F7-1: keeps a hyphenated prerelease whole, and never a prefix of it", () => {
    expect(versionCore("pi 1.2.3-beta-2")).toBe("1.2.3-beta-2");
    expect(versionCore("1.2.3-beta.1 (build)")).toBe("1.2.3-beta.1");
    expect(versionCore("version 1.2.3.")).toBe("1.2.3");
    // An identifier longer than a pin can name is no version GOAT can match.
    expect(versionCore("1.2.3-" + "a".repeat(25))).toBeNull();
    expect(versionCore("pi 1.2.3-beta-")).toBe("1.2.3-beta-");
    // A version starts where a token starts, never inside a longer one.
    expect(versionCore("1234567.2.3")).toBeNull();
    expect(versionCore("1.2.3-beta.1.2.3.4.5")).toBeNull();
    // A pin cannot name build metadata, so a build-tagged version never equals one.
    expect(versionCore("1.2.3+build.4")).toBeNull();
    expect(versionCore("build_1.2.3")).toBeNull();
    expect(versionCore("1.2.3_artifact")).toBeNull();
    expect(installCommand("opencode", "linux", "1.2.3-beta-2")).toMatchObject({
      args: ["install", "-g", "opencode-ai@1.2.3-beta-2"],
    });
  });
});

describe("trustedLogin", () => {
  it("regression F8-2: relays a remote device login as the vendor page alone", () => {
    expect(
      trustedLogin("codex", "box", {
        type: "device_code",
        url: "https://auth.openai.com/device?token=example-secret#do-this",
        userCode: "ABCD-12345",
      }),
    ).toEqual({
      type: "device_code",
      url: "https://auth.openai.com/device",
      userCode: "ABCD-12345",
    });
  });
});
