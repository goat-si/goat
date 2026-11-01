#!/usr/bin/env node

// All GOAT mark materializations are generated from the shared B2 geometry.
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import sharp from "sharp";

import { BRAND_CHANNEL_ICON_BACKGROUND } from "@goat/shared/brandChannels";
import {
  GOAT_MARK_GRID,
  GOAT_MARK_HORNS_PATH,
  GOAT_MARK_HORNS_SOFTEN_WIDTH,
  GOAT_MARK_INK_BOX,
  GOAT_MARK_PEAK_PATH,
  GOAT_MARK_PEAK_WIDTH,
  GOAT_MARK_VIEWBOX,
  goatMarkSvgElements,
} from "@goat/shared/goatMark";
import { BRAND_ASSET_PATHS, DEVELOPMENT_PUBLIC_ICON_OVERRIDES } from "./lib/brand-assets.ts";
import { encodePngIco, WINDOWS_ICON_SIZES } from "./lib/icon-export.ts";

const fs = Effect.runSync(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)));
const pathApi = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const REPOSITORY_ROOT = pathApi.resolve(import.meta.dirname, "..");
const CANVAS = 1024;
const MARK_FRACTION = 0.644;
export type IconOutputs = Map<string, Buffer>;

/** Center the visible ink on a square canvas, preserving the canonical path data. */
export function goatMarkCanvasSvg(size: number, fraction: number, background?: string) {
  const { x, y, width, height } = GOAT_MARK_INK_BOX;
  const scale = (size * fraction) / width;
  const tx = size / 2 - (x + width / 2) * scale;
  const ty = size / 2 - (y + height / 2) * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${background ? `<rect width="${size}" height="${size}" fill="${background}"/>` : ""}<g transform="translate(${tx} ${ty}) scale(${scale})">${goatMarkSvgElements("white")}</g></svg>`;
}

const png = (svg: string) => sharp(Buffer.from(svg)).png().toBuffer();
const resize = (source: Buffer, size: number) => sharp(source).resize(size, size).png().toBuffer();

/** Render in memory; the injectable root supplies only the surrounding DMG artwork. */
export async function renderGoatIconOutputs(
  repositoryRoot = REPOSITORY_ROOT,
): Promise<IconOutputs> {
  const outputs: IconOutputs = new Map();
  const text = (path: string, contents: string) => outputs.set(path, Buffer.from(`${contents}\n`));
  const layerMark = `<g transform="translate(17.24 17.31) scale(3.897)">${goatMarkSvgElements("white")}</g>`;
  const variants = [
    {
      channel: "stable",
      directory: "prod",
      prefix: "production",
      universal: BRAND_ASSET_PATHS.productionLinuxIconPng,
      mac: BRAND_ASSET_PATHS.productionMacIconPng,
    },
    {
      channel: "nightly",
      directory: "nightly",
      prefix: "nightly",
      universal: BRAND_ASSET_PATHS.nightlyLinuxIconPng,
      mac: BRAND_ASSET_PATHS.nightlyMacIconPng,
    },
    {
      channel: "dev",
      directory: "dev",
      prefix: "development",
      universal: BRAND_ASSET_PATHS.developmentUniversalIconPng,
      mac: BRAND_ASSET_PATHS.developmentDesktopIconPng,
    },
  ] as const;
  for (const variant of variants) {
    const color = BRAND_CHANNEL_ICON_BACKGROUND[variant.channel];
    const project = `assets/${variant.directory}/app-icon.icon`;
    text(
      `${project}/Assets/text.svg`,
      `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">${layerMark}</svg>`,
    );
    // Icon Composer accepts explicit sRGB components, avoiding a display-P3 color shift.
    const rgb = [1, 3, 5].map((offset) =>
      (Number.parseInt(color.slice(offset, offset + 2), 16) / 255).toFixed(5),
    );
    text(
      `${project}/icon.json`,
      JSON.stringify(
        {
          fill: { solid: `srgb:${rgb.join(",")},1.00000` },
          groups: [
            {
              layers: [
                {
                  glass: false,
                  "image-name": "text.svg",
                  name: "GOAT",
                  position: { scale: 8.5, "translation-in-points": [0, 0] },
                },
              ],
              shadow: { kind: "neutral", opacity: 0 },
              translucency: { enabled: false, value: 0 },
            },
          ],
          "supported-platforms": { circles: ["watchOS"], squares: "shared" },
        },
        null,
        2,
        // Keep short primitive arrays on one line, the way the repository formatter writes them.
      ).replace(
        /\[\s+([^[\]{}]*?)\s+\]/g,
        (_match, items: string) => `[${items.split(/,\s*/).join(", ")}]`,
      ),
    );
    const universal = await sharp(Buffer.from(goatMarkCanvasSvg(CANVAS, MARK_FRACTION, color)))
      .removeAlpha()
      .png()
      .toBuffer();
    outputs.set(variant.universal, universal);
    outputs.set(BRAND_ASSET_PATHS[`${variant.prefix}IosIconPng`], universal);
    const body = await resize(universal, 824);
    const mask = Buffer.from(
      '<svg width="824" height="824"><rect width="824" height="824" rx="185" fill="white"/></svg>',
    );
    const rounded = await sharp(body)
      .ensureAlpha()
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer();
    outputs.set(
      variant.mac,
      await sharp({
        create: { width: CANVAS, height: CANVAS, channels: 4, background: "#00000000" },
      })
        .composite([{ input: rounded, left: 100, top: 100 }])
        .png()
        .toBuffer(),
    );
    outputs.set(
      BRAND_ASSET_PATHS[`${variant.prefix}WebAppleTouchIconPng`],
      await resize(universal, 180),
    );
    outputs.set(BRAND_ASSET_PATHS[`${variant.prefix}WebFavicon16Png`], await resize(universal, 16));
    outputs.set(BRAND_ASSET_PATHS[`${variant.prefix}WebFavicon32Png`], await resize(universal, 32));
    const ico = encodePngIco(
      await Promise.all(
        WINDOWS_ICON_SIZES.map(async (size) => ({ size, contents: await resize(universal, size) })),
      ),
    );
    outputs.set(BRAND_ASSET_PATHS[`${variant.prefix}WindowsIconIco`], ico);
    outputs.set(BRAND_ASSET_PATHS[`${variant.prefix}WebFaviconIco`], ico);
  }
  for (const override of DEVELOPMENT_PUBLIC_ICON_OVERRIDES) {
    const contents = outputs.get(override.sourceRelativePath);
    if (!contents) throw new Error(`Missing generated source: ${override.sourceRelativePath}`);
    outputs.set(override.targetRelativePath, contents);
  }
  outputs.set(
    "apps/mobile/assets/android-notification-icon.png",
    await png(goatMarkCanvasSvg(96, 0.8)),
  );
  text(
    "assets/prod/logo.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><rect width="128" height="128" rx="10" fill="${BRAND_CHANNEL_ICON_BACKGROUND.stable}"/>${layerMark}</svg>`,
  );
  text(
    "apps/mobile/assets/widget/GoatMark.svg",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${GOAT_MARK_VIEWBOX}">${goatMarkSvgElements("black")}</svg>`,
  );
  text(
    "apps/mobile/modules/goat-agent-notifications/android/src/main/res/drawable/agent_activity_mark.xml",
    `<!-- Generated from packages/shared/src/goatMark.ts. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="${GOAT_MARK_GRID}" android:viewportHeight="${GOAT_MARK_GRID}">
    <path android:pathData="${GOAT_MARK_HORNS_PATH}" android:fillColor="#FFFFFFFF"
        android:strokeColor="#FFFFFFFF" android:strokeWidth="${GOAT_MARK_HORNS_SOFTEN_WIDTH}" android:strokeLineJoin="round" />
    <path android:pathData="${GOAT_MARK_PEAK_PATH}" android:fillColor="#00000000"
        android:strokeColor="#FFFFFFFF" android:strokeWidth="${GOAT_MARK_PEAK_WIDTH}"
        android:strokeLineCap="round" android:strokeLineJoin="round" />
</vector>`,
  );
  for (const [channel, color] of [
    ["latest", "#303034"],
    ["nightly", "#edf0ff"],
  ] as const) {
    const path = `apps/desktop/resources/dmg/dmg-background-${channel}.svg`;
    const source = await Effect.runPromise(fs.readFileString(pathApi.join(repositoryRoot, path)));
    const block = `<!-- goat-mark:start -->\n  <svg x="32" y="22" width="21" height="20" viewBox="${GOAT_MARK_VIEWBOX}" fill="${color}">${goatMarkSvgElements(color)}</svg>\n  <!-- goat-mark:end -->`;
    const match =
      /<!-- goat-mark:start -->[\s\S]*?<!-- goat-mark:end -->|<svg\b[^>]*viewBox="25\.25 27\.63 77\.5 72\.74"[^>]*>[\s\S]*?<\/svg>/;
    if (!match.test(source)) throw new Error(`Missing GOAT mark block: ${path}`);
    outputs.set(path, Buffer.from(source.replace(match, block)));
  }
  return outputs;
}

