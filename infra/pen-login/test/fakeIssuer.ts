// @effect-diagnostics nodeBuiltinImport:off globalDate:off - A fake Google issuer for wrangler dev tests.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

export interface IdTokenOverrides {
  readonly aud?: string;
  readonly iss?: string;
  /** Seconds relative to now. */
  readonly expIn?: number;
  readonly nonce?: string;
  readonly email_verified?: boolean;
  readonly sub?: string;
  readonly email?: string;
  /** Sign with this key instead of the published one. */
  readonly signer?: SigningKeyPair;
  /** Redirect back with this state instead of the one received. */
  readonly state?: string;
}

export interface SigningKeyPair {
  readonly kid: string;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly jwk: NodeCrypto.JsonWebKey;
}

export function rsaKey(kid: string): SigningKeyPair {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
  };
}

interface Grant {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly nonce: string;
  readonly challenge: string;
  readonly overrides: IdTokenOverrides;
}

export interface FakeIssuer {
  readonly url: string;
  readonly discovery: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Keys served from the JWKS endpoint. */
  readonly published: Array<SigningKeyPair>;
  /** Overrides for the next authorization only. */
  next: IdTokenOverrides;
  /** The query of the last authorize request. */
  lastAuthorize: URLSearchParams | null;
  jwksFetches: number;
  close(): Promise<void>;
}

const base64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

function sign(claims: Record<string, unknown>, key: SigningKeyPair): string {
  const header = base64url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" }));
  const payload = base64url(JSON.stringify(claims));
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), key.privateKey);
  return `${header}.${payload}.${base64url(signature)}`;
}

function readBody(request: NodeHttp.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const grants = new Map<string, Grant>();
  const server = NodeHttp.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  const url = `http://127.0.0.1:${address.port}`;
  const issuer: FakeIssuer = {
    url,
    discovery: `${url}/.well-known/openid-configuration`,
    clientId: "pen-test-client.apps.googleusercontent.com",
    clientSecret: "pen-test-secret",
    published: [rsaKey("key-a")],
    next: {},
    lastAuthorize: null,
    jwksFetches: 0,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const json = (response: NodeHttp.ServerResponse, status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  server.on("request", (request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url ?? "/", url);
      if (requestUrl.pathname === "/.well-known/openid-configuration") {
        return json(response, 200, {
          issuer: url,
          authorization_endpoint: `${url}/authorize`,
          token_endpoint: `${url}/token`,
          jwks_uri: `${url}/jwks`,
        });
      }
      if (requestUrl.pathname === "/jwks") {
        issuer.jwksFetches++;
        return json(response, 200, { keys: issuer.published.map((key) => key.jwk) });
      }
      if (requestUrl.pathname === "/authorize") {
        const query = requestUrl.searchParams;
        issuer.lastAuthorize = query;
        const valid =
          query.get("response_type") === "code" &&
          query.get("client_id") === issuer.clientId &&
          query.get("code_challenge_method") === "S256" &&
          (query.get("scope") ?? "").split(" ").includes("openid");
        if (!valid) return json(response, 400, { error: "invalid_request" });
        const code = NodeCrypto.randomBytes(16).toString("hex");
        grants.set(code, {
          clientId: query.get("client_id") ?? "",
          redirectUri: query.get("redirect_uri") ?? "",
          nonce: query.get("nonce") ?? "",
          challenge: query.get("code_challenge") ?? "",
          overrides: issuer.next,
        });
        const back = new URL(query.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", issuer.next.state ?? query.get("state") ?? "");
        issuer.next = {};
        response.writeHead(302, { location: back.toString() });
        return response.end();
      }
      if (requestUrl.pathname === "/token" && request.method === "POST") {
        const form = new URLSearchParams(await readBody(request));
        const grant = grants.get(form.get("code") ?? "");
        grants.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = base64url(NodeCrypto.createHash("sha256").update(verifier).digest());
        if (
          !grant ||
          form.get("grant_type") !== "authorization_code" ||
          form.get("client_id") !== grant.clientId ||
          form.get("client_secret") !== issuer.clientSecret ||
          form.get("redirect_uri") !== grant.redirectUri ||
          challenge !== grant.challenge
        ) {
          return json(response, 400, { error: "invalid_grant" });
        }
        const now = Math.floor(Date.now() / 1000);
        const o = grant.overrides;
        const claims = {
          iss: o.iss ?? url,
          aud: o.aud ?? grant.clientId,
          sub: o.sub ?? "100000000000000000001",
          email: o.email ?? "person@example.com",
          email_verified: o.email_verified ?? true,
          nonce: o.nonce ?? grant.nonce,
          iat: now,
          exp: now + (o.expIn ?? 3600),
        };
        const signer = o.signer ?? issuer.published[0];
        if (!signer) return json(response, 500, { error: "no key" });
        return json(response, 200, {
          id_token: sign(claims, signer),
          access_token: "unused",
          token_type: "Bearer",
        });
      }
      json(response, 404, { error: "not_found" });
    })();
  });
  return issuer;
}
