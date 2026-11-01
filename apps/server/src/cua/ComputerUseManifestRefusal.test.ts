import { assert, describe, it } from "@effect/vitest";

import { typeManifestRefusal } from "./ComputerUseManifestRefusal.ts";

// Recorded from cua-driver 0.38.0-goat.3 in standard mode with a manifest that leaves kill_app out.
const OUTSIDE =
  '{"jsonrpc":"2.0","id":2,"result":{"content":[{"text":"Permission denied: tool \'kill_app\' is outside the capability manifest","type":"text"}],"isError":true,"structuredContent":{"code":"permission_denied"}}}';

describe("typeManifestRefusal", () => {
  it("tells a manifest denial apart from a missing macOS grant, keeping the driver's code", () => {
    const typed = JSON.parse(typeManifestRefusal(OUTSIDE));
    assert.deepStrictEqual(typed.result.structuredContent, {
      code: "permission_denied",
      refused: "targetRefused",
      detail: "outside_manifest",
    });
    assert.include(typed.result.content.at(-1).text, "not a missing macOS permission");
  });

  it("leaves a missing Accessibility grant and other answers as the driver wrote them", () => {
    const tcc = JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "Accessibility permission is not granted" }],
        isError: true,
        structuredContent: { code: "permission_denied" },
      },
    });
    const succeeded = OUTSIDE.replace('"isError":true', '"isError":false');
    for (const line of [tcc, succeeded, "not json"])
      assert.strictEqual(typeManifestRefusal(line), line);
  });
});
