import JSZip from "jszip";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../../test/render";
import Spreadsheet from "./Spreadsheet";

it("advances from the focused sheet on consecutive arrow presses", async () => {
  const zip = new JSZip();
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  zip.file(
    "xl/workbook.xml",
    `<workbook xmlns:r="${rel}"><sheets>${["First", "Second", "Third"].map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="s${i}"/>`).join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<Relationships>${[0, 1, 2].map((i) => `<Relationship Id="s${i}" Type="${rel}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join("")}</Relationships>`,
  );
  for (const i of [0, 1, 2])
    zip.file(
      `xl/worksheets/sheet${i}.xml`,
      `<worksheet><sheetData><row r="1"><c r="A1"><v>${i}</v></c></row></sheetData></worksheet>`,
    );
  const bytes = await zip.generateAsync({ type: "arraybuffer" });
  await using screen = await render(
    <Spreadsheet
      bytes={bytes}
      view={{ hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } }}
      onDetails={vi.fn()}
      onError={vi.fn()}
    />,
    { router: false /* no navigation */ },
  );
  const first = screen.getByRole("tab", { name: "First" });
  await expect.element(first).toBeVisible();
  const button = screen.container.querySelector<HTMLButtonElement>('[role="tab"]');
  if (!button) throw new Error("missing first tab");
  button.focus();
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  document.activeElement?.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
  );
  await expect.element(screen.getByRole("tab", { name: "Third" })).toHaveFocus();
  await expect
    .element(screen.getByRole("tab", { name: "Third" }))
    .toHaveAttribute("aria-selected", "true");
});
