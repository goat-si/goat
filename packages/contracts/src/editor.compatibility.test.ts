import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { EditorId, LaunchEditorInput } from "./editor.ts";

const oldSchema = Schema.Struct({
  cwd: Schema.String,
  editor: EditorId,
  reveal: Schema.optional(Schema.Boolean),
});
const decodeOld = Schema.decodeUnknownSync(oldSchema);
const decodeCurrent = Schema.decodeUnknownSync(LaunchEditorInput);

it("accepts older editor requests and older decoders ignore the optional project root", () => {
  const oldInput = { cwd: "/work/file.ts:3", editor: "webstorm" };
  expect(decodeCurrent(oldInput)).toEqual(oldInput);
  expect(decodeOld({ ...oldInput, projectRoot: "/work" })).toEqual(oldInput);
  expect(() => decodeCurrent({ ...oldInput, projectRoot: " " })).toThrow();
});
