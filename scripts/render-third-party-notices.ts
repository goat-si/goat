#!/usr/bin/env node
// Renders the web build's third-party-licenses.json as THIRD_PARTY_NOTICES.md for
// goat-releases (see scripts/lib/release-notices.ts).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";

import { renderThirdPartyNotices } from "./lib/release-notices.ts";

const ManifestJson = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    entries: Schema.Array(
      Schema.Struct({
        bundles: Schema.Array(Schema.String),
        kind: Schema.Literals(["custom", "package"]),
        license: Schema.String,
        name: Schema.String,
        noticeText: Schema.String,
        sourceUrl: Schema.NullOr(Schema.String),
        version: Schema.NullOr(Schema.String),
      }),
    ),
  }),
);
const decodeManifest = Schema.decodeUnknownEffect(ManifestJson);

const command = Command.make(
  "render-third-party-notices",
  {
    input: Flag.String("input").pipe(Flag.withDescription("third-party-licenses.json path.")),
    output: Flag.String("output").pipe(Flag.withDescription("THIRD_PARTY_NOTICES.md path.")),
  },
  ({ input, output }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* decodeManifest(yield* fs.readFileString(input));
      yield* fs.writeFileString(output, renderThirdPartyNotices(manifest));
    }),
).pipe(Command.withDescription("Render THIRD_PARTY_NOTICES.md from the web license manifest."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
