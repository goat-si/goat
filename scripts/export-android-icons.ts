#!/usr/bin/env node

// Adaptive layers keep the mark inside Android's guaranteed 66dp safe circle.
// Splash composition preserves the same foreground fraction on the 288dp canvas.
import * as NodePath from "@effect/platform-node/NodePath";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import sharp from "sharp";

import { BRAND_CHANNEL_ICON_BACKGROUND } from "@goat/shared/brandChannels";
import {
  applyIconOutputs,
  goatMarkCanvasSvg,
  type IconOutputs,
} from "./export-goat-brand-icons.ts";

const ADAPTIVE_CANVAS = 432;
const SPLASH_CANVAS = 1152;
const WORDMARK_FRACTION = 0.43;
const pathApi = Effect.runSync(Path.Path.pipe(Effect.provide(NodePath.layer)));
const REPOSITORY_ROOT = pathApi.resolve(import.meta.dirname, "..");

async function renderAndroidIconOutputs(): Promise<IconOutputs> {
  const outputs: IconOutputs = new Map();
  const foreground = await sharp(Buffer.from(goatMarkCanvasSvg(ADAPTIVE_CANVAS, WORDMARK_FRACTION)))
    .png()
    .toBuffer();
  outputs.set("apps/mobile/assets/android-icon-foreground.png", foreground);
  outputs.set("apps/mobile/assets/android-icon-mark.png", foreground);
  for (const [variant, channel] of [
    ["prod", "stable"],
    ["dev", "dev"],
    ["nightly", "nightly"],
  ] as const) {
    const color = BRAND_CHANNEL_ICON_BACKGROUND[channel];
    if (variant !== "prod") {
      outputs.set(
        `apps/mobile/assets/android-icon-background-${variant}.png`,
        await sharp({
          create: {
            width: ADAPTIVE_CANVAS,
            height: ADAPTIVE_CANVAS,
            channels: 4,
            background: color,
          },
        })
          .png()
          .toBuffer(),
      );
    }
    outputs.set(
      `apps/mobile/assets/android-splash-icon-${variant}.png`,
      await sharp(Buffer.from(goatMarkCanvasSvg(SPLASH_CANVAS, WORDMARK_FRACTION, color)))
        .png()
        .toBuffer(),
    );
  }
  return outputs;
}

if (import.meta.main) {
  process.exitCode = await applyIconOutputs(
    await renderAndroidIconOutputs(),
    REPOSITORY_ROOT,
    process.argv.includes("--check"),
  );
}
