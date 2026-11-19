import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { SpeechModelList } from "./speech.ts";

// Copied from origin/chase/t3-261114-next3:packages/contracts/src/speech.ts.
const PreviousSpeechBenchmark = Schema.Struct({
  cpu: Schema.NullOr(Schema.Finite),
  accelerated: Schema.NullOr(Schema.Finite),
});
const PreviousSpeechModelList = Schema.Struct({
  supportsModelLinking: Schema.optionalKey(Schema.Boolean),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String,
      size: Schema.Number,
      installed: Schema.Boolean,
      selected: Schema.Boolean,
      linkedFrom: Schema.optionalKey(Schema.String),
      recommended: Schema.optionalKey(Schema.Boolean),
      benchmark: Schema.optionalKey(PreviousSpeechBenchmark),
    }),
  ),
});

const decodePrevious = Schema.decodeSync(PreviousSpeechModelList);
const decodeCurrent = Schema.decodeSync(SpeechModelList);

it("older clients ignore recommendation metadata in new server responses", () => {
  const response = {
    models: [
      {
        id: "m",
        name: "M",
        description: "",
        size: 1,
        installed: false,
        selected: false,
        languages: ["en"],
        accuracy: { en: 2 },
      },
    ],
  };
  const decoded = decodePrevious(response);
  expect(decoded.models[0]).not.toHaveProperty("languages");
  expect(decoded.models[0]).not.toHaveProperty("accuracy");
  expect(decodeCurrent(response).models[0]).toMatchObject({
    languages: ["en"],
    accuracy: { en: 2 },
  });
});
