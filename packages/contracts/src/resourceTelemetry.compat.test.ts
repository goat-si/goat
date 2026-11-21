import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ShellEnvironmentPatch as BaseShellEnvironmentPatch } from "./resourceTelemetry.base-schema.fixture.ts";
import { ShellEnvironmentPatch } from "./resourceTelemetry.ts";

const decodeBase = Schema.decodeUnknownSync(BaseShellEnvironmentPatch);
const decodeCurrent = Schema.decodeUnknownSync(ShellEnvironmentPatch);

it("decodes old and new shell patches across the base schema", () => {
  const old = { PATH: "/bin" };
  const modern = { PATH: "/bin", GOAT_RELEASE_BASE_URL: "https://mirror.example/releases" };
  assert.deepEqual(decodeCurrent(old), old);
  assert.deepEqual(decodeBase(modern), old);
  assert.deepEqual(decodeCurrent(modern), modern);
});
