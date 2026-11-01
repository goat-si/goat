// @effect-diagnostics nodeBuiltinImport:off -- Release smoke compares deployed bytes with the build receipt.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

const ConnectArtifactManifest = Schema.Struct({
  sourceSha: Schema.String,
  artifactDigest: Schema.String,
  publicConfig: Schema.Struct({ hostedAppUrl: Schema.String }),
  files: Schema.Array(Schema.Struct({ name: Schema.String, sha256: Schema.String })),
});
const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(UnknownJson);
const manifestJson = Schema.decodeSync(UnknownJson)(
  await NodeFSP.readFile("apps/web/dist/connect-artifact.json", "utf8"),
);
const manifest = Schema.decodeUnknownSync(ConnectArtifactManifest)(manifestJson);
const origin = manifest.publicConfig.hostedAppUrl;
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const deployed = yield* client.get(`${origin}/connect-artifact.json`);
    if (deployed.status < 200 || deployed.status >= 300)
      throw new Error("Missing deployed build receipt");
    const receipt = yield* deployed.json;
    if (encodeJson(receipt) !== encodeJson(manifestJson))
      throw new Error("Deployed artifact/config differs from build");
    for (const path of ["/", "/connect", "/settings/connections"]) {
      const response = yield* client.get(`${origin}${path}`);
      const bytes = new Uint8Array(yield* response.arrayBuffer);
      const expected = manifest.files.find((entry) => entry.name === "index.html");
      if (
        response.status < 200 ||
        response.status >= 300 ||
        !expected ||
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== expected.sha256
      )
        throw new Error(`Hosted SPA entry failed: ${path}`);
      if (!response.headers["cache-control"]?.includes("no-store"))
        throw new Error("Hosted shell is cacheable");
    }
    yield* Console.log(
      encodeJson({
        sourceSha: manifest.sourceSha,
        artifactDigest: manifest.artifactDigest,
        origin,
        smoke: "root/deep-link/approval-entry",
      }),
    );
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { cache: "no-store" }),
  ),
);
