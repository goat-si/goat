import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { SecretRequestAnswerInput } from "./secretRequest.ts";

it("preserves login password whitespace while rejecting blank passwords", () => {
  const decode = Schema.decodeUnknownSync(SecretRequestAnswerInput);
  const input = {
    threadId: "thread:login",
    turnItemId: "item:login",
    answer: { type: "save_login", username: "user", password: "  pass word  " },
  };
  expect(decode(input).answer).toEqual(input.answer);
  for (const password of ["", "   "]) {
    expect(() => decode({ ...input, answer: { ...input.answer, password } })).toThrow();
  }
});
