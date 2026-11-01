import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import { GrokSettings } from "../settings.ts";
import * as ProviderHost from "@goat/provider-core/server/ProviderHost";
import { writeFakeCli } from "@goat/provider-testing/fakeCli";
import * as TestProviderHost from "@goat/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  GROK_API_KEY_ENV,
  GROK_CREDENTIAL_NAMESPACE,
  resolveGrokLaunchEnvironment,
} from "./auth.ts";
import { checkGrokProviderStatus } from "./status.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const layer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const instanceId = ProviderInstanceId.make("grok-status");
const secret = "grok-status-api-key";

const fakeGrok = (directory: string, markerPath: string) =>
  writeFakeCli({
    directory,
    name: "grok",
    source: [
      'import { writeFileSync as writeKeyMarker } from "node:fs";',
      'const key = process.env.XAI_API_KEY?.trim() ?? "";',
      `writeKeyMarker(${JSON.stringify(markerPath)}, key === ${JSON.stringify(secret)} ? "stored" : key === "env-key" ? "env" : key ? "other" : "absent");`,
      'if (process.argv[2] === "--version") { process.stdout.write("grok 1.0.13\\n"); process.exit(0); }',
      'if (process.argv[2] === "models") { process.stdout.write("You are not authenticated.\\n"); process.exit(0); }',
      'if (process.argv[2] === "inspect") { process.stdout.write("{}\\n"); process.exit(0); }',
      "process.exit(3);",
      "",
    ].join("\n"),
  });

it.layer(layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports ready enough to sign in when a stored key is injected", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-status-" });
      const markerPath = path.join(directory, "which-key");
      const binaryPath = fakeGrok(directory, markerPath);
      const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
        GROK_CREDENTIAL_NAMESPACE,
        instanceId,
      );
      yield* credentials.set(new TextEncoder().encode(secret));
      const environment = yield* resolveGrokLaunchEnvironment(instanceId, {
        ...process.env,
        [GROK_API_KEY_ENV]: "",
      });
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath }),
        environment,
      );

      expect(yield* fs.readFileString(markerPath)).toBe("stored");
      expect(snapshot.auth).toEqual({
        status: "authenticated",
        type: "api_key",
        label: "xAI API key",
      });
      expect(["ready", "warning"]).toContain(snapshot.status);
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }).pipe(Effect.scoped),
  );

  it.effect("stays unauthenticated when neither a stored key nor XAI_API_KEY is set", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-status-out-" });
      const markerPath = path.join(directory, "which-key");
      const binaryPath = fakeGrok(directory, markerPath);
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath }),
        { ...process.env, [GROK_API_KEY_ENV]: "" },
      );
      expect(yield* fs.readFileString(markerPath)).toBe("absent");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("grok login");
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    }).pipe(Effect.scoped),
  );

  it.effect("lets an environment XAI_API_KEY win over the stored key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "goat-grok-status-env-" });
      const markerPath = path.join(directory, "which-key");
      const binaryPath = fakeGrok(directory, markerPath);
      const credentials = yield* (yield* ProviderHost.ProviderHost).credentials(
        GROK_CREDENTIAL_NAMESPACE,
        instanceId,
      );
      yield* credentials.set(new TextEncoder().encode(secret));
      const environment = yield* resolveGrokLaunchEnvironment(instanceId, {
        ...process.env,
        [GROK_API_KEY_ENV]: "env-key",
      });
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({ enabled: true, binaryPath }),
        environment,
      );
      expect(yield* fs.readFileString(markerPath)).toBe("env");
      expect(snapshot.auth.status).toBe("authenticated");
      expect(JSON.stringify(snapshot)).not.toContain(secret);
      expect(JSON.stringify(snapshot)).not.toContain("env-key");
    }).pipe(Effect.scoped),
  );
});
