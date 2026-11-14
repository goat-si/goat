import { assert } from "@effect/vitest";
import { CodexSettings } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkCodexProviderStatus } from "./CodexProvider.ts";
import { accountProbeStatus } from "./CodexProviderAccount.ts";

const decodeSettings = Schema.decodeSync(CodexSettings);

export const codexHomeHintRegression = Effect.fn("codexHomeHintRegression")(function* () {
  const homePath = "/srv/codex-work-home";
  const snapshot = {
    version: "1.0.0",
    account: { account: null, requiresOpenaiAuth: true },
    models: [],
    skills: [],
  };
  const status = yield* checkCodexProviderStatus(
    decodeSettings({ binaryPath: "codex", homePath }),
    () => Effect.succeed(snapshot),
  );
  assert.strictEqual(status.auth.status, "unauthenticated");
  assert.include(status.message ?? "", "CODEX_HOME");
  assert.include(status.message ?? "", homePath);
  const routed = accountProbeStatus(
    { ...snapshot, effectiveBaseUrl: "https://example.test" },
    homePath,
  );
  assert.strictEqual(routed.status, "ready");
  assert.isUndefined(routed.message);
});
