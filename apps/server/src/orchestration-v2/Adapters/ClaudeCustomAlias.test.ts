import { ClaudeSettings } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  scopeClaudeModelCatalog,
} from "../../provider/ClaudeModelCatalog.ts";
import { CLAUDE_TEST_MODEL_SELECTION } from "./ClaudeTestInput.testkit.ts";
import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const settings = decodeClaudeSettings({ customModels: ["opus"] });
it("sends a custom model named like a Claude Code alias to the API unchanged", () => {
  const options = makeClaudeQueryOptions({
    modelSelection: { instanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId, model: "opus" },
    modelCatalog: scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, settings.customModels),
    nativeThreadId: "native-custom-alias",
    resume: false,
    cwd: "/workspace",
    settings,
  });
  const env =
    typeof options.settings === "object" && options.settings !== null
      ? options.settings.env
      : undefined;
  assert.equal(options.model, "opus");
  assert.equal(env?.ANTHROPIC_DEFAULT_OPUS_MODEL, "opus");
});

it("sends the auto-compact window as the env var Claude Code prefers", () => {
  const settings = decodeClaudeSettings({ autoCompactWindow: "400000" });
  const options = makeClaudeQueryOptions({
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    nativeThreadId: "native-auto-compact",
    resume: false,
    cwd: "/workspace",
    settings,
  });
  const env =
    typeof options.settings === "object" && options.settings !== null
      ? options.settings.env
      : undefined;
  assert.equal(env?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "400000");
});