/** Check mode never creates directories or writes files, and reports every stale output. */
export async function applyIconOutputs(
  outputs: IconOutputs,
  repositoryRoot: string,
  check: boolean,
  report: (message: string) => void = console.log,
) {
  let stale = 0;
  for (const [path, contents] of outputs) {
    const target = pathApi.join(repositoryRoot, path);
    if (check) {
      const actual = (await Effect.runPromise(fs.exists(target)))
        ? Buffer.from(await Effect.runPromise(fs.readFile(target)))
        : undefined;
      if (!actual?.equals(contents)) {
        report(`stale ${path}`);
        stale++;
      }
    } else {
      await Effect.runPromise(fs.makeDirectory(pathApi.dirname(target), { recursive: true }));
      await Effect.runPromise(fs.writeFile(target, contents));
      report(`wrote ${path}`);
    }
  }
  report(
    check
      ? `Checked ${outputs.size} outputs; ${stale} stale.`
      : `Generated ${outputs.size} outputs.`,
  );
  return stale === 0 ? 0 : 1;
}

export async function exportGoatIcons(
  repositoryRoot = REPOSITORY_ROOT,
  check = false,
  report?: (message: string) => void,
) {
  return applyIconOutputs(
    await renderGoatIconOutputs(repositoryRoot),
    repositoryRoot,
    check,
    report,
  );
}

if (import.meta.main) {
  process.exitCode = await exportGoatIcons(REPOSITORY_ROOT, process.argv.includes("--check"));
}
