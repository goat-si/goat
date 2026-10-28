import { describe, expect, it, vi } from "vite-plus/test";

// Electron 44's NativeImage, as probed on macOS: getSize(scaleFactor) reports points, toBitmap
// returns pixels at that scale, and createFromBitmap rejects a buffer that does not match.
const electron = vi.hoisted(() => {
  interface Rep {
    readonly scaleFactor: number;
    readonly width: number;
    readonly height: number;
    readonly pixels: Uint8Array;
  }
  const image = (points: { width: number; height: number }, reps: Rep[]) => {
    let template = false;
    const self = {
      reps,
      isTemplate: () => template,
      setTemplateImage: (value: boolean) => {
        template = value;
      },
      getScaleFactors: () => reps.map((rep) => rep.scaleFactor),
      getSize: () => points,
      toBitmap: ({ scaleFactor }: { scaleFactor: number }) =>
        Buffer.from(reps.find((rep) => rep.scaleFactor === scaleFactor)?.pixels ?? []),
      toDataURL: ({ scaleFactor }: { scaleFactor: number }) => `rep:${scaleFactor}`,
      addRepresentation: (rep: { scaleFactor: number; width: number; height: number }) => {
        reps.push({ ...rep, pixels: new Uint8Array(rep.width * rep.height * 4) });
        if (points.width === 0) {
          points.width = rep.width / rep.scaleFactor;
          points.height = rep.height / rep.scaleFactor;
        }
      },
    };
    return self;
  };
  return {
    image,
    nativeImage: {
      createEmpty: () => image({ width: 0, height: 0 }, []),
      createFromBitmap: (
        buffer: Buffer,
        options: { width: number; height: number; scaleFactor: number },
      ) => {
        if (buffer.length !== options.width * options.height * 4) {
          throw new Error("invalid buffer size");
        }
        return image(
          {
            width: options.width / options.scaleFactor,
            height: options.height / options.scaleFactor,
          },
          [{ ...options, pixels: new Uint8Array(buffer) }],
        );
      },
    },
  };
});
vi.mock("electron", () => ({ nativeImage: electron.nativeImage }));

const { withActivityDot } = await import("./trayIcons.ts");

describe("withActivityDot", () => {
  it("dots every representation of an 18 pt template icon with a 2x version and keeps it a template", () => {
    const base = electron.image({ width: 18, height: 18 }, [
      { scaleFactor: 1, width: 18, height: 18, pixels: new Uint8Array(18 * 18 * 4) },
      { scaleFactor: 2, width: 36, height: 36, pixels: new Uint8Array(36 * 36 * 4) },
    ]);
    const dotted = withActivityDot(base as unknown as Electron.NativeImage, [0, 0, 0], true);
    const result = dotted as unknown as ReturnType<typeof electron.image>;
    expect(result.reps.map((rep) => [rep.scaleFactor, rep.width, rep.height])).toEqual([
      [1, 18, 18],
      [2, 36, 36],
    ]);
    expect(result.isTemplate()).toBe(true);
  });
});
