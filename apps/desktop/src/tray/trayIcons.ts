import * as Electron from "electron";

export interface Bitmap {
  readonly width: number;
  readonly height: number;
  /** 4 bytes per pixel, Electron toBitmap order: B, G, R, A. Premultiplied. */
  readonly pixels: Uint8Array;
}

/** [b, g, r]. */
export type DotColor = readonly [number, number, number];

export function drawActivityDot(base: Bitmap, color: DotColor): Bitmap {
  const { width, height } = base;
  const pixels = new Uint8Array(base.pixels);
  const radius = Math.round(Math.min(width, height) * 0.2);
  const ring = Math.max(1, Math.round(radius / 3));
  // Pixel-center distance from (width - radius - 0.5, height - radius - 0.5) is an integer.
  const centerX = width - radius - 1;
  const centerY = height - radius - 1;
  const radius2 = radius * radius;
  const outer2 = (radius + ring) * (radius + ring);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - centerX;
      const dy = y - centerY;
      const distance2 = dx * dx + dy * dy;
      if (distance2 > outer2) continue;
      const offset = (y * width + x) * 4;
      if (distance2 <= radius2) {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      } else {
        // Cleared, not transparent-black: a premultiplied bitmap would show leftover color.
        pixels[offset] = 0;
        pixels[offset + 1] = 0;
        pixels[offset + 2] = 0;
        pixels[offset + 3] = 0;
      }
    }
  }
  return { width, height, pixels };
}

export function menuIcon(dataUrl: string): Electron.NativeImage | undefined {
  if (dataUrl.length === 0) return undefined;
  try {
    const source = Electron.nativeImage.createFromDataURL(dataUrl);
    if (source.isEmpty()) return undefined;
    const image = Electron.nativeImage.createEmpty();
    const at = (pixels: number, scaleFactor: number) => {
      image.addRepresentation({
        scaleFactor,
        width: pixels,
        height: pixels,
        dataURL: source.resize({ width: pixels, height: pixels }).toDataURL(),
      });
    };
    at(16, 1);
    at(32, 2);
    return image;
  } catch {
    // An unreadable payload has no menu icon; it must not take down the rest of the menu.
    return undefined;
  }
}
export function withActivityDot(
  image: Electron.NativeImage,
  color: DotColor,
  template: boolean,
): Electron.NativeImage {
  const result = Electron.nativeImage.createEmpty();
  for (const scaleFactor of image.getScaleFactors()) {
    // getSize reports points; the bitmap of a 2x representation holds twice as many pixels a side.
    const points = image.getSize(scaleFactor);
    const width = Math.round(points.width * scaleFactor);
    const height = Math.round(points.height * scaleFactor);
    const pixels = image.toBitmap({ scaleFactor });
    if (pixels.length !== width * height * 4) {
      throw new Error(`tray icon bitmap at ${scaleFactor}x is not ${width}x${height}`);
    }
    const drawn = drawActivityDot({ width, height, pixels }, color);
    result.addRepresentation({
      scaleFactor,
      width,
      height,
      dataURL: Electron.nativeImage
        .createFromBitmap(Buffer.from(drawn.pixels), {
          width: drawn.width,
          height: drawn.height,
          scaleFactor,
        })
        .toDataURL({ scaleFactor }),
    });
  }
  // A rebuilt NativeImage loses the macOS template flag.
  if (template) result.setTemplateImage(true);
  return result;
}
