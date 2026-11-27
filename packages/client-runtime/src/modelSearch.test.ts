import { describe, expect, it } from "vite-plus/test";

import { rankModelPickerSearch, type ModelPickerSearchableModel } from "./modelSearch.ts";

const catalog: ReadonlyArray<ModelPickerSearchableModel> = [
  {
    driverKind: "claudeAgent",
    providerDisplayName: "Claude",
    name: "Claude Opus 4.5",
  },
  {
    driverKind: "opencode",
    providerDisplayName: "OpenCode",
    name: "DeepSeek V4.1 Flash 1017",
    slug: "opencode-go/deepseek-v4.1-flash",
    subProvider: "OpenCode Go",
  },
];

function search(
  query: string,
  models: ReadonlyArray<ModelPickerSearchableModel> = catalog,
): string[] {
  return rankModelPickerSearch(models, query, (model) => model).map((model) => model.name);
}

describe("rankModelPickerSearch", () => {
  it("finds a model by its full or bare ID when the name is written differently", () => {
    expect(search("opencode-go/deepseek-v4.1-flash")).toEqual(["DeepSeek V4.1 Flash 1017"]);
    expect(search("deepseek-v4.1-flash")).toEqual(["DeepSeek V4.1 Flash 1017"]);
  });
});
