import { BUNDLED_FONTS, loadBundledFontBytes } from "@betteroffice/fonts";
import { expect, it, vi } from "vite-plus/test";
import { loadFace } from "./fonts";

vi.mock("@betteroffice/fonts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@betteroffice/fonts")>()),
  loadBundledFontBytes: vi.fn(),
}));

const simSunStandIn = BUNDLED_FONTS.find((face) => face.script?.startsWith("cjk-"))!;

it("fails a font download that outlasts its own bound with a message about the fonts", async () => {
  vi.mocked(loadBundledFontBytes).mockReturnValue(new Promise(() => {}));
  vi.useFakeTimers();
  try {
    const outcome = loadFace(simSunStandIn).then(
      () => "loaded",
      (error: Error) => error.message,
    );
    // A face gets 30 seconds plus the time it takes at 256 kbit/s.
    const bound = 30_000 + Math.ceil(simSunStandIn.byteLength / 32);
    await vi.advanceTimersByTimeAsync(bound - 1);
    const settled = await Promise.race([outcome, Promise.resolve("pending")]);
    await vi.advanceTimersByTimeAsync(1);

    expect([settled, await outcome]).toEqual([
      "pending",
      "The fonts this document needs did not finish downloading. Check the connection, then open it again.",
    ]);
  } finally {
    vi.useRealTimers();
  }
});
