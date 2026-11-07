import { expect, it } from "vite-plus/test";
import { filterSpeechModels } from "./speechModelBrowser";

it("filters models and orders them by the selected criterion", () => {
  const models = [
    {
      id: "a",
      name: "Alpha",
      description: "English",
      size: 300,
      installed: false,
      selected: false,
    },
    {
      id: "b",
      name: "Beta",
      description: "Multilingual",
      size: 100,
      installed: true,
      selected: true,
    },
    {
      id: "c",
      name: "Charlie",
      description: "English",
      size: 200,
      installed: true,
      selected: false,
    },
  ];
  expect(filterSpeechModels(models, "english", false, "size").map((model) => model.id)).toEqual([
    "c",
    "a",
  ]);
  expect(filterSpeechModels(models, "", true, "name").map((model) => model.id)).toEqual(["b", "c"]);
  expect(filterSpeechModels(models, "", false, "recommended").map((model) => model.id)).toEqual([
    "b",
    "c",
    "a",
  ]);
});
