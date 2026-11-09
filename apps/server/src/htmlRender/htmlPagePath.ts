import { isNetworkPath, isWindowsAbsolutePath } from "@goat/shared/path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

const MAX_LINK_HOPS = 40;

interface PagePathServices {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

/** A link's target, or none when the path is not a link or does not exist. */
const linkTarget = (fs: FileSystem.FileSystem, target: string) =>
  fs.readLink(target).pipe(
    Effect.asSome,
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * The first link in an absolute path, as the absolute path it names with the rest appended.
 * `network` means a component or target names a share, which Windows would sign in to.
 */
const firstLink = Effect.fn("HtmlRender.firstLink")(function* (
  { fs, path }: PagePathServices,
  filePath: string,
) {
  const { root } = path.parse(filePath);
  const segments = filePath
    .slice(root.length)
    .split(/[\\/]+/)
    .filter((segment) => segment.length > 0);
  let prefix = root;
  for (const [index, segment] of segments.entries()) {
    prefix = path.join(prefix, segment);
    if (isNetworkPath(prefix)) return { network: true as const };
    const target = yield* linkTarget(fs, prefix);
    if (Option.isNone(target)) continue;
    const absolute =
      isWindowsAbsolutePath(target.value) || path.isAbsolute(target.value)
        ? target.value
        : path.resolve(path.dirname(prefix), target.value);
    const rest = segments.slice(index + 1);
    return {
      network: false as const,
      next: rest.length === 0 ? absolute : path.join(absolute, ...rest),
    };
  }
  return undefined;
});

/**
 * Resolves a page path without ever reaching a network share: a link's target is read, not
 * followed, so a share is refused before the filesystem opens it. Returns undefined when the
 * path names a share or links to one.
 */
export const resolveLocalPagePath = Effect.fn("HtmlRender.resolveLocalPagePath")(function* (
  services: PagePathServices,
  filePath: string,
) {
  let current = filePath;
  for (let hops = 0; hops <= MAX_LINK_HOPS; hops += 1) {
    if (isNetworkPath(current)) return undefined;
    const link = yield* firstLink(services, current);
    if (link === undefined) return current;
    if (link.network) return undefined;
    current = link.next;
  }
  return undefined;
});
