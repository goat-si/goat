import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { normalizeCardDetails, SecretRequestAnswerInput } from "./secretRequest.ts";

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

it("normalizes card numbers and years while preserving CVC and name", () => {
  expect(
    normalizeCardDetails({
      number: "1234 5678-9012 3456",
      expiryMonth: "01",
      expiryYear: "29",
      cvc: "003",
      name: "  A Person  ",
    }),
  ).toEqual({
    number: "1234567890123456",
    expiryMonth: "01",
    expiryYear: "2029",
    cvc: "003",
    name: "  A Person  ",
  });
});

it("rejects invalid card details", () => {
  const valid = {
    number: "123456789012",
    expiryMonth: "12",
    expiryYear: "2029",
    cvc: "1234",
    name: "A",
  };
  for (const invalid of [
    { number: "12345678901" },
    { number: "12345678901234567890" },
    { number: "12345678901x" },
    { expiryMonth: "0" },
    { expiryMonth: "13" },
    { expiryYear: "2" },
    { expiryYear: "123" },
    { cvc: "12" },
    { cvc: "12a" },
    { name: "  " },
  ])
    expect(normalizeCardDetails({ ...valid, ...invalid })).toBeUndefined();
});
