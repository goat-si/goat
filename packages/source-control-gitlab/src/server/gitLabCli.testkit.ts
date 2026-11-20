import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as GitLabCli from "./GitLabCli.ts";

const fileSystem = FileSystem.layerNoop({ stream: () => Stream.make(new Uint8Array()) });
export const layer = GitLabCli.layer.pipe(Layer.provide(fileSystem));
export const make = GitLabCli.make.pipe(Effect.provide(fileSystem));
