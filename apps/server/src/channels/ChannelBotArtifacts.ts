/**
 * GOAT Bot's Library. A client path never leaves the artifacts folder through links; a process
 * running as the server's own user racing the walk is out of scope (it can read anything anyway).
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's FileSystem has no O_NOFOLLOW/O_NONBLOCK open or opendir.
import * as NodeFS from "node:fs";
import * as NodeBuffer from "node:buffer";

import {
  CHANNEL_BOT_ARTIFACT_CHUNK_BYTES,
  CHANNEL_BOT_ARTIFACT_MAX_BYTES,
  CHANNEL_GATEWAY_WS_METHODS,
  ChannelGatewayError,
  type ChannelBotArtifact,
  type ChannelListBotArtifactsInput,
  type ChannelListBotArtifactsResult,
  type ChannelReadBotArtifactInput,
  type ChannelReadBotArtifactResult,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ChannelBotHome from "./ChannelBotHome.ts";
import { channelBotFilesFor } from "./channelBotNotes.ts";

const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = NodeFS.constants;
// Windows has neither flag; the walk, the handle's dev/ino check and the second walk still run.
const READ_FLAGS = O_RDONLY | (O_NOFOLLOW ?? 0) | (O_NONBLOCK ?? 0);

const MIME_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  html: "text/html",
};

export interface ArtifactsOptions {
  readonly bounds?: { readonly files?: number; readonly visits?: number; readonly depth?: number };
  readonly limits?: { readonly chunkBytes?: number; readonly maxBytes?: number };
  /** Runs between the first walk and the open, so a test can swap a path there. */
  readonly beforeOpen?: Effect.Effect<void>;
  /** Runs after a chunk was read, before the handle is checked again. */
  readonly afterRead?: Effect.Effect<void>;
}

const notFound = () => new ChannelGatewayError({ reason: "not_found" });
const failed = () => new ChannelGatewayError({ reason: "persistence_failed" });
const code = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
const missingOrFailed = (cause: unknown) =>
  code(cause) === "ENOENT" || code(cause) === "ENOTDIR" || code(cause) === "ELOOP"
    ? notFound()
    : failed();

const idOf = (stat: NodeFS.BigIntStats) => stat.dev + ":" + stat.ino;
const versionOf = (stat: NodeFS.BigIntStats) => idOf(stat) + ":" + stat.size + ":" + stat.mtimeNs;
// Only names read() accepts unchanged are listed: no leading dot, colon, backslash or edge spaces.
const plainName = (name: string) =>
  !name.startsWith(".") && !/[:\\]/u.test(name) && name === name.trim();
const PATH_MAX = 512;

/** The path's components, or undefined when it is not plainly inside the folder. */
const segmentsOf = (relativePath: string) => {
  if (/[\\:\u0000]/u.test(relativePath) || relativePath.startsWith("/")) return undefined;
  const parts = relativePath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..") ? parts : undefined;
};

const lstat = (path: string) =>
  Effect.tryPromise({
    try: () => NodeFS.promises.lstat(path, { bigint: true }),
    catch: missingOrFailed,
  });

export class ChannelBotArtifacts extends Context.Service<
  ChannelBotArtifacts,
  {
    readonly list: Effect.Effect<ChannelListBotArtifactsResult, ChannelGatewayError>;
    readonly read: (
      input: ChannelReadBotArtifactInput,
    ) => Effect.Effect<ChannelReadBotArtifactResult, ChannelGatewayError>;
  }
>()("goat/channels/ChannelBotArtifacts") {}

