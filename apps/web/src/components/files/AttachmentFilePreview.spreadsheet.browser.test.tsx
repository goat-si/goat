import { expect, it } from "vite-plus/test";
import { OFFICE_PREVIEW_MAX_COLUMNS, type OfficeWorkerResult } from "./officePreviewProtocol";

it.each([
  ["", "worksheets/./sheet1.xml", false, false],
  ["x:", "../xl/worksheets/sheet1.xml", false, false],
  ["", "/xl/worksheets/sheet1.xml", true, false],
  ["", "worksheets/sheet1.xml", false, true],
  ["", "worksheets/sheet1.xml", true, true],
])(
  "preserves %sworksheet metadata with relationship target %s",
  async (prefix, target, empty, localPrefix) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    const ns = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Chart" sheetId="2" r:id="c"/><sheet name="Sheet" sheetId="1" r:id="s"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      `<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/><Relationship Id="c" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="chartsheets/sheet1.xml"/></Relationships>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<${prefix}worksheet xmlns${prefix ? ":x" : ""}="${ns}"><${prefix}dimension ref="XFD1048576"/><${prefix}sheetViews><${prefix}sheetView showGridLines="0"/></${prefix}sheetViews><${prefix}sheetFormatPr defaultColWidth="30"/><${prefix}cols><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS - 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 10}" width="20"/><${prefix}col min="${OFFICE_PREVIEW_MAX_COLUMNS + 1}" max="${OFFICE_PREVIEW_MAX_COLUMNS + 30}" hidden="1"/></${prefix}cols><${prefix}sheetData><${prefix}row ht="42" customHeight="1" hidden="1"><${prefix}c r="A50" t="inlineStr"><${prefix}is><${prefix}t>${"value".repeat(1000)}</${prefix}t></${prefix}is></${prefix}c></${prefix}row></${prefix}sheetData><${prefix}mergeCells><${prefix}mergeCell ref="XFD1048576"/></${prefix}mergeCells></${prefix}worksheet>`
        .replace(
          /<((?:x:)?(?:col|dimension|mergeCell))\b([^>]*)\/>/g,
          prefix ? "<$1$2></$1>" : "$&",
        )
        .replace(/<sheetData>[\s\S]*?<\/sheetData>/, (data) => (empty ? "<sheetData/>" : data))
        .replace(/<(\/?)sheetData\b/g, (tag, closing: string) =>
          localPrefix ? `<${closing}x:sheetData${closing ? "" : ` xmlns:x="${ns}"`}` : tag,
        )
        .replace(/="([^"]*)"/g, (attribute, value: string) =>
          prefix || empty
            ? ` = '${value.replace(/\d/g, (digit) => `&#${digit.charCodeAt(0)};`)}'`
            : attribute,
        ),
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
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
        worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
      });
      expect(result.type).toBe("xlsx");
      if (result.type !== "xlsx") throw new Error("Expected bounded workbook");
      // The engine counts the chart sheet before it.
      expect(result.view?.hiddenGridlines).toEqual([1]);
      const bounded = await JSZip.loadAsync(result.bytes);
      const sheet = new DOMParser().parseFromString(
        await bounded.file("xl/worksheets/sheet1.xml")!.async("string"),
        "application/xml",
      );
      expect(sheet.querySelector("parsererror")).toBeNull();
      const row = sheet.getElementsByTagNameNS(ns, "row")[0];
      if (empty) expect(row).toBeUndefined();
      else {
        expect(row!.getAttribute("ht")).toBe("42");
        expect(row!.getAttribute("hidden")).toBe("1");
        expect(row!.getElementsByTagNameNS(ns, "c")[0]!.getAttribute("r")).toBe("A50");
        expect(row!.getElementsByTagNameNS(ns, "t")[0]!.textContent).toHaveLength(4096);
      }
      expect(sheet.getElementsByTagNameNS(ns, "dimension")).toHaveLength(0);
      expect(sheet.getElementsByTagNameNS(ns, "mergeCell")).toHaveLength(0);
      const columns = [...sheet.getElementsByTagNameNS(ns, "col")].map((column) =>
        ["min", "max", "width"].map((name) => column.getAttribute(name)),
      );
      // The engine ignores `defaultColWidth`, so the columns it sizes are spelled out.
      expect(columns).toEqual([
        [String(OFFICE_PREVIEW_MAX_COLUMNS - 1), String(OFFICE_PREVIEW_MAX_COLUMNS), "20"],
        // Hidden columns keep their span past the limit, so they stay hidden.
        [String(OFFICE_PREVIEW_MAX_COLUMNS + 1), String(OFFICE_PREVIEW_MAX_COLUMNS + 30), null],
        ["1", String(OFFICE_PREVIEW_MAX_COLUMNS - 2), "30"],
      ]);
    } finally {
      worker.terminate();
    }
  },
);

it("preserves merged text across tile clears", async () => {
  const { paintFrame } = await import("./office/sheet-frame");
  const canvas = new OffscreenCanvas(400, 80);
  const context = canvas.getContext("2d")!;
  paintFrame(
    context,
    {
      viewport: { x: 0, y: 0, width: 400, height: 80 },
      list: { width: 400, height: 80, commands: [] },
      tiles: [
        {
          x: 0,
          y: 0,
          clipX: 0,
          clipY: 0,
          list: {
            width: 208,
            height: 80,
            commands: [
              {
                op: "text",
                x: 2,
                y: 40,
                text: "MMMMMMMMMMMMMMMMMMMMMMMM",
                fontSize: 20,
                color: "#000",
                clip: { x: 0, y: 0, w: 400, h: 80 },
              },
            ],
          },
        },
        { x: 192, y: 0, clipX: 200, clipY: 0, list: { width: 208, height: 80, commands: [] } },
      ],
    },
    { ratio: 1, origin: { x: 0, y: 0 } },
  );
  const pixels = context.getImageData(240, 15, 100, 35).data;
  expect(pixels.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
});

it.each([false, true])(
  "bounds shared-string text including CDATA %s per cell and across sheets in the worker",
  async (cdata) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="one" sheetId="1" r:id="s"/><sheet name="two" sheetId="2" r:id="s"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="s" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    const sharedPath = cdata ? "customStrings.xml" : "sharedStrings.xml";
    archive.file(
      "xl/_rels/workbook.xml.rels",
      (await archive.file("xl/_rels/workbook.xml.rels")!.async("string")).replace(
        "</Relationships>",
        `<Relationship Id="strings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="${sharedPath}"/></Relationships>`,
      ),
    );
    const content = "x".repeat(32_767);
    archive.file(
      `xl/${sharedPath}`,
      `<sst><si><t>${cdata ? `<![CDATA[${content}]]>` : content}</t></si></sst>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      `<worksheet><sheetData>${Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}">${Array.from({ length: 50 }, (_, j) => `<c r="${j < 26 ? String.fromCharCode(65 + j) : "A" + String.fromCharCode(65 + j - 26)}${i + 1}" t="s"><v>${cdata ? "<![CDATA[0]]>" : "0"}</v></c>`).join("")}</row>`).join("")}</sheetData></worksheet>`.replace(
        '<c r="A1" t="s"><v><![CDATA[0]]></v></c>',
        `<c r="A1" t="inlineStr"><is><t><![CDATA[${content}]]></t></is></c>`,
      ),
    );
    const file = await archive.generateAsync({ type: "blob", compression: "DEFLATE" });
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
        void file
          .arrayBuffer()
          .then((bytes) => worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]));
      });
      expect(result.type).toBe("xlsx");
      if (result.type !== "xlsx") throw new Error("Expected bounded workbook");
      const bounded = await JSZip.loadAsync(result.bytes);
      const sheet = new DOMParser().parseFromString(
        await bounded.file("xl/worksheets/sheet1.xml")!.async("string"),
        "application/xml",
      );
      const cells = [...sheet.getElementsByTagName("t")].map((cell) => cell.textContent ?? "");
      expect(cells.reduce((total, cell) => total + cell.length, 0)).toBe(1024 * 1024);
      expect(Math.max(...cells.map((cell) => cell.length))).toBe(4096);
      expect(result.truncated).toBe(true);
    } finally {
      worker.terminate();
    }
  },
);

