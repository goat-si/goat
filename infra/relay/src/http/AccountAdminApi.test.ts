import { it, expect } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { operatorAuthenticated } from "./AccountAdminApi.ts";

it("operator authorization accepts only the configured secret and never a client bearer", () => {
  const secret = Redacted.make("fixture-operator-secret");
  expect(operatorAuthenticated(undefined, secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-client-session", secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-operator-secret extra", secret)).toBe(false);
  expect(operatorAuthenticated(`Bearer ${"x".repeat(5000)}`, secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-operator-secret", secret)).toBe(true);
});
