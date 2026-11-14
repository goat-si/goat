import { render } from "../../../test/render";
import { expect, it, vi } from "vite-plus/test";
import { AttachmentFilePreview } from "./AttachmentFilePreview";

it.each([
  ["one.csv", "text/csv", "name\nAda\n", "1 row · 1 column ·"],
  ["two.csv", "text/csv", "name,count\nAda,1\nGrace,2\n", "2 rows · 2 columns ·"],
  ["one.tsv", "text/tab-separated-values", "name\nAda\n", "1 row · 1 column ·"],
  ["one.txt", "text/plain", "a".repeat(1024 * 1024) + "\n", "1 line ·"],
  ["two.txt", "text/plain", ("a".repeat(512 * 1024) + "\n").repeat(2), "2 lines ·"],
] as const)("labels the counts of %s in the status line", async (name, mimeType, text, label) => {
  const file = new Blob([text], { type: mimeType });
  await using screen = await render(
    <AttachmentFilePreview name={name} mimeType={mimeType} sizeBytes={file.size} file={file} />,
  );
  const status = () => screen.container.querySelector('[role="status"]')?.textContent ?? "";
  await vi.waitFor(() => expect(status()).toMatch(/ [KM]?B$/), { timeout: 10_000 });
  expect(status()).toContain(label);
});
