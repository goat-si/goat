import { expect, it } from "@effect/vitest";
import { evalServerEnv } from "./evalServerEnv.ts";

it("starts eval fixtures on their own home even when GOAT_HOME points at a real install", () => {
  const env = evalServerEnv({ GOAT_HOME: "/Users/someone/.goat", PATH: "/bin" }, "/tmp/eval/goat");
  expect(env.GOAT_HOME).toBe("/tmp/eval/goat");
  expect(env.PATH).toBe("/bin");
});
