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
