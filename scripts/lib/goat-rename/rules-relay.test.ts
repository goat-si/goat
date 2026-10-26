import { describe, expect, it } from "vite-plus/test";
import { applyTextRules, findResidue } from "./engine.ts";
import { KEEP_RULES, TEXT_RULES } from "./rules.ts";

// The driver applies text rules with the keep rules.
const apply = (path: string, text: string) =>
  applyTextRules(path, text, TEXT_RULES, KEEP_RULES).text;

describe("GOAT Connect relay names", () => {
  it("renames relay wire, token and infra names once", () => {
    const path = "infra/relay/src/hooks/HookForwarder.ts";
    const text = [
      'headers["x-t3-relay-delivery-id"] = id; headers["x-t3-hook-outcome"] = outcome;',
      'const typ = "t3-env-credential+jwt"; const issuer = "t3-env:" + id;',
      'const name = "t3code-relay"; const tunnel = "t3coderelay-managedendpoint-dev-julius-abc";',
      'const kind = "t3_relay"; const prefix = "t3env_";',
    ].join("\n");
    const once = apply(path, text);
    expect(once).toBe(
      [
        'headers["x-goat-relay-delivery-id"] = id; headers["x-goat-hook-outcome"] = outcome;',
        'const typ = "goat-env-credential+jwt"; const issuer = "goat-env:" + id;',
        'const name = "goat-relay"; const tunnel = "goatrelay-managedendpoint-dev-alex-abc";',
        'const kind = "goat_relay"; const prefix = "goatenv_";',
      ].join("\n"),
    );
    expect(apply(path, once)).toBe(once);
    expect(findResidue(path, once, KEEP_RULES)).toEqual([]);
  });

  it("keeps the saved route kind and the cached client id reader", () => {
    const catalog = 'Schema.Struct({ kind: Schema.Literal("t3-connect") }),';
    expect(apply("packages/contracts/src/connectionCatalog.ts", catalog)).toBe(catalog);
    const reader =
      'clientId: Schema.Literals(["goat-mobile", "goat-web", LEGACY_RELAY_CLIENT_IDS.mobile]),';
    expect(apply("apps/mobile/src/features/cloud/managedRelayTokenStore.ts", reader)).toBe(reader);
  });

  it("moves internals links and leaves the troubleshooting mirror alone", () => {
    const index = [
      "- [T3 Connect](./internals/t3-connect.md)",
      "- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)",
    ].join("\n");
    expect(apply("docs/README.md", index)).toBe(
      [
        "- [GOAT Connect](./internals/goat-connect.md)",
        "- [T3 Connect troubleshooting](./user/t3-connect-troubleshooting.md)",
      ].join("\n"),
    );
  });

  it("rewrites sentences that contrast the old stack", () => {
    expect(
      apply(
        "packages/shared/src/goatConnect.ts",
        " * GOAT Connect will replace T3 Connect (Clerk sign-in)",
      ),
    ).toBe(" * GOAT Connect will replace upstream's Connect stack (Clerk sign-in)");
  });
});
