import { describe, expect, it, vi } from "vite-plus/test";
import { GhosttyTerminalCore, type GhosttyCell, type GhosttyRow } from "./core";
import { terminalLinkAtPositionWithRange } from "./surfaceLinks";

vi.mock("./vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("./vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("./vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("./vendor/ghostty-write-pty.wasm?inline")).default,
}));

const cell = (text: string): GhosttyCell => ({
  text,
  wide: 0,
  foreground: { r: 255, g: 255, b: 255 },
  background: { r: 0, g: 0, b: 0 },
  bold: false,
  italic: false,
  invisible: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
});

describe("terminalLinkAtPositionWithRange", () => {
  it.each([
    { text: "https://example.com/日本", cols: 80, end: { x: 23, y: 0 } },
    { text: "src/日本/main.ts:3:1", cols: 80, end: { x: 19, y: 0 } },
    { text: "https://example.com/🙂", cols: 80, end: { x: 21, y: 0 } },
    { text: "https://example.com/日本", cols: 23, end: { x: 1, y: 1 } },
  ])("keeps every cell of $text clickable at $cols columns", async ({ text, cols, end }) => {
    const core = await GhosttyTerminalCore.create(
      cols,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      () => {},
    );
    try {
      core.write(text + " next");
      const rows = core.snapshot().rowData;
      for (let y = 0; y <= end.y; y += 1) {
        const lastColumn = y === end.y ? end.x : cols - 2;
        for (let x = 0; x <= lastColumn; x += 1) {
          expect(terminalLinkAtPositionWithRange(rows, y, x)).toEqual({
            text,
            range: { start: { x: 0, y: 0 }, end },
          });
        }
      }
      expect(terminalLinkAtPositionWithRange(rows, end.y, end.x + 1)).toBeNull();
    } finally {
      core.dispose();
    }
  });

  it("activates a wrapped quoted Windows path from its spaces and position suffix", () => {
    const row = (text: string, isWrapContinuation: boolean): GhosttyRow => ({
      cells: Array.from(text, (character) => cell(character)),
      text,
      isWrapContinuation,
      wrapsToNext: false,
    });
    const first = String.raw`"C:\Users\Jane `;
    const second = String.raw`Doe\index.ts":12:7`;
    const rows = [row(first, false), row(second, true)];
    const expected = {
      text: String.raw`C:\Users\Jane Doe\index.ts:12:7`,
      range: { start: { x: 1, y: 0 }, end: { x: second.length - 1, y: 1 } },
    };
    expect(terminalLinkAtPositionWithRange(rows, 0, first.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 1, second.length - 1)).toEqual(expected);
    expect(terminalLinkAtPositionWithRange(rows, 0, 0)).toBeNull();
  });

  it("maps terminal cells to UTF-16 offsets after a wide emoji", () => {
    const cells = [
      cell("🙂"),
      cell(""),
      ...Array.from("https://exa.test", (character) => cell(character)),
    ];
    const row: GhosttyRow = {
      cells,
      text: cells
        .map((value) => value.text || " ")
        .join("")
        .trimEnd(),
      isWrapContinuation: false,
      wrapsToNext: false,
    };

    expect(terminalLinkAtPositionWithRange([row], 0, 2)?.text).toBe("https://exa.test");
    expect(terminalLinkAtPositionWithRange([row], 0, cells.length - 1)?.text).toBe(
      "https://exa.test",
    );
    expect(terminalLinkAtPositionWithRange([row], 0, 0)).toBeNull();
    expect(terminalLinkAtPositionWithRange([row], 0, 8)?.range).toEqual({
      start: { x: 2, y: 0 },
      end: { x: cells.length - 1, y: 0 },
    });
  });

  it("uses shared path matching and reconstructs soft-wrapped links", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    const rows = [
      row("https://example.", false),
      row("com/reference", true),
      row("~/project/file", false),
      row("C:\\repo\\file.ts", false),
      row("PS C:\\repo\\dir 1", false, true),
      row("\\test> ", true),
    ];

    expect(terminalLinkAtPositionWithRange(rows, 0, 8)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)?.text).toBe("https://example.com/reference");
    expect(terminalLinkAtPositionWithRange(rows, 2, 2)?.text).toBe("~/project/file");
    expect(terminalLinkAtPositionWithRange(rows, 3, 4)?.text).toBe("C:\\repo\\file.ts");
    expect(terminalLinkAtPositionWithRange(rows, 4, 13)).toEqual({
      text: "C:\\repo\\dir 1\\test",
      range: { start: { x: 3, y: 4 }, end: { x: 4, y: 5 } },
    });
    expect(terminalLinkAtPositionWithRange(rows, 5, 2)?.text).toBe("C:\\repo\\dir 1\\test");
    expect(terminalLinkAtPositionWithRange(rows, 5, 5)).toBeNull();
    expect(terminalLinkAtPositionWithRange(rows, 1, 4)).toEqual({
      text: "https://example.com/reference",
      range: {
        start: { x: 0, y: 0 },
        end: { x: 12, y: 1 },
      },
    });
  });

  it("refuses links truncated at the viewport edges instead of mis-resolving", () => {
    const row = (text: string, isWrapContinuation: boolean, wrapsToNext = false): GhosttyRow => ({
      cells: Array.from(text.padEnd(16), (character) => cell(character)),
      text: text.trimEnd(),
      isWrapContinuation,
      wrapsToNext,
    });
    const headCut = [row("ple.com/missing", true), row("head", true)];
    expect(terminalLinkAtPositionWithRange(headCut, 0, 4)).toBeNull();
    const tailCut = [row("https://exa.test", false, true)];
    expect(terminalLinkAtPositionWithRange(tailCut, 0, 8)).toBeNull();
    const complete = [row("https://exa.test", false), row("", false)];
    expect(terminalLinkAtPositionWithRange(complete, 0, 8)?.text).toBe("https://exa.test");
    const wideFull: GhosttyRow = {
      cells: [
        { ...cell("🙂"), wide: 1 },
        { ...cell(""), wide: 2 },
        ...Array.from("https://t3.code", (character) => cell(character)),
      ],
      text: "🙂 https://t3.code",
      isWrapContinuation: false,
      wrapsToNext: true,
    };
    expect(terminalLinkAtPositionWithRange([wideFull], 0, 8)).toBeNull();
    const unwrittenTail: GhosttyRow = {
      cells: [
        ...Array.from("https://exa.test", (character) => cell(character)),
        cell(""),
        cell(""),
      ],
      text: "https://exa.test",
      isWrapContinuation: false,
      wrapsToNext: false,
    };
    expect(terminalLinkAtPositionWithRange([unwrittenTail], 0, 8)?.text).toBe("https://exa.test");
  });
});
