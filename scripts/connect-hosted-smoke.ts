// @effect-diagnostics nodeBuiltinImport:off -- Release smoke compares deployed bytes with the build receipt.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";

const manifest = JSON.parse(
  await NodeFSP.readFile("apps/web/dist/connect-artifact.json", "utf8"),
) as {
  sourceSha: string;
  artifactDigest: string;
  publicConfig: { hostedAppUrl: string };
  files: Array<{ name: string; sha256: string }>;
};
const origin = manifest.publicConfig.hostedAppUrl;
await Effect.runPromise(
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const deployed = yield* client.get(`${origin}/connect-artifact.json`);
    if (deployed.status < 200 || deployed.status >= 300)
      throw new Error("Missing deployed build receipt");
    const receipt = yield* deployed.json;
    if (JSON.stringify(receipt) !== JSON.stringify(manifest))
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
      JSON.stringify({
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
