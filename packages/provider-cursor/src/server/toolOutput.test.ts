import { assert, describe, it } from "@effect/vitest";
import { toolOutputImages } from "@goat/shared/toolOutput";

import { cursorToolOutput } from "./toolOutput.ts";

describe("cursorToolOutput", () => {
  it("regression: an MCP image part reaches the timeline as an image block", () => {
    const output = cursorToolOutput({
      type: "mcp",
      args: { providerIdentifier: "cua-driver", toolName: "get_window_state", args: {} },
      result: {
        status: "success",
        value: {
          content: [
            { text: { text: "Finder" } },
            { image: { data: "iVBORw0KGgo=", mimeType: "image/png" } },
          ],
          isError: false,
        },
      },
    });
    assert.deepEqual(toolOutputImages(output), [{ mimeType: "image/png", data: "iVBORw0KGgo=" }]);
  });
});
