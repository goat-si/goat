import { assert, it } from "@effect/vitest";
import { makeClaudeUserMessage } from "./ClaudeAdapterV2.ts";

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
