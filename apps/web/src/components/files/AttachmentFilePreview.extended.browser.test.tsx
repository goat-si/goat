import { expect, it } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";

it.each([
  ["firmware", "Save it to open in an app that supports this format."],
  [".cache", "Save it to open in an app that supports this format."],
  ["a.dir/firmware", "Save it to open in an app that supports this format."],
  ["blob.foo", "Save it to open in an app that supports foo files."],
] as const)(
  "describes unsupported binary attachment %s without misreading its name as an extension",
  async (name, expected) => {
    const file = new Blob([new Uint8Array([0, 1, 2, 3])], { type: "application/octet-stream" });
    await using screen = await render(
      <AttachmentFilePreview name={name} mimeType={file.type} sizeBytes={file.size} file={file} />,
    );
    await expect
      .element(screen.getByText("No preview for this file", { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText(expected, { exact: true })).toBeVisible();
  },
);
