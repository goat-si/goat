import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";

vi.mock("./ReadOnlySourcePreview", () => ({
  default: (props: { text: string }) => <pre>{props.text}</pre>,
}));

import { render } from "../../../test/render";
import { AttachmentFilePreview } from "./AttachmentFilePreview";
import BinaryViewer from "./BinaryViewer";
import { formatArchiveModifiedDate } from "./binaryPreviewProtocol";
import DocumentPages from "./DocumentPages";
import LargeTextViewer from "./LargeTextViewer";
import type { OfficeWorkerResult } from "./officePreviewProtocol";

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

it("opens extensionless UTF-8 text archive entries while rejecting binary ones", async () => {
  const bytes = await new JSZip()
    .file("CHANGELOG", "Release 1.2.3 notes")
    .file("firmware", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]))
    .generateAsync({ type: "arraybuffer" });
  const src = URL.createObjectURL(new Blob([bytes]));
  try {
    await using screen = await render(<BinaryViewer src={src} name="pkg.zip" kind="archive" />);
    await vi.waitFor(
      () => expect(screen.container.querySelectorAll("tbody button")).toHaveLength(2),
      10_000,
    );
    await screen.getByRole("button", { name: "CHANGELOG" }).click();
    await vi.waitFor(
      () => expect(screen.container.textContent).toContain("Release 1.2.3 notes"),
      10_000,
    );
    await screen.getByRole("button", { name: "Back to archive" }).click();
    await screen.getByRole("button", { name: "firmware" }).click();
    await vi.waitFor(() =>
      expect(screen.container.querySelector('[role="alert"]')?.textContent).toContain(
        "Only UTF-8 text and images can be opened inside an archive.",
      ),
    );
  } finally {
    URL.revokeObjectURL(src);
  }
});

it.each(["odt", "odp", "rtf"] as const)("preserves rendered %s spaces and tabs", async (kind) => {
  const archive = new JSZip().file(
    "content.xml",
    `<office:document>${kind === "odt" ? "<office:text>" : "<draw:page>"}<text:p>A<text:s text:c="3"/>B<text:tab/>C</text:p>${kind === "odt" ? "</office:text>" : "</draw:page>"}</office:document>`,
  );
  const bytes =
    kind === "rtf"
      ? new TextEncoder().encode(String.raw`{\rtf1\ansi A\tab B  C}`).buffer
      : await archive.generateAsync({ type: "arraybuffer" });
  const worker = new Worker(new URL("./officePreview.worker.ts", import.meta.url), {
    type: "module",
  });
  try {
    const result = await new Promise<OfficeWorkerResult>((resolve) => {
      worker.addEventListener(
        "message",
        (event: MessageEvent<OfficeWorkerResult>) => resolve(event.data),
        { once: true },
      );
      worker.postMessage({ type: "open", kind, bytes }, [bytes]);
    });
    if (result.type !== "document") throw new Error("Expected document");
    await using screen = await render(
      <DocumentPages html={result.pages[0]!.html + "<p>A\tB  C</p>"} name="spacing" output />,
    );
    await vi.waitFor(() => {
      const doc = screen.container.querySelector("iframe")?.contentDocument;
      const spans = doc?.querySelectorAll<HTMLElement>(
        kind === "rtf" ? "p[data-rtf-whitespace]" : "span[data-odf-whitespace]",
      );
      expect(doc?.querySelector("p")?.innerText).toBe(kind === "rtf" ? "A\tB  C" : "A   B\tC");
      expect(spans).toHaveLength(kind === "rtf" ? 1 : 2);
      for (const span of spans!) {
        expect(doc!.defaultView!.getComputedStyle(span).whiteSpace).toBe("pre-wrap");
        expect(span.getBoundingClientRect().width).toBeGreaterThan(0);
      }
      expect(spans![0]!.getBoundingClientRect().width).toBeGreaterThan(10);
      const plain = doc!.querySelector<HTMLElement>("p:last-child")!;
      expect(plain.innerText).toBe("A B C");
      expect(doc!.defaultView!.getComputedStyle(plain).whiteSpace).toBe("normal");
    });
  } finally {
    worker.terminate();
  }
});
