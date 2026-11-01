import { describe, expect, it } from "@effect/vitest";

import {
  describeInstallFailure,
  installCommand,
  installMethod,
  parseDeviceLogin,
  relayableBrowserUrl,
} from "./ProviderHostSyncRecipes.ts";

describe("installCommand", () => {
  it("pins npm installs to the requested version in one argument", () => {
    expect(installCommand("opencode", "linux", "1.2.3")).toEqual({
      method: "npm",
      command: "npm",
      args: ["install", "-g", "opencode-ai@1.2.3"],
      latestOnly: false,
    });
    expect(installCommand("codex", "win32", null)?.args).toEqual([
      "install",
      "-g",
      "@openai/codex@latest",
    ]);
  });

  it("passes a script installer's version as its own argv entry, never inside the script", () => {
    const command = installCommand("claudeAgent", "darwin", "2.0.1")!;
    expect(command.command).toBe("bash");
    expect(command.args.slice(0, 2)).toEqual([
      "-c",
      'curl -fsSL https://claude.ai/install.sh | bash -s -- "$1"',
    ]);
    expect(command.args.slice(2)).toEqual(["goat-install", "2.0.1"]);
  });

  it("uses each vendor's Windows installer and says when it cannot pin", () => {
    const cursor = installCommand("cursor", "win32", "1.0.0")!;
    expect(cursor.command).toBe("powershell.exe");
    expect(cursor.args.at(-1)).toBe("irm 'https://cursor.com/install?win32=true' | iex");
    expect(cursor.latestOnly).toBe(true);
    expect(installCommand("claudeAgent", "win32", "2.0.1")!.args.at(-1)).toBe(
      "& ([scriptblock]::Create((irm https://claude.ai/install.ps1))) 2.0.1",
    );
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