it.each(["XFD200", "XFD300", "XFD1048576", "AX500", "AZ9999999"])(
  "bounds spreadsheet cells at %s before padding",
  async (ref) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    // A nonstandard relationship target must get the same bounds.
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="custom.xml"/></Relationships>',
    );
    archive.file(
      "xl/custom.xml",
      `<worksheet><dimension ref="A1:${ref}"/><sheetData><row r="1"><c r="A1"><v>7</v></c></row><row r="${ref.replace(/\D/g, "")}">${ref === "XFD300" ? `<c r="${ref}" s="1"/>` : `<c r="${ref}"><v>9</v></c>`}</row></sheetData></worksheet>`,
    );
    const bytes = await archive.generateAsync({ type: "arraybuffer" });
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
        worker.postMessage({ type: "open", kind: "xlsx", bytes }, [bytes]);
      });
      if (ref === "AZ9999999" || ref === "XFD1048576") {
        expect(result).toMatchObject({
          type: "error",
          message: expect.stringContaining(ref === "AZ9999999" ? "invalid" : "preview limit"),
        });
      } else {
        expect(result.type).toBe("xlsx");
        if (result.type !== "xlsx") throw new Error("Expected workbook values");
        const bounded = await JSZip.loadAsync(result.bytes);
        const sheet = new DOMParser().parseFromString(
          await bounded.file("xl/custom.xml")!.async("string"),
          "application/xml",
        );
        expect(sheet.querySelector('c[r="A1"] v')?.textContent).toBe("7");
        expect(sheet.querySelectorAll("row").length).toBeLessThanOrEqual(500);
        expect(result.truncated).toBe(ref === "XFD200" || ref === "XFD300");
        if (ref === "AX500") expect(sheet.querySelector('c[r="AX500"] v')?.textContent).toBe("9");
        else expect(sheet.querySelector('c[r="' + ref + '"]')).toBeNull();
      }
    } finally {
      worker.terminate();
    }
  },
);

