import { describe, expect, it } from "vite-plus/test";
import { applyPathRules, applyTextRules, findResidue } from "./engine.ts";
import { isMovableAsset, KEEP_RULES, PATH_RULES, TEXT_RULES } from "./rules.ts";

// The driver applies text rules with the keep rules, then path rules.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

describe("GOAT Connect identifiers", () => {
  it.each([
    [
      "apps/web/src/components/clerk/T3ConnectAccountPages.tsx",
      "apps/web/src/components/clerk/GoatConnectAccountPages.tsx",
    ],
    [
      "apps/web/src/components/clerk/T3ConnectSidebarSignIn.tsx",
      "apps/web/src/components/clerk/GoatConnectSidebarSignIn.tsx",
    ],
    [
      "apps/web/src/components/clerk/T3ConnectUserProfilePage.tsx",
      "apps/web/src/components/clerk/GoatConnectUserProfilePage.tsx",
    ],
    [
      "apps/web/src/components/clerk/RemoveT3ConnectEnvironmentDialog.tsx",
      "apps/web/src/components/clerk/RemoveGoatConnectEnvironmentDialog.tsx",
    ],
    [
      "apps/web/src/components/clerk/useT3ConnectAuthPrompt.tsx",
      "apps/web/src/components/clerk/useGoatConnectAuthPrompt.tsx",
    ],
    [
      "apps/mobile/src/features/cloud/T3ConnectProfilePage.tsx",
      "apps/mobile/src/features/cloud/GoatConnectProfilePage.tsx",
    ],
  ])("moves %s once", (from, to) => {
    expect(applyPathRules(from, PATH_RULES)).toBe(to);
    expect(applyPathRules(to, PATH_RULES)).toBe(to);
  });

  it("renames file names only, never a directory", () => {
    expect(applyPathRules("apps/web/src/T3Connect/index.ts", PATH_RULES)).toBe(
      "apps/web/src/T3Connect/index.ts",
    );
  });

  it("renames imports and helpers but keeps the help URL and its sections", () => {
    const path = "packages/client-runtime/src/connection/diagnosis.ts";
    const source =
      'import { t3ConnectTroubleshootingUrl, type T3ConnectTroubleshootingSection } from "@goat/contracts"; t3ConnectTroubleshootingUrl("the-host-runs-an-older-t3-code")';
    const renamed = apply(path, source);
    expect(renamed).toBe(
      'import { goatConnectTroubleshootingUrl, type GoatConnectTroubleshootingSection } from "@goat/contracts"; goatConnectTroubleshootingUrl("the-host-runs-an-older-t3-code")',
    );
    expect(apply(path, renamed)).toBe(renamed);
    const url =
      "`https://github.com/pingdotgg/t3code/blob/main/docs/user/t3-connect-troubleshooting.md#${section}`";
    expect(apply("packages/contracts/src/environmentHttp.ts", url)).toBe(url);
  });

  it("renames local console tags and keeps the relay route kind and JWT types", () => {
    const path = "apps/web/src/cloud/useCloudLinkController.ts";
    expect(apply(path, 'console.error("[t3-connect] failed")')).toBe(
      'console.error("[goat-connect] failed")',
    );
    expect(apply(path, 'console.error("[t3-cloud] failed")')).toBe(
      'console.error("[goat-cloud] failed")',
    );
    expect(apply(path, 'kind: "t3-connect"')).toBe('kind: "t3-connect"');
    expect(
      findResidue(
        "packages/client-runtime/src/connection/routes.ts",
        'kind: "t3-connect"',
        KEEP_RULES,
      ),
    ).toEqual([]);
    expect(findResidue(path, 'console.error("[t3-connect] failed")', KEEP_RULES)).toHaveLength(1);
    expect(apply("packages/shared/src/relayJwt.ts", 'typ: "t3-cloud-mint+jwt"')).toBe(
      'typ: "goat-cloud-mint+jwt"',
    );
  });

  it("renames the local page slug and settings-search id together", () => {
    expect(
      apply(
        "apps/web/src/components/clerk/T3ConnectAccountPages.tsx",
        'url: "t3-connect", __experimental_startPath: "/t3-connect"',
      ),
    ).toBe('url: "goat-connect", __experimental_startPath: "/goat-connect"');
    expect(
      apply("apps/mobile/src/features/settings/SettingsAuthRouteScreen.tsx", 'path: "t3-connect",'),
    ).toBe('path: "goat-connect",');
    expect(apply("apps/web/src/components/settings/settingsSearch.ts", 'id: "t3-connect",')).toBe(
      'id: "goat-connect",',
    );
    expect(
      apply(
        "apps/web/src/components/settings/SavedEnvironmentRows.tsx",
        'searchableSetting("t3-connect").title',
      ),
    ).toBe('searchableSetting("goat-connect").title');
  });
});

