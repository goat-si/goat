import { expect, it } from "vite-plus/test";
import { validatePaths } from "./PreviewUpload.ts";

it("refuses a missing upload path before page input", async () => {
  await expect(validatePaths(["/goat-no-such-file-98e35a4c"])).rejects.toMatchObject({
    tag: "PreviewAutomationExecutionError",
    detail: { beforeInput: true },
  });
});
