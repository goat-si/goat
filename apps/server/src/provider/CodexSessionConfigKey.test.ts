import { CodexSettings } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { codexSessionConfigKey } from "./CodexSessionConfigKey.ts";

const settings = Schema.decodeSync(CodexSettings)({});
const environment = { PATH: "/usr/bin", HOME: "/home/goat" };
const key = codexSessionConfigKey(settings, environment);

it("settings that reach the Codex process restart it; custom models do not", () => {
  for (const changed of [
    { ...settings, binaryPath: "/opt/opencodex/bin/codex" },
    { ...settings, homePath: "/tmp/codex-home" },
    { ...settings, enabled: false },
    { ...settings, opencodexBaseUrl: "http://127.0.0.1:9999" },
    { ...settings, launchArgs: "--profile work" },
    { ...settings, modelRoute: settings.modelRoute === "opencodex" ? "default" : "opencodex" },
    { ...settings, opencodexAuth: settings.opencodexAuth === "none" ? "openai" : "none" },
  ] satisfies ReadonlyArray<CodexSettings>)
    assert.notStrictEqual(codexSessionConfigKey(changed, environment), key);
  assert.notStrictEqual(
    codexSessionConfigKey(settings, { ...environment, OPENAI_API_KEY: "sk-new" }),
    key,
  );
  assert.strictEqual(
    codexSessionConfigKey(
      { ...settings, customModels: [{ slug: "gpt-x", name: "GPT X" }] } as CodexSettings,
      { HOME: "/home/goat", PATH: "/usr/bin" },
    ),
    key,
  );
});
