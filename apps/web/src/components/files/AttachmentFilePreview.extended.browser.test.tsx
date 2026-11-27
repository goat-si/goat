import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import BinaryViewer from "./BinaryViewer";
import { formatArchiveModifiedDate } from "./binaryPreviewProtocol";
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

it("dates an archive folder by its own ZIP record when its children come first", async () => {
  const zip = new JSZip();
  const fileDate = new Date("2022-01-02T00:00:00Z");
  zip.file("docs/readme.txt", "a".repeat(1024), { createFolders: false, date: fileDate });
  zip.file("docs/sub/nested.txt", "b".repeat(1024), { createFolders: false, date: fileDate });
  zip.file("docs/", null, { dir: true, date: new Date("2024-10-19T00:00:00Z") });
  zip.file("docs/sub/", null, { dir: true, date: new Date("2023-07-08T00:00:00Z") });
  zip.file("docs/later.txt", "c".repeat(1024), {
    createFolders: false,
    date: new Date("2025-05-06T00:00:00Z"),
  });
  const src = URL.createObjectURL(new Blob([await zip.generateAsync({ type: "arraybuffer" })]));
  try {
    await using screen = await render(<BinaryViewer src={src} name="dates.zip" kind="archive" />);
    await vi.waitFor(() => {
      expect(
        [...screen.container.querySelectorAll("tbody td")].map((cell) => cell.textContent?.trim()),
      ).toEqual(["docs", "3 KB", formatArchiveModifiedDate("2024-10-19T00:00:00.000")]);
    }, 10_000);
  } finally {
    URL.revokeObjectURL(src);
  }
});
