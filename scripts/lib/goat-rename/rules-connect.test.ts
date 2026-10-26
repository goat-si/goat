import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

// Production applies text rules with the keep rules, so held lines behave as they do on a chase.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

describe("GOAT Connect copy", () => {
  it.each([
    ["apps/server/src/cli/connect.ts", "Run `goat connect link` to enable T3 Connect."],
    [
      "apps/mobile/src/features/cloud/ConnectOnboardingRouteScreen.tsx",
      "Sign in to your T3 account to set up T3 Connect.",
    ],
    [
      "docs/internals/remote.md",
      "Tailscale, SSH, and T3 Connect change how the client reaches that server",
    ],
  ])("flags and then renames GOAT copy in %s", (path, source) => {
    expect(findResidue(path, source, KEEP_RULES)).toHaveLength(1);
    const renamed = apply(path, source);
    expect(renamed).not.toMatch(/T3 (?:Connect|account)/);
    expect(renamed).toMatch(/GOAT (?:Connect|account)/);
    expect(findResidue(path, renamed, KEEP_RULES)).toEqual([]);
    expect(apply(path, renamed)).toBe(renamed);
  });

  // The fixture keep masks T3 spellings in tests, so this proves the rewrite rather than the residue gate.
  it("renames the copy that tests assert", () => {
    const path = "packages/client-runtime/src/connection/routes.test.ts";
    expect(apply(path, 'expect(label).toBe("T3 Connect");')).toBe(
      'expect(label).toBe("GOAT Connect");',
    );
  });

  it("leaves the mirrored upstream troubleshooting guide alone", () => {
    const path = "docs/user/t3-connect-troubleshooting.md";
    const source = "T3 Connect could not reach the host's tunnel.";
    expect(apply(path, source)).toBe(source);
    expect(findResidue(path, source, KEEP_RULES)).toEqual([]);
  });

  it.each([
    [
      "docs/operations/release.md",
      "After changing a variable or secret, run the **Deploy T3 Connect relay** workflow manually from",
      "After changing a variable or secret, run the **Deploy GOAT Connect relay** workflow manually from",
    ],
    [
      "packages/shared/src/goatConnect.ts",
      " * GOAT Connect will replace T3 Connect (Clerk sign-in plus the hosted relay). Until it ships,",
      " * GOAT Connect will replace upstream's Connect stack (Clerk sign-in plus the hosted relay). Until it ships,",
    ],
    [
      "docs/user/telemetry.md",
      "T3 Code also sends relay connection traces to Axiom to diagnose T3 Connect connectivity.",
      "GOAT also sends relay connection traces to Axiom to diagnose GOAT Connect connectivity.",
    ],
  ])(
    "renames the relay sentences, upstream wording included, in %s",
    (path, upstream, expected) => {
      expect(apply(path, upstream)).toBe(expected);
      expect(apply(path, expected)).toBe(expected);
      expect(findResidue(path, expected, KEEP_RULES)).toEqual([]);
    },
  );

  it("relabels the retitled guides in the docs index and keeps the troubleshooting mirror", () => {
    const path = "docs/README.md";
    expect(apply(path, "- [T3 Connect](./internals/t3-connect.md)")).toBe(
      "- [GOAT Connect](./internals/goat-connect.md)",
    );
    expect(apply(path, "- [T3 Connect setup](./operations/connect-setup.md)")).toBe(
      "- [GOAT Connect setup](./operations/connect-setup.md)",
    );
    const mirror = "- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)";
    expect(apply(path, mirror)).toBe(mirror);
  });

  it("renames the line-wrapped phrases only in their files", () => {
    expect(
      apply("apps/web/src/components/clerk/T3ConnectUserProfilePage.tsx", "available through T3"),
    ).toBe("available through GOAT");
    expect(apply("apps/server/src/telemetry/Identify.ts", " * weakest. `connect` is the T3")).toBe(
      " * weakest. `connect` is the GOAT",
    );
    expect(apply("apps/server/src/cli/connect.ts", "The T3 relay client is required")).toBe(
      "The GOAT relay client is required",
    );
    expect(findResidue("apps/web/src/other.tsx", "available through T3", KEEP_RULES)).toHaveLength(
      1,
    );
  });

  it("renames relay wire values and keeps the saved route kind and help URL", () => {
    const path = "apps/web/src/components/settings/SavedEnvironmentRows.tsx";
    const kind = 'kind: "t3-connect"';
    expect(apply(path, kind)).toBe(kind);
    expect(apply(path, 'fetch("/api/t3-connect/mint-credential")')).toBe(
      'fetch("/api/goat-connect/mint-credential")',
    );
    expect(apply(path, 'headers["x-t3-relay-delivery-id"]')).toBe(
      'headers["x-goat-relay-delivery-id"]',
    );
    const help =
      "https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#the-host-runs-an-older-t3-code";
    expect(apply("packages/contracts/src/environmentHttp.ts", help)).toBe(help);
  });
});

describe("project file copy", () => {
  it("names goat.json in settings descriptions and keeps the t3.json search alias", () => {
    const settings = "apps/web/src/components/settings/ProjectDefaultsSettings.tsx";
    expect(apply(settings, "Projects and their t3.json can override it.")).toBe(
      "Projects and their goat.json can override it.",
    );
    const mobile = "apps/mobile/src/features/settings/SettingsServerControlsRouteScreen.tsx";
    expect(apply(mobile, "Use the repository's t3.json, or Local.")).toBe(
      "Use the repository's goat.json, or Local.",
    );
    const search = "apps/web/src/components/settings/settingsSearch.ts";
    const terms = 'searchTerms: ["git submodule worktree t3.json"],';
    const renamed = apply(search, terms);
    expect(renamed).toBe('searchTerms: ["git submodule worktree goat.json t3.json"],');
    expect(apply(search, renamed)).toBe(renamed);
    expect(apply("apps/server/src/project/x.ts", 'readFile("t3.json")')).toBe(
      'readFile("t3.json")',
    );
  });
});
