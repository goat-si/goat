import { expect, it } from "vite-plus/test";
import { removeAgentCredits } from "./mergeMessage.ts";

it("preserves long human trailers while removing recognized agent credits", () => {
  const human = `Co-authored-by: ${"A".repeat(4_000)} <human@example.com>`;
  expect(
    removeAgentCredits(`${human}\nCo-Authored-By:\tGitHub Copilot   <NOREPLY@GITHUB.COM>\n`),
  ).toBe(human);
  expect(removeAgentCredits("Co-authored-by: Alice <noreply@github.com>\n")).toBe(
    "Co-authored-by: Alice <noreply@github.com>\n",
  );
  const malformedLink = "Generated with [Claude](https://claude.ai/[oops])";
  expect(removeAgentCredits(malformedLink)).toBe(malformedLink);
});