describe("leftover GOAT names", () => {
  it.each([
    [
      "packages/provider-cursor/src/server/auth.ts",
      "apiKeyName: `T3 Code - ${options.displayName}`,",
      "apiKeyName: `GOAT - ${options.displayName}`,",
    ],
    [
      "packages/provider-cursor/src/server/adapter.ts",
      "name: `T3 Code ${input.threadId}`,",
      "name: `GOAT ${input.threadId}`,",
    ],
    [
      "packages/provider-opencode/src/server/v2/textGeneration.ts",
      "title: `T3 Code ${input.operation}`,",
      "title: `GOAT ${input.operation}`,",
    ],
    [
      "apps/server/src/vcs/GitVcsDriver.ts",
      'GIT_AUTHOR_NAME: "T3 Code",',
      'GIT_AUTHOR_NAME: "GOAT",',
    ],
    [
      "apps/server/src/vcs/GitVcsDriver.ts",
      'GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",',
      'GIT_COMMITTER_EMAIL: "checkpoint@goat.invalid",',
    ],
    [
      "apps/server/src/vcs/GitVcsDriver.ts",
      "? `t3 snapshot ref=${input.ref}`",
      "? `goat snapshot ref=${input.ref}`",
    ],
    [
      "packages/source-control-github/src/server/githubStackRebase.ts",
      'GIT_CONFIG_VALUE_2: "noreply@t3.codes",',
      'GIT_CONFIG_VALUE_2: "noreply@goat.invalid",',
    ],
    [
      "packages/source-control-github/src/server/GitHubRequestPolicy.ts",
      '"user-agent": "t3code" };',
      '"user-agent": "goat" };',
    ],
    [
      "packages/source-control-bitbucket/src/client/definition.ts",
      ".git t3code-pr-${number}`",
      ".git goat-pr-${number}`",
    ],
    [
      "apps/desktop/src/compileCache.ts",
      'NodePath.join(cacheRoot, "t3code", "compile-cache")',
      'NodePath.join(cacheRoot, "goat", "compile-cache")',
    ],
    [
      "apps/mobile/src/lib/debugLog.ts",
      "console.log(`[t3-${namespace}] ${event}`);",
      "console.log(`[goat-${namespace}] ${event}`);",
    ],
    [
      "scripts/lib/brand-assets.ts",
      'productionWindowsIconIco: "assets/prod/t3-black-windows.ico",',
      'productionWindowsIconIco: "assets/prod/goat-black-windows.ico",',
    ],
    [
      "scripts/mobile-native-client.ts",
      '".cache/t3code/native-clients",',
      '".cache/goat/native-clients",',
    ],
  ])("renames the label in %s once", (path, source, expected) => {
    expect(apply(path, source)).toBe(expected);
    expect(apply(path, expected)).toBe(expected);
  });

  it("keeps the source productName, which names legacy safeStorage keys", () => {
    const line = '  "productName": "T3 Code (Alpha)"';
    expect(apply("apps/desktop/package.json", line)).toBe(line);
    expect(findResidue("apps/desktop/package.json", line, KEEP_RULES)).toEqual([]);
  });

  it("flags the old spelling if it comes back", () => {
    expect(
      findResidue("apps/server/src/vcs/GitVcsDriver.ts", 'GIT_AUTHOR_NAME: "T3 Code",', KEEP_RULES),
    ).toHaveLength(1);
    expect(
      findResidue(
        "packages/source-control-gitcafe/src/server/GitCafeApi.ts",
        '"user-agent": "t3code"',
        KEEP_RULES,
      ),
    ).toHaveLength(1);
  });

  it("moves only the listed brand assets", () => {
    expect(isMovableAsset("assets/prod/t3-black-windows.ico")).toBe(true);
    expect(applyPathRules("assets/prod/t3-black-windows.ico", PATH_RULES)).toBe(
      "assets/prod/goat-black-windows.ico",
    );
    expect(isMovableAsset("assets/prod/goat-black-windows.ico")).toBe(false);
    expect(isMovableAsset("apps/marketing/public/95/t3-code-concepts/t3-code-lime.webp")).toBe(
      false,
    );
  });
});
