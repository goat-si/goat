import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import LargeTextViewer from "./LargeTextViewer";

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

it.each([
  [1024, false],
  [1025, true],
] as const)(
  "shows the column truncation banner only when a CSV exceeds 1,024 columns (%i columns)",
  async (columnCount, truncated) => {
    const row = Array.from({ length: columnCount }, (_, i) => i).join(",");
    await using screen = await render(
      <LargeTextViewer name="wide.csv" text={`${row}\n${row}\n`} delimiter="," />,
    );
    const hasBanner = () =>
      screen.container.textContent?.includes("Showing the first 1,024 columns") ?? false;
    expect(hasBanner()).toBe(truncated);
    const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
    await vi.waitFor(() => expect(status()).toContain("1 row · 1,024 columns"), 10_000);
    expect(hasBanner()).toBe(truncated);
  },
);
