import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { refreshDesktopManifest } from "./DesktopCuaManifest.ts";

const PATH = "/desktop/capability-manifest.yaml";
const calculator = '    - bundle_id: "com.apple.calculator"';
const terminate = '      terminate: "driver_launched"';
const manifest = (
  entries: ReadonlyArray<string>,
  tools: ReadonlyArray<string> = ["launch_app", "kill_app"],
) =>
  [
    "# Written by GOAT at each driver start. See ADR-0022.",
    "version: 3",
    "resources:",
    "  desktop:",
    "    display: true",
    "  apps:",
    ...entries,
    "allow:",
    "  tools:",
    ...tools.map((tool) => "    - " + JSON.stringify(tool)),
    "",
  ].join("\n");
const legacy = manifest([calculator, terminate]);
const granted = manifest([calculator, "      launch: true", terminate]);

/** Refreshes Calculator's approval against `before`; prepare writes `regenerated` and is counted. */
const refresh = (before: string, regenerated: string) => {
  const files = new Map([[PATH, before]]);
  let prepares = 0;
  return refreshDesktopManifest({
    apps: ["com.apple.calculator"],
    path: PATH,
    read: async (path) => {
      const text = files.get(path);
      if (text === undefined) throw new Error("No manifest at " + path);
      return text;
    },
    prepare: async () => {
      prepares += 1;
      files.set(PATH, regenerated);
      return PATH;
    },
  }).pipe(
    Effect.exit,
    Effect.map((exit) => ({
      repaired: Exit.isSuccess(exit) ? exit.value : ("failed" as const),
      prepares,
      written: files.get(PATH),
    })),
  );
};

it.effect(
  "rewrites a manifest that lists an approved app without a launch grant, and reports it repaired",
  () =>
    Effect.gen(function* () {
      expect(yield* refresh(legacy, granted)).toEqual({
        repaired: true,
        prepares: 1,
        written: granted,
      });
    }),
);

it.effect("repairs an entry whose launch grant is false", () =>
  Effect.gen(function* () {
    const denied = manifest([calculator, "      launch: false", terminate]);
    expect(yield* refresh(denied, granted)).toMatchObject({ repaired: true, prepares: 1 });
  }),
);

it.effect("leaves a launch-granted manifest alone", () =>
  Effect.gen(function* () {
    expect(yield* refresh(granted, legacy)).toEqual({
      repaired: false,
      prepares: 0,
      written: granted,
    });
  }),
);

it.effect("does not report an app still ungranted after regeneration as repaired", () =>
  Effect.gen(function* () {
    expect(yield* refresh(legacy, legacy)).toMatchObject({ repaired: false, prepares: 1 });
  }),
);

it.effect.each([
  {
    name: "a launch value other than true or false",
    before: manifest([calculator, "      launch: yes", terminate]),
  },
  {
    name: "a repeated launch grant",
    before: manifest([calculator, "      launch: true", "      launch: true", terminate]),
  },
  {
    name: "one app in two entries that disagree",
    before: manifest([calculator, "      launch: true", calculator]),
  },
])("refuses $name without rewriting", ({ before }) =>
  Effect.gen(function* () {
    expect(yield* refresh(before, granted)).toMatchObject({ repaired: "failed", prepares: 0 });
  }),
);

it.effect("needs no launch grant when the manifest does not allow launch_app", () =>
  Effect.gen(function* () {
    const clickOnly = manifest([calculator, terminate], ["click"]);
    expect(yield* refresh(clickOnly, granted)).toMatchObject({ repaired: false, prepares: 0 });
  }),
);
