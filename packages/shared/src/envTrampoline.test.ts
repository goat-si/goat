import { expect, it } from "vite-plus/test";
import { envTrampoline } from "./envTrampoline.ts";

it("preserves argument boundaries and rejects names env would reinterpret", () => {
  expect(envTrampoline("tool", ["a b", "--", "x=y"], "/path with spaces")).toEqual({
    command: "/usr/bin/env",
    args: ["-C", "/path with spaces", "--", "tool", "a b", "--", "x=y"],
  });
  for (const command of ["", "-", "X=Y"])
    expect(envTrampoline(command, [], "/tmp")).toBeUndefined();
});
