import { BUNDLED_FONTS, resolveLastResortFace } from "@betteroffice/fonts";
import { describe, expect, it, vi } from "vite-plus/test";
import { sheetFace, wordFonts } from "./fonts";

const notoSansJp = BUNDLED_FONTS.find((face) => face.file === "NotoSansJP-Regular.otf")!;
const fonts = wordFonts();

describe("wordFonts", () => {
  it.each([
    ["Yu Gothic", fonts.resolve("Yu Gothic", false, false)],
    ["MS Gothic", fonts.resolve("MS Gothic", false, false)],
    ["the Japanese fallback", fonts.resolveScriptFallback?.("cjk-jp", false, false)],
  ])("draws %s with Noto Sans JP", async (_, load) => {
    const bytes = await load?.();

    expect(bytes?.byteLength).toBe(notoSansJp.byteLength);
  });
});

it.each([false, true])(
  "uses the available Comic Relief face for italic spreadsheet text (bold: %s)",
  (bold) => {
    expect(sheetFace("Comic Relief", bold, true)).toMatchObject({
      family: "Comic Relief",
      weight: bold ? 700 : 400,
      style: "normal",
    });
  },
);

it("uses the bundled last-resort face when a CJK asset is missing", async () => {
  const originalFetch = globalThis.fetch;
  using fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input, init) =>
      String(input).includes("NotoSansKR-Regular.otf")
        ? Promise.resolve(new Response(null, { status: 404 }))
        : originalFetch(input, init),
    );
  const fallback = resolveLastResortFace("Noto Sans KR", false, false, "word");
  const load = fonts.resolveScriptFallback?.("cjk-kr", false, false);
  const bytes = await load?.();

  expect(fetch.mock.calls.some(([input]) => String(input).includes("NotoSansKR-Regular.otf"))).toBe(
    true,
  );
  expect(bytes?.byteLength).toBe(fallback.byteLength);
});
