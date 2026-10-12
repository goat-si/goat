import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AuthTokenExchangeRequest,
  AuthTokenExchangeGrantType,
  AuthAccessTokenType,
} from "./auth.ts";
import { DesktopBackendBootstrap } from "./desktopBootstrap.ts";
import { EnvironmentHttpApi } from "./environmentHttp.ts";
import { ORCHESTRATION_PROTOCOL_VERSION_TEXT } from "./environment.ts";

const decodeTokenRequest = Schema.decodeSync(AuthTokenExchangeRequest);
const decodeBootstrap = Schema.decodeUnknownSync(DesktopBackendBootstrap);
const encodeBootstrap = Schema.encodeSync(DesktopBackendBootstrap);

// goat-rename: legacy-begin
it.each([
  "urn:t3:params:oauth:token-type:environment-bootstrap",
  "urn:goat:params:oauth:token-type:environment-bootstrap",
] as const)("accepts bootstrap token type %s", (subject_token_type) => {
  expect(
    decodeTokenRequest({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: "credential",
      subject_token_type,
      requested_token_type: AuthAccessTokenType,
    }).subject_token_type,
  ).toBe(subject_token_type);
});
const bootstrap = {
  mode: "desktop" as const,
  noBrowser: true,
  port: 5733,
  host: "localhost",
  desktopBootstrapToken: "token",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
describe("desktop bootstrap home aliases", () => {
  it.each(["t3Home", "goatHome"])("decodes %s and re-encodes the legacy key", (key) => {
    const decoded = decodeBootstrap({
      ...bootstrap,
      [key]: "/peer/home",
    });
    expect(decoded.t3Home).toBe("/peer/home");
    const encoded = encodeBootstrap(decoded);
    expect(encoded.t3Home).toBe("/peer/home");
    expect(encoded).not.toHaveProperty("goatHome");
  });
  it("prefers the GOAT value, retains WSL omission, and rejects malformed aliases", () => {
    expect(decodeBootstrap({ ...bootstrap, t3Home: "/old", goatHome: "/new" }).t3Home).toBe("/new");
    expect(decodeBootstrap(bootstrap).t3Home).toBeUndefined();
    expect(() => decodeBootstrap({ ...bootstrap, goatHome: 42 })).toThrow();
  });
});
// HttpApiEndpoint erases header codec types; this schema has no decoding/encoding services.
const headersSchema = EnvironmentHttpApi.groups.orchestration.endpoints.shellSnapshot
  .headers! as Schema.Codec<unknown>;
const decodeHeaders = Schema.decodeUnknownSync(headersSchema);
const encodeHeaders = Schema.encodeUnknownSync(headersSchema);
describe("orchestration protocol header aliases", () => {
  it.each(["x-t3-orchestration-protocol", "x-goat-orchestration-protocol"])(
    "accepts %s and retains legacy encoded headers",
    (header) => {
      const decoded = decodeHeaders({
        [header]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      });
      expect(decoded).toEqual({
        "x-t3-orchestration-protocol": ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      });
      expect(encodeHeaders(decoded)).toEqual(decoded);
    },
  );
  it("rejects missing or incompatible protocol versions without downgrade", () => {
    for (const value of [
      {},
      { "x-goat-orchestration-protocol": "wrong" },
      {
        "x-goat-orchestration-protocol": "wrong",
        "x-t3-orchestration-protocol": ORCHESTRATION_PROTOCOL_VERSION_TEXT,
      },
    ]) {
      expect(() => decodeHeaders(value)).toThrow();
    }
  });
});
// goat-rename: legacy-end
