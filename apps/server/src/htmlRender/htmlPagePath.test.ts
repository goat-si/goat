import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { resolveLocalPagePath } from "./htmlPagePath.ts";

const notALink = (target: string) =>
  PlatformError.systemError({
    _tag: "InvalidData",
    module: "FileSystem",
    method: "readLink",
    pathOrDescriptor: target,
  });

/** A filesystem where only the named paths are links, and realPath never runs on a share. */
const layerWithLinks = (links: Readonly<Record<string, string>>) => {
  const realPaths: Array<string> = [];
  const layer = Layer.merge(
    FileSystem.layerNoop({
      readLink: (target) =>
        target in links ? Effect.succeed(links[target]!) : Effect.fail(notALink(target)),
      realPath: (target) => {
        realPaths.push(target);
        return Effect.succeed(target);
      },
    }),
    Path.layer,
  );
  return { layer, realPaths };
};

const resolveWith = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* resolveLocalPagePath({ fs, path }, filePath);
  });

const workDirectory = (path: Path.Path) => path.join(path.sep, "work");

it.effect("refuses a link whose target is a network share before resolving it", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const page = path.join(workDirectory(path), "page.html");
    const mock = layerWithLinks({ [page]: "\\\\server\\share\\page.html" });

    expect(yield* resolveWith(page).pipe(Effect.provide(mock.layer))).toBeUndefined();
    expect(mock.realPaths).toEqual([]);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("refuses a junction whose target is a network share", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const junction = path.join(workDirectory(path), "junction.html");
    const mock = layerWithLinks({ [junction]: "//server/share/page.html" });

    expect(yield* resolveWith(junction).pipe(Effect.provide(mock.layer))).toBeUndefined();
    expect(mock.realPaths).toEqual([]);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("refuses a local link that leads to a network share", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = workDirectory(path);
    const page = path.join(directory, "page.html");
    const mock = layerWithLinks({
      [page]: "local.html",
      [path.join(directory, "local.html")]: "\\\\server\\share\\page.html",
    });

    expect(yield* resolveWith(page).pipe(Effect.provide(mock.layer))).toBeUndefined();
    expect(mock.realPaths).toEqual([]);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("follows a local link and returns the path it names", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = workDirectory(path);
    const page = path.join(directory, "page.html");
    const mock = layerWithLinks({ [page]: "real.html" });

    expect(yield* resolveWith(page).pipe(Effect.provide(mock.layer))).toBe(
      path.join(directory, "real.html"),
    );
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("returns a path with no links unchanged", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const page = path.join(workDirectory(path), "page.html");
    const mock = layerWithLinks({});

    expect(yield* resolveWith(page).pipe(Effect.provide(mock.layer))).toBe(page);
  }).pipe(Effect.provide(Path.layer)),
);

it.effect("refuses a link loop instead of following it forever", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const directory = workDirectory(path);
    const first = path.join(directory, "first.html");
    const second = path.join(directory, "second.html");
    const mock = layerWithLinks({ [first]: "second.html", [second]: "first.html" });

    expect(yield* resolveWith(first).pipe(Effect.provide(mock.layer))).toBeUndefined();
  }).pipe(Effect.provide(Path.layer)),
);
