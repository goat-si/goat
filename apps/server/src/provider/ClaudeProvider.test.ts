import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it.effect("reports a missing probe cwd instead of a missing Claude executable", () =>
  Effect.gen(function* () {
    const cwd = "/goat-test-missing-claude-cwd-497";
    const settings = decodeClaudeSettings({ enabled: true, binaryPath: "claude" });
    const snapshot = yield* checkClaudeProviderStatus(settings, undefined, {}, cwd);
    assert.equal(snapshot.installed, true);
    assert.include(snapshot.message ?? "", cwd);
  }).pipe(Effect.provide(NodeServices.layer)),
);
