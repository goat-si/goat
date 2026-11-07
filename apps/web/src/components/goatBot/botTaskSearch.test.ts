import { describe, expect, it } from "vite-plus/test";
import { validateBotTaskSearch } from "./botTaskSearch";

describe("bot task search", () => {
  it("accepts a valid task id and drops invalid search values", () => {
    expect(validateBotTaskSearch({ task: "task-1" })).toEqual({ task: "task-1" });
    expect(validateBotTaskSearch({ task: "" })).toEqual({});
    expect(validateBotTaskSearch({ task: ["task-1"] })).toEqual({});
  });
});