export const make = Effect.fn("ChannelBotArtifacts.make")(function* (
  options: ArtifactsOptions = {},
) {
  const path = yield* Path.Path;
  const home = yield* ChannelBotHome.ChannelBotHome;
  const root = channelBotFilesFor(path, (yield* ServerConfig.ServerConfig).stateDir).artifacts;
  const maxFiles = options.bounds?.files ?? 500;
  const maxVisits = options.bounds?.visits ?? 5_000;
  const maxDepth = options.bounds?.depth ?? 16;
  const chunkBytes = options.limits?.chunkBytes ?? CHANNEL_BOT_ARTIFACT_CHUNK_BYTES;
  const maxBytes = options.limits?.maxBytes ?? CHANNEL_BOT_ARTIFACT_MAX_BYTES;
  const beforeOpen = options.beforeOpen ?? Effect.void;
  const afterRead = options.afterRead ?? Effect.void;
  // At most two chunks are being read at once on this server.
  const reads = yield* Semaphore.make(2);

  /** The root, each folder and the file, checked without following links. */
  const walk = Effect.fn("ChannelBotArtifacts.walk")(function* (segments: ReadonlyArray<string>) {
    const rootStat = yield* lstat(root);
    if (!rootStat.isDirectory()) return yield* notFound();
    const ids = [idOf(rootStat)];
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = yield* lstat(current);
      const last = index === segments.length - 1;
      if (last ? !stat.isFile() : !stat.isDirectory()) return yield* notFound();
      ids.push(idOf(stat));
    }
    return { file: current, ids: ids.join("/") };
  });

  const readRange = Effect.fn("ChannelBotArtifacts.readRange")(function* (
    handle: NodeFS.promises.FileHandle,
    offset: number,
    length: number,
  ) {
    const buffer = new Uint8Array(length);
    let filled = 0;
    while (filled < length) {
      const { bytesRead } = yield* Effect.tryPromise({
        try: () => handle.read(buffer, filled, length - filled, offset + filled),
        catch: failed,
      });
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buffer.subarray(0, filled);
  });

  const readChunk = Effect.fn("ChannelBotArtifacts.readChunk")(function* (
    input: ChannelReadBotArtifactInput,
    segments: ReadonlyArray<string>,
  ) {
    const relativePath = input.relativePath;
    const first = yield* walk(segments);
    yield* beforeOpen;
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFS.promises.open(first.file, READ_FLAGS),
        catch: missingOrFailed,
      }),
      (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore),
    );
    const stat = (): Effect.Effect<NodeFS.BigIntStats, ChannelGatewayError> =>
      Effect.tryPromise({ try: () => handle.stat({ bigint: true }), catch: failed });
    const opened = yield* stat();
    if (!opened.isFile() || first.ids.split("/").at(-1) !== idOf(opened)) {
      return yield* notFound();
    }
    // A folder swapped for a link between the walk and the open shows up on a second walk.
    if ((yield* walk(segments)).ids !== first.ids) return yield* notFound();
    const size = Number(opened.size);
    const version = versionOf(opened);
    if (size > maxBytes) {
      return { status: "too_large", relativePath, size, maxBytes } as const;
    }
    const offset = input.offset ?? 0;
    if (offset > 0 && input.version !== version) {
      return { status: "changed", relativePath } as const;
    }
    if (offset > size) return yield* notFound();
    const length = Math.min(chunkBytes, size - offset);
    const bytes = yield* readRange(handle, offset, length);
    yield* afterRead;
    if (bytes.length !== length || versionOf(yield* stat()) !== version) {
      return { status: "changed", relativePath } as const;
    }
    const extension = relativePath.slice(relativePath.lastIndexOf(".") + 1).toLowerCase();
    return {
      status: "chunk",
      relativePath,
      mimeType: MIME_TYPES[extension] ?? "application/octet-stream",
      size,
      offset,
      bytesBase64: NodeBuffer.Buffer.from(bytes).toString("base64"),
      version,
      done: offset + length === size,
    } as const;
  });

  const read = Effect.fn("ChannelBotArtifacts.read")(function* (
    input: ChannelReadBotArtifactInput,
  ) {
    yield* home.requireHome;
    const segments = segmentsOf(input.relativePath);
    if (segments === undefined) return yield* notFound();
    return yield* reads.withPermits(1)(Effect.scoped(readChunk(input, segments)));
  });

  const list = Effect.fn("ChannelBotArtifacts.list")(function* () {
    yield* home.requireHome;
    const rootStat = yield* lstat(root).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeedNone,
      ),
    );
    if (Option.isNone(rootStat) || !rootStat.value.isDirectory()) {
      if (Option.isSome(rootStat)) yield* Effect.logWarning("GOAT Bot artifacts folder is a link");
      return { artifacts: [], truncated: false };
    }
    const found: Array<{ readonly artifact: ChannelBotArtifact; readonly mtime: bigint }> = [];
    const queue: Array<{ readonly dir: string; readonly prefix: string; readonly depth: number }> =
      [{ dir: root, prefix: "", depth: 0 }];
    let visits = 0;
    let truncated = false;
    // Reads one folder entry by entry; false once the visit bound stops the whole walk.
    const readFolder = (dir: string, prefix: string, depth: number) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* Effect.acquireRelease(
            Effect.tryPromise({ try: () => NodeFS.promises.opendir(dir), catch: missingOrFailed }),
            (opened) => Effect.tryPromise(() => opened.close()).pipe(Effect.ignore),
          );
          for (;;) {
            const entry = yield* Effect.tryPromise({ try: () => handle.read(), catch: failed });
            if (entry === null) return true;
            if (++visits > maxVisits) return false;
            if (!plainName(entry.name)) continue;
            const relativePath = prefix + entry.name;
            if (relativePath.length > PATH_MAX) continue;
            if (entry.isDirectory()) {
              if (depth + 1 > maxDepth) truncated = true;
              else
                queue.push({
                  dir: path.join(dir, entry.name),
                  prefix: relativePath + "/",
                  depth: depth + 1,
                });
            } else if (entry.isFile()) {
              const stat = yield* lstat(path.join(dir, entry.name)).pipe(Effect.option);
              if (Option.isNone(stat) || !stat.value.isFile()) continue;
              const millis = Number(stat.value.mtimeNs / 1_000_000n);
              found.push({
                artifact: {
                  relativePath,
                  size: Number(stat.value.size),
                  modifiedAt: DateTime.formatIso(DateTime.makeUnsafe(millis)),
                },
                mtime: stat.value.mtimeNs,
              });
            }
          }
        }),
      ).pipe(
        // A folder removed while the walk runs is skipped; any other failure fails the list.
        Effect.catchIf(
          (error) => error.reason === "not_found",
          () => Effect.succeed(true),
        ),
      );
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (!(yield* readFolder(next.dir, next.prefix, next.depth))) {
        truncated = true;
        break;
      }
    }
    found.sort((a, b) =>
      a.mtime === b.mtime
        ? a.artifact.relativePath.localeCompare(b.artifact.relativePath)
        : a.mtime > b.mtime
          ? -1
          : 1,
    );
    return {
      artifacts: found.slice(0, maxFiles).map((entry) => entry.artifact),
      truncated: truncated || found.length > maxFiles,
    };
  });

  return ChannelBotArtifacts.of({ list: list(), read });
});

export const layer = Layer.effect(ChannelBotArtifacts, make());

/** `reads` belongs to one connection: a second read there while one runs answers busy. */
export const rpcHandlers = (
  service: ChannelBotArtifacts["Service"],
  connectionReads: Semaphore.Semaphore,
) => ({
  [CHANNEL_GATEWAY_WS_METHODS.listBotArtifacts]: (_input: ChannelListBotArtifactsInput) =>
    service.list,
  [CHANNEL_GATEWAY_WS_METHODS.readBotArtifact]: (input: ChannelReadBotArtifactInput) =>
    connectionReads
      .withPermitsIfAvailable(1)(service.read(input))
      .pipe(
        Effect.map(
          Option.getOrElse((): ChannelReadBotArtifactResult => ({
            status: "busy",
            relativePath: input.relativePath,
          })),
        ),
      ),
});
