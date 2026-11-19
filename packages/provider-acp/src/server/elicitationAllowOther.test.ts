import { assert, it } from "@effect/vitest";
import { parseElicitationForm } from "./elicitationForm.ts";

it("accepts nonblank free text only for explicitly opted-in single choices", () => {
  const schema = {
    type: "object",
    required: ["answer"],
    properties: { answer: { type: "string", enum: ["yes", "no"] } },
  };
  const enabled = parseElicitationForm(schema, "Choose", { allowOther: true });
  const oldPeer = parseElicitationForm(schema, "Choose");
  assert(enabled && oldPeer);
  assert.deepStrictEqual(enabled.content({ answer: "custom" }), { answer: "custom" });
  assert.deepStrictEqual(enabled.content({ answer: "yes" }), { answer: "yes" });
  assert.strictEqual(enabled.content({ answer: "  " }), undefined);
  assert.strictEqual(oldPeer.content({ answer: "custom" }), undefined);
  const multi = parseElicitationForm(
    {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "array", items: { type: "string", enum: ["yes"] } } },
    },
    "Choose",
    { allowOther: true },
  );
  assert(multi);
  assert.strictEqual(multi.content({ answer: ["custom"] }), undefined);
  const companion = parseElicitationForm(
    {
      type: "object",
      required: ["answer"],
      properties: { answer: { type: "string", enum: ["yes"] }, answer__other: { type: "string" } },
    },
    "Choose",
    { allowOther: true },
  );
  assert(companion);
  assert.strictEqual(companion.content({ answer: "custom" }), undefined);
});
