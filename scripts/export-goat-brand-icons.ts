#!/usr/bin/env node

// Renders the GOAT raster icons that Icon Composer would otherwise export.
//
// The production and nightly `*-universal-1024.png`, `*-macos-1024.png` and web PNGs are
// the GOAT originals and are read, never written. Everything else is derived from them or
// from the GOAT mark in `assets/prod/app-icon.icon/Assets/text.svg`:
//
// - production and nightly: the iOS PNG and both ICO files, from the universal PNG
// - development: the universal PNG (blueprint background plus the mark, sized like the
//   originals), then its macOS, iOS, web and ICO renditions and the apps/web/public copies
// - Android: the status-bar notification icon
//
// Run `node scripts/export-android-icons.ts` for the Android launcher and splash artwork.

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import sharp from "sharp";

import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const CANVAS = 1024;
// The originals draw the mark at this fraction of the canvas width, centered.
const MARK_FRACTION = 0.644;
// Android status-bar icons are near full bleed, like the agent activity vector drawable.
const NOTIFICATION_ICON_SIZE = 96;
const NOTIFICATION_MARK_FRACTION = 0.8;
// Bounds of the mark path inside the 128pt Icon Composer layer.
const MARK = { x: 25.25, y: 27.63, width: 77.5, height: 72.74 };
const SVG_DENSITY = 300;

export class GoatIconRenderError extends Schema.TaggedError<GoatIconRenderError>()(
  "GoatIconRenderError",
  { output: Schema.String, cause: Schema.Defect() },
) {}

const render = (output: string, run: () => Promise<Buffer>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new GoatIconRenderError({ output, cause }) });

const markSvg = (path: string, size: number, fraction: number) => {
  const scale = (size * fraction) / MARK.width;
  const tx = (size - MARK.width * scale) / 2 - MARK.x * scale;
  const ty = (size - MARK.height * scale) / 2 - MARK.y * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><path transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${scale.toFixed(4)})" d="${path}" fill="white"/></svg>`;
};

const resizePng = (output: string, source: Buffer, size: number) =>
  render(output, () => sharp(source).resize(size, size).png().toBuffer());

const icoFrom = Effect.fn("goatIcons.icoFrom")(function* (output: string, source: Buffer) {
  const images = yield* Effect.forEach(WINDOWS_ICON_SIZES, (size) =>
    Effect.map(resizePng(output, source, size), (contents) => ({ size, contents })),
  );
  return encodePngIco(images);
});

const exportGoatIcons = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const read = (relativePath: string) => fs.readFile(path.join(repositoryRoot, relativePath));
  const write = Effect.fn("goatIcons.write")(function* (
    relativePath: string,
    contents: Uint8Array,
  ) {
    yield* fs.writeFile(path.join(repositoryRoot, relativePath), contents);
    yield* Console.log(`wrote ${relativePath}`);
  });

  const textSvg = yield* fs.readFileString(
    path.join(repositoryRoot, BRAND_ASSET_PATHS.productionIconComposerProject, "Assets/text.svg"),
  );
  const markPath = textSvg.match(/<path d="([^"]+)"/)?.[1];
  if (markPath === undefined) {
    return yield* new GoatIconRenderError({ output: "mark", cause: "text.svg has no path" });
  }

  // Development has no GOAT original, so compose one from the blueprint layer and the mark.
  const blueprint = yield* fs.readFileString(
    path.join(
      repositoryRoot,
      BRAND_ASSET_PATHS.developmentIconComposerProject,
      "Assets/background.svg",
    ),
  );
  const fullBleedBlueprint = blueprint.replace(
    /<rect width="128" height="128" rx="10"\/>/,
    '<rect width="128" height="128"/>',
  );
  const developmentUniversal = yield* render(BRAND_ASSET_PATHS.developmentUniversalIconPng, () =>
    sharp(Buffer.from(fullBleedBlueprint), { density: SVG_DENSITY })
      .resize(CANVAS, CANVAS)
      .composite([{ input: Buffer.from(markSvg(markPath, CANVAS, MARK_FRACTION)) }])
      .removeAlpha()
      .png()
      .toBuffer(),
  );
  yield* write(BRAND_ASSET_PATHS.developmentUniversalIconPng, developmentUniversal);

  // The production macOS original carries the classic 824px rounded body inset 100px.
  const macBodyMask = yield* read(BRAND_ASSET_PATHS.productionMacIconPng);
  const developmentBody = yield* resizePng(
    BRAND_ASSET_PATHS.developmentDesktopIconPng,
    developmentUniversal,
    824,
  );
  yield* write(
    BRAND_ASSET_PATHS.developmentDesktopIconPng,
    yield* render(BRAND_ASSET_PATHS.developmentDesktopIconPng, () =>
      sharp({
        create: { width: CANVAS, height: CANVAS, channels: 4, background: "#00000000" },
      })
        .composite([
          { input: developmentBody, left: 100, top: 100 },
          { input: Buffer.from(macBodyMask), blend: "dest-in" },
        ])
        .png()
        .toBuffer(),
    ),
  );
  yield* write(
    BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    yield* resizePng(BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng, developmentUniversal, 180),
  );
  yield* write(
    BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    yield* resizePng(BRAND_ASSET_PATHS.developmentWebFavicon32Png, developmentUniversal, 32),
  );
  yield* write(
    BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    yield* resizePng(BRAND_ASSET_PATHS.developmentWebFavicon16Png, developmentUniversal, 16),
  );

  const variants = [
    {
      universal: developmentUniversal,
      ios: BRAND_ASSET_PATHS.developmentIosIconPng,
      windowsIco: BRAND_ASSET_PATHS.developmentWindowsIconIco,
      faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    },
    {
      universal: Buffer.from(yield* read(BRAND_ASSET_PATHS.productionLinuxIconPng)),
      ios: BRAND_ASSET_PATHS.productionIosIconPng,
      windowsIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
      faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    },
    {
      universal: Buffer.from(yield* read(BRAND_ASSET_PATHS.nightlyLinuxIconPng)),
      ios: BRAND_ASSET_PATHS.nightlyIosIconPng,
      windowsIco: BRAND_ASSET_PATHS.nightlyWindowsIconIco,
      faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    },
  ];
  for (const variant of variants) {
    // iOS app icons must be opaque; the universal originals are full-bleed squares.
    yield* write(
      variant.ios,
      yield* render(variant.ios, () =>
        sharp(variant.universal).resize(CANVAS, CANVAS).removeAlpha().png().toBuffer(),
      ),
    );
    // Windows and the browser share the same multi-resolution ICO.
    const ico = yield* icoFrom(variant.windowsIco, variant.universal);
    yield* write(variant.windowsIco, ico);
    yield* write(variant.faviconIco, ico);
  }

  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    yield* write(override.targetRelativePath, yield* read(override.sourceRelativePath));
  }

  yield* write(
    "apps/mobile/assets/android-notification-icon.png",
    yield* render("android-notification-icon.png", () =>
      sharp(Buffer.from(markSvg(markPath, NOTIFICATION_ICON_SIZE, NOTIFICATION_MARK_FRACTION)), {
        density: SVG_DENSITY,
      })
        .resize(NOTIFICATION_ICON_SIZE, NOTIFICATION_ICON_SIZE)
        .png()
        .toBuffer(),
    ),
  );
});

if (import.meta.main) {
  exportGoatIcons.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
