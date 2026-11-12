import { expect, it } from "vite-plus/test";
import { filterSpeechModels } from "./speechModelBrowser";

it("sorts speed against the requested hardware reference", () => {
  const models = [
    {
      id: "a",
      name: "Alpha",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      benchmark: { cpu: 10, accelerated: 1 },
    },
    {
      id: "b",
      name: "Beta",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      benchmark: { cpu: 2, accelerated: 8 },
    },
  ];
  expect(filterSpeechModels(models, "", false, "speed", "cpu").map((model) => model.id)).toEqual([
    "b",
    "a",
  ]);
  expect(
    filterSpeechModels(models, "", false, "speed", "accelerated").map((model) => model.id),
  ).toEqual(["a", "b"]);
  const withoutCpu = { ...models[1]!, name: "Missing", benchmark: { cpu: null, accelerated: 0.1 } };
  expect(
    filterSpeechModels([withoutCpu, models[0]!], "", false, "speed", "cpu").map(
      (model) => model.name,
    ),
  ).toEqual(["Alpha", "Missing"]);
});

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

it("ranks recommended downloads after selected and installed models", () => {
  const models = [
    {
      id: "alpha",
      name: "Alpha",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      recommended: false,
    },
    {
      id: "zulu",
      name: "Zulu",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      recommended: true,
    },
    {
      id: "installed",
      name: "Installed",
      description: "",
      size: 1,
      installed: true,
      selected: false,
      recommended: false,
    },
    {
      id: "selected",
      name: "Selected",
      description: "",
      size: 1,
      installed: false,
      selected: true,
      recommended: false,
    },
  ];
  expect(filterSpeechModels(models, "", false, "recommended").map((model) => model.id)).toEqual([
    "selected",
    "installed",
    "zulu",
    "alpha",
  ]);
});
