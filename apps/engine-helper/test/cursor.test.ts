import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCursorRejection } from "../src/engines/cursor/rejections.ts";
import { classifyRejection, containRejections } from "../src/rejections.ts";

test("Cursor rejection classifier contains only known SDK failures", () => {
  const closed = Object.assign(new Error("WritableIterable is closed"), { name: "WriteIterableClosedError" });
  const cause = Object.assign(new Error("closed"), { code: "ERR_STREAM_WRITE_AFTER_END" });
  const connect = Object.assign(new Error("failed", { cause }), { name: "ConnectError", code: 10 });
  const abort = Object.assign(new Error("aborted"), {
    name: "AbortError", stack: "AbortError\n    at onStall (/tmp/node_modules/@cursor/sdk/dist/index.js:1:1)",
  });
  const unregister = containRejections(classifyCursorRejection);
  try {
    assert.equal(classifyRejection(closed), "Cursor SDK wrote to a closed exec stream.");
    assert.equal(classifyRejection(connect), "Cursor SDK wrote to an ended request stream.");
    assert.equal(classifyRejection(abort), "Cursor SDK aborted a stalled request.");
    assert.equal(classifyRejection(Object.assign(new Error("other"), { name: "AbortError" })), undefined);
    assert.equal(classifyRejection({ name: "WriteIterableClosedError", message: "WritableIterable is closed" }), undefined);
  } finally {
    unregister();
  }
  assert.equal(classifyRejection(closed), undefined);
});