it.each(['<u val="double"/>', '<u val="double"></u>'])(
  "shows workbook formats and underline %s",
  async (underline) => {
    const { default: JSZip } = await import("jszip");
    const archive = new JSZip();
    archive.file(
      "xl/workbook.xml",
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Styles" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    archive.file(
      "xl/_rels/workbook.xml.rels",
      '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    );
    archive.file(
      "xl/styles.xml",
      `<styleSheet><numFmts count="4"><numFmt numFmtId="164" formatCode="0.000"/><numFmt numFmtId="65535" formatCode="0.0000"/><numFmt numFmtId="007" formatCode="&quot;￥&quot;#,##0.00"/><numFmt numFmtId="82" formatCode="[$-010409]dd-mmm-yyyy"/></numFmts><fonts count="2"><font><sz val="11"/></font><font>${underline}<sz val="11"/></font></fonts><cellXfs count="4"><xf numFmtId="0" fontId="0"/><xf numFmtId="7" fontId="0"/><xf numFmtId="82" fontId="0"/><xf numFmtId="0" fontId="1"/></cellXfs></styleSheet>`,
    );
    archive.file(
      "xl/worksheets/sheet1.xml",
      '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>100</v></c><c r="B1" s="2"><v>44986</v></c><c r="C1" s="3" t="inlineStr"><is><t>Total</t></is></c></row></sheetData></worksheet>',
    );
    const { prepareOffice } = await import("./officeArchive");
    const prepared = await prepareOffice(
      await archive.generateAsync({ type: "arraybuffer" }),
      "xlsx",
    );
    const styles = await (
      await JSZip.loadAsync(prepared.bytes)
    )
      .file("xl/styles.xml")!
      .async("string");
    expect(styles).toContain("<font><u/>");
    const worker = new Worker(new URL("./office/spreadsheet.worker.ts", import.meta.url), {
      type: "module",
    });
    try {
      const { createWorkerClient } = await import("./office/worker-rpc");
      const client = createWorkerClient<import("./office/sheet-protocol").SheetMethods>(worker);
      const bytes = prepared.bytes;
      await client.call("open", { bytes, view: prepared.view! }, { transfer: [bytes] });
      const cells = await client.call("cells", {
        sheet: 0,
        range: { top: 0, bottom: 0, left: 0, right: 1 },
      });
      // Ids under 164 that a workbook defines keep its formats, not Excel's built-in ones.
      expect(cells[0]).toEqual(["￥100.00", "01-Mar-2023"]);
    } finally {
      worker.terminate();
    }
    archive.file("xl/styles.xml", "<styleSheet><numFmts/><numFmts/></styleSheet>");
    await expect(
      prepareOffice(await archive.generateAsync({ type: "arraybuffer" }), "xlsx"),
    ).rejects.toThrow("duplicate stylesheet blocks");
  },
);

it("keeps spreadsheet dates on their calendar day west of UTC", async () => {
  const { default: JSZip } = await import("jszip");
  const archive = new JSZip();
  archive.file(
    "xl/workbook.xml",
    '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>',
  );
  archive.file(
    "xl/_rels/workbook.xml.rels",
    '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
  );
  archive.file(
    "xl/styles.xml",
    '<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  );
  archive.file(
    "xl/worksheets/sheet1.xml",
    '<worksheet><sheetData><row r="1"><c r="A1" s="1"><v>46023</v></c></row></sheetData></worksheet>',
  );
  const bytes = await archive.generateAsync({ type: "arraybuffer" });
  const workerModule = new URL(
    "./office/spreadsheet.worker.ts?worker_file&type=module",
    import.meta.url,
  ).href;
  // Give the worker a west-of-UTC default while preserving explicit format options.
  const bootstrap = URL.createObjectURL(
    new Blob(
      [
        `
    const NativeURL = URL;
    globalThis.URL = class extends NativeURL {
      constructor(input, base) { super(input, base?.startsWith("blob:") ? ${JSON.stringify(location.href)} : base); }
    };
    const format = Date.prototype.toLocaleDateString;
    Date.prototype.toLocaleDateString = function(locale, options) {
      return format.call(this, "en-US", { timeZone: "America/Los_Angeles", ...options });
    };
    await import(${JSON.stringify(workerModule)});
    postMessage({ type: "ready" });
  `,
      ],
      { type: "text/javascript" },
    ),
  );
  const worker = new Worker(bootstrap, { type: "module" });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.addEventListener(
        "message",
        (event) => {
          if (event.data.type === "ready") resolve();
        },
        { once: true },
      );
      worker.addEventListener("error", (event) => reject(new Error(event.message)), { once: true });
    });
    const { createWorkerClient } = await import("./office/worker-rpc");
    const client = createWorkerClient<import("./office/sheet-protocol").SheetMethods>(worker);
    await client.call(
      "open",
      {
        bytes,
        view: { hiddenGridlines: [], themeFonts: { major: "Calibri Light", minor: "Calibri" } },
      },
      { transfer: [bytes] },
    );
    const cells = await client.call("cells", {
      sheet: 0,
      range: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    expect(cells[0]![0]).toMatch(/^1\/1\/(26|2026)$/);
  } finally {
    worker.terminate();
    URL.revokeObjectURL(bootstrap);
  }
});
