// SVG pictures, which only an image element decodes. Workers have none, so the window rasterizes them for the worker.

/** The longest side a decoded picture keeps: enough for a full-width page or slide on a high-density screen. */
export const maxImageSide = 2560;

/** The window decodes SVG on its main thread, so a picture above this many bytes keeps the engine's placeholder. */
const maxSvgBytes = 2 * 1024 * 1024;

/** How long the window waits for one picture's decode before it gives up on it. */
const decodeBudgetMs = 3_000;

/** An SVG picture the worker cannot decode, which the window rasterizes at `size`, or at its own size when absent. */
export type VectorRequest = {
  readonly asset: string;
  readonly blob: Blob;
  readonly size: { readonly width: number; readonly height: number } | undefined;
};

/** A rasterized SVG picture, or none when the window could not decode it either. */
export type VectorBitmap = { readonly asset: string; readonly bitmap: ImageBitmap | undefined };

/** Rasterizes a worker's SVG picture in the window. */
export async function rasterize(request: VectorRequest): Promise<VectorBitmap> {
  if (request.blob.size > maxSvgBytes) return { asset: request.asset, bitmap: undefined };
  const url = URL.createObjectURL(request.blob);
  const image = new Image();
  image.src = url;
  const budget = { timer: undefined as ReturnType<typeof setTimeout> | undefined };
  try {
    await Promise.race([
      image.decode(),
      new Promise((_, reject) => {
        budget.timer = setTimeout(() => reject(new Error("decode budget")), decodeBudgetMs);
      }),
    ]);
    const shrink = Math.min(1, maxImageSide / Math.max(image.naturalWidth, image.naturalHeight));
    const size = request.size ?? {
      width: Math.max(1, Math.round(image.naturalWidth * shrink)),
      height: Math.max(1, Math.round(image.naturalHeight * shrink)),
    };
    return {
      asset: request.asset,
      bitmap: await createImageBitmap(image, {
        resizeWidth: size.width,
        resizeHeight: size.height,
        resizeQuality: "high",
      }),
    };
  } catch {
    // An empty source stops a decode that is still running.
    image.src = "";
    return { asset: request.asset, bitmap: undefined };
  } finally {
    clearTimeout(budget.timer);
    URL.revokeObjectURL(url);
  }
}
