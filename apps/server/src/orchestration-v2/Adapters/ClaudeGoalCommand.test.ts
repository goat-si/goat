import { assert, it } from "@effect/vitest";
import { ClaudeSettings, RunAttemptId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeClaudeUserMessage } from "./ClaudeAdapterV2.ts";
import { layerClaudeAdapterTest } from "./ClaudeAdapterTestLayer.testkit.ts";
import { makeWakeHarnessWithOptions } from "./ClaudeWakeHarness.testkit.ts";
import { CLAUDE_TEST_RUNTIME_POLICY, makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("keeps a /goal that mentions a skill as one native goal command", () => {
  const message = makeClaudeUserMessage({
    text: "/goal fix all the gaps.\ndecompile target.ipa into ./target/\n$review",
    skills: new Map([["review", { path: "/home/me/.claude/skills/review/SKILL.md" }]]),
  });
  const content = message.message.content;
  assert.isString(content);
  assert.match(
    content as string,
    /^\/goal fix all the gaps\.\ndecompile target\.ipa into \.\/target\/\n/,
  );
});

it("dispatches user skill mentions and ignores mentions in inline handoff history", () => {
  const history = "Context handoff:\n$review historical request\n\nUser message:\n";
  const skills = new Map([["review", { path: "/home/me/.claude/skills/review/SKILL.md" }]]);
  const historical = makeClaudeUserMessage({
    text: `${history}continue`,
    skills,
    skillMentionsFrom: history.length,
  });
  assert.equal(historical.message.content, `${history}continue`);
  const current = makeClaudeUserMessage({
    text: `${history}$review now`,
    skills,
    skillMentionsFrom: history.length,
  });
  assert.isArray(current.message.content);
  assert.match(JSON.stringify(current.message.content), /\/review/);
});

it.effect("does not dispatch skill mentions from inline handoff history", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "goat-claude-skill-handoff-" });
      const directory = path.join(homePath, "skills", "review");
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(
        path.join(directory, "SKILL.md"),
        "---\nname: review\n---\nFollow the review instructions.\n",
      );
      const harness = yield* makeWakeHarnessWithOptions({
        settings: decodeClaudeSettings({ homePath }),
      });
      const history =
        "Context handoff:\n[Historical user; user_message]\n$review the diff\n\nUser message:\n";
      yield* harness.runtime.startTurn({
        ...makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("skill-handoff"),
          text: `${history}continue`,
          attachments: [],
          runtimePolicy: { ...CLAUDE_TEST_RUNTIME_POLICY, cwd: homePath },
        }),
        inlineContextLength: history.length,
      });
      const content = harness.offeredMessages[0]?.message.content;
      const blocks =
        typeof content === "string"
          ? [content]
          : (content ?? []).map((block) => (block.type === "text" ? block.text : ""));
      assert.isFalse(blocks.some((text) => text.startsWith("/review")));
      assert.include(blocks.join("\n"), "$review the diff");
    }).pipe(Effect.provide(layerClaudeAdapterTest)),
  ),
);
