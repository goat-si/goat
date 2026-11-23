import { assert, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

const decodeSettings = Schema.decodeSync(ClaudeSettings);

it("passes each plugin directory without consuming prompt text", () => {
  const options = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-5",
    },
    nativeThreadId: "plugins",
    resume: false,
    cwd: "/workspace",
    settings: decodeSettings({
      launchArgs:
        '--plugin-dir ./a --plugin-dir=./b.zip --append-system-prompt "--plugin-dir=./prompt"',
    }),
  });
  assert.deepEqual(options.plugins, [
    { type: "local", path: "./a" },
    { type: "local", path: "./b.zip" },
  ]);
  assert.isUndefined(options.extraArgs?.["plugin-dir"]);
  const bare = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-5",
    },
    nativeThreadId: "bare",
    resume: false,
    cwd: "/workspace",
    settings: decodeSettings({ launchArgs: "--plugin-dir --verbose" }),
  });
  assert.isUndefined(bare.plugins);
  assert.isNull(bare.extraArgs?.["plugin-dir"]);
});
