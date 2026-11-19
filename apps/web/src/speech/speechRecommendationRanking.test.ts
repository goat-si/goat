import { expect, it } from "vite-plus/test";
import { filterSpeechModels } from "./speechModelBrowser";

it("preserves the selected model and falls back to static ranking without metrics", () => {
  const models = [
    {
      id: "static",
      name: "Static",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      recommended: true,
    },
    {
      id: "selected",
      name: "Selected",
      description: "",
      size: 1,
      installed: false,
      selected: true,
    },
    {
      id: "fast",
      name: "Fast",
      description: "",
      size: 1,
      installed: false,
      selected: false,
      languages: ["en"],
      accuracy: { en: 1 },
      benchmark: { cpu: 1, accelerated: 1 },
    },
  ];
  expect(
    filterSpeechModels(models, "", false, "recommended", "cpu", "en").map((m) => m.id),
  ).toEqual(["selected", "fast", "static"]);
  expect(
    filterSpeechModels(models, "", false, "recommended", undefined, "en").map((m) => m.id),
  ).toEqual(["selected", "static", "fast"]);
});
