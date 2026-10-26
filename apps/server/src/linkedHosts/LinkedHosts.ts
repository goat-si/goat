import {
  AuthMcpClientAccess,
  AuthMcpApprovalRedirect,
  AuthMcpRegisteredClient,
  AuthMcpTokenResult,
  ExecutionEnvironmentDescriptor,
  type LinkedHostFailureReason,
  type RuntimeMode,
} from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { base64UrlEncode } from "../auth/utils.ts";

/**
 * Linked hosts are other GOAT servers this environment reaches over HTTPS
 * instead of SSH: a headless `goat serve` behind Tailscale, a LAN address or
 * GOAT Connect. Linking spends a one-time pairing code from that host through
 * its own MCP OAuth endpoints, exactly as an outside agent signs in, and keeps
 * the resulting `mcp-client` session. The host decides what that session may
 * do; nothing on the host changes. `SshRemoteDispatch` routes a linked name
 * here, so every host-aware MCP tool reaches it the way it reaches an SSH alias.
 */

/** One secret holds every link, so a link and its token are written together. */
const LINKED_HOSTS_SECRET = "linked-hosts";
/** Never dialled: the code comes back in the decision response, not through a browser. */
const LINK_REDIRECT_URI = "http://127.0.0.1/goat-host-link";
const LINK_TIMEOUT = "20 seconds";
const LINK_CLIENT_NAME_MAX = 100;
/** Lowercase-led, ssh-alias-safe, and short enough to read in a tool result. */
const LINK_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

export class LinkedHostError extends Data.TaggedError("LinkedHostError")<{
  /**
   * invalid_request: the name, URL or code is unusable. link_refused: the host
   * answered and refused (a spent or expired code, too little scope).
   * host_unavailable: the host could not be reached or answered nonsense.
   * storage_failed: this machine could not read or write its links.
   */
  readonly reason: LinkedHostFailureReason;
  readonly message: string;
}> {}

const fail = (reason: LinkedHostError["reason"], message: string) =>
  new LinkedHostError({ reason, message });

const StoredLink = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
  environmentId: Schema.String,
  label: Schema.String,
  serverVersion: Schema.String,
  access: AuthMcpClientAccess,
  token: Schema.String,
  linkedAt: Schema.String,
  expiresAt: Schema.String,
});
type StoredLink = typeof StoredLink.Type;

const Catalog = Schema.Struct({ version: Schema.Literal(1), links: Schema.Array(StoredLink) });
type Catalog = typeof Catalog.Type;
const EMPTY_CATALOG: Catalog = { version: 1, links: [] };
const decodeCatalog = Schema.decodeUnknownEffect(Schema.fromJsonString(Catalog));
const encodeCatalog = Schema.encodeEffect(Schema.fromJsonString(Catalog));

/** A link as tools show it: never the token. */
export type LinkedHost = Omit<StoredLink, "token">;

export interface LinkedHostCredential {
  readonly host: LinkedHost;
  readonly token: string;
}

const view = ({ token: _token, ...host }: StoredLink): LinkedHost => host;

const ACCESS_RANK: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};

/**
 * Why a caller whose own ceiling is `callerMode` may not change anything
 * through a link, or null. The link's session is fixed at link time, so a
 * caller below it would act on the host with more than it holds.
 */
export function linkWriteRefusal(
  host: Pick<LinkedHost, "name" | "access">,
  callerMode: RuntimeMode,
): string | null {
  if (host.access === "read-only")
    return `The link to ${host.name} is read-only. Link it again with a higher access to start or change threads there.`;
  if (ACCESS_RANK[callerMode] < ACCESS_RANK[host.access])
    return `The link to ${host.name} allows ${host.access}, more than this caller's ${callerMode}. Ask from a caller with at least ${host.access}, or link ${host.name} again with access ${callerMode}.`;
  return null;
}

export interface LinkTarget {
  readonly baseUrl: string;
  readonly code: string;
}

/**
 * Reads where to link and with which code. `url` is the host's origin, or a
 * pairing URL whose `#token=` fragment carries the code (what `goat pair` and
 * `goat auth pairing create` print); an explicit `code` wins over the fragment.
 */
export function parseLinkTarget(url: string, code: string | undefined): LinkTarget | string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return `${url} is not a URL. Pass the host's address, such as https://my-host.tailnet.ts.net, or its pairing URL.`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return `${parsed.protocol} is not supported; use the host's https or http address.`;
  if (parsed.username !== "" || parsed.password !== "")
    return "Leave credentials out of the host address.";
  const fromFragment = new URLSearchParams(parsed.hash.replace(/^#/u, "")).get("token") ?? "";
  const fromQuery = parsed.searchParams.get("token") ?? "";
  const resolved = code?.trim() || fromFragment.trim() || fromQuery.trim();
  if (resolved.length === 0)
    return "Pass the host's pairing URL, or its address with code from `goat auth pairing create` on that host.";
  if (parsed.pathname !== "/" && parsed.pathname !== "/pair")
    return `Use the host's origin (${parsed.origin}) or its pairing URL; GOAT serves /mcp only at the root.`;
  return { baseUrl: parsed.origin, code: resolved };
}

export class LinkedHosts extends Context.Service<
  LinkedHosts,
  {
    readonly changes: Stream.Stream<void>;
    readonly list: Effect.Effect<ReadonlyArray<LinkedHost>, LinkedHostError>;
    /** The link and its token, or none when the name is not linked. */
    readonly find: (
      name: string,
    ) => Effect.Effect<Option.Option<LinkedHostCredential>, LinkedHostError>;
    /** Names this machine has linked; a store it cannot read counts as none. */
    readonly names: Effect.Effect<ReadonlyArray<string>>;
    /**
     * Spends the code on the host and saves the link, replacing one with the same name.
     * beforeSave re-checks the caller right before the link is written.
     */
    readonly link: <E, R, E2 = never, R2 = never>(input: {
      readonly name: string;
      readonly url: string;
      readonly code?: string | undefined;
      readonly access: AuthMcpClientAccess;
      readonly clientName: string;
      /** Shown instead of the host's own label. */
      readonly label?: string | undefined;
      readonly beforeSave: Effect.Effect<void, E, R>;
      /** Validates the exchanged identity under the write lock before replacing a link. */
      readonly acceptDescriptor?: (
        descriptor: ExecutionEnvironmentDescriptor,
      ) => Effect.Effect<void, E2, R2>;
    }) => Effect.Effect<
      { readonly host: LinkedHost; readonly replaced: boolean },
      LinkedHostError | E | E2,
      R | R2
    >;
    readonly unlink: (name: string) => Effect.Effect<Option.Option<LinkedHost>, LinkedHostError>;
  }
>()("goat/linkedHosts/LinkedHosts") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const http = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;
  const lock = yield* Semaphore.make(1);
  const signals = yield* PubSub.unbounded<void>();

  const read = secrets.get(LINKED_HOSTS_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(EMPTY_CATALOG),
        onSome: (bytes) => decodeCatalog(new TextDecoder().decode(bytes)),
      }),
    ),
    // An unreadable or newer store fails closed rather than being overwritten.
    Effect.mapError(() => fail("storage_failed", "This machine could not read its linked hosts.")),
  );
  const write = (catalog: Catalog) =>
    encodeCatalog(catalog).pipe(
      Effect.flatMap((json) => secrets.set(LINKED_HOSTS_SECRET, new TextEncoder().encode(json))),
      Effect.mapError(() =>
        fail("storage_failed", "This machine could not save its linked hosts."),
      ),
    );

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    http.execute(request.pipe(HttpClientRequest.setHeader("accept", "application/json"))).pipe(
      // Bodies can carry codes and tokens: never trace or follow them elsewhere.
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
      }),
      Effect.timeout(LINK_TIMEOUT),
      Effect.mapError(() =>
        fail("host_unavailable", `${new URL(request.url).origin} did not answer.`),
      ),
    );
  const bodyOf = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(Effect.orElseSucceed((): unknown => undefined));
  const decoded =
    <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S, what: string) =>
    (body: unknown) =>
      Schema.decodeUnknownEffect(schema)(body).pipe(
        Effect.mapError(() =>
          fail("host_unavailable", `The host answered ${what} with something GOAT cannot read.`),
        ),
      );
  /** The host's own refusal text, when it sent one. */
  const refusal = (body: unknown) => {
    if (typeof body !== "object" || body === null) return undefined;
    const fields = body as Record<string, unknown>;
    const text = fields["message"] ?? fields["error_description"] ?? fields["error"];
    return typeof text === "string" ? text.slice(0, 300) : undefined;
  };

  /** Spends the pairing code through the host's MCP OAuth endpoints. */
  const exchange = Effect.fn("LinkedHosts.exchange")(function* (
    target: LinkTarget,
    access: AuthMcpClientAccess,
    clientName: string,
  ) {
    const url = (path: string) => new URL(path, target.baseUrl).toString();
    const descriptorResponse = yield* send(HttpClientRequest.get(url(GOAT_ENVIRONMENT_PATH)));
    if (descriptorResponse.status !== 200)
      return yield* fail(
        "host_unavailable",
        `${target.baseUrl} is not a GOAT server (HTTP ${descriptorResponse.status} for its environment descriptor).`,
      );
    const descriptor = yield* bodyOf(descriptorResponse).pipe(
      Effect.flatMap(decoded(ExecutionEnvironmentDescriptor, "its environment descriptor")),
    );

    const registered = yield* send(
      HttpClientRequest.post(url("/oauth/mcp/register")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_name: clientName.slice(0, LINK_CLIENT_NAME_MAX),
          redirect_uris: [LINK_REDIRECT_URI],
        }),
      ),
    );
    const registeredBody = yield* bodyOf(registered);
    if (registered.status < 200 || registered.status >= 300)
      return yield* fail(
        "host_unavailable",
        `GOAT on ${target.baseUrl} cannot link agents${registered.status === 404 ? "; update it" : `: ${refusal(registeredBody) ?? `HTTP ${registered.status}`}`}.`,
      );
    const client = yield* decoded(AuthMcpRegisteredClient, "client registration")(registeredBody);

    const verifier = base64UrlEncode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
    const challenge = base64UrlEncode(
      yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
    );
    const state = base64UrlEncode(yield* crypto.randomBytes(16).pipe(Effect.orDie));
    const resource = url("/mcp");
    const decision = yield* send(
      HttpClientRequest.post(url("/oauth/mcp/decision")).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          authorization: {
            response_type: "code",
            client_id: client.client_id,
            redirect_uri: LINK_REDIRECT_URI,
            code_challenge: challenge,
            code_challenge_method: "S256",
            state,
            resource,
          },
          decision: { _tag: "pairing-code", access, code: target.code },
        }),
      ),
    );
    const decisionBody = yield* bodyOf(decision);
    if (decision.status < 200 || decision.status >= 300)
      return yield* fail(
        "link_refused",
        `${target.baseUrl} refused the pairing code: ${refusal(decisionBody) ?? `HTTP ${decision.status}`}. Create a new one on that host with goat auth pairing create.`,
      );
    const { redirectTo } = yield* decoded(AuthMcpApprovalRedirect, "the approval")(decisionBody);
    const answer = URL.parse(redirectTo);
    const authorizationCode = answer?.searchParams.get("code");
    if (
      answer === null ||
      `${answer.origin}${answer.pathname}` !== LINK_REDIRECT_URI ||
      answer.searchParams.get("state") !== state ||
      !authorizationCode
    )
      return yield* fail(
        "link_refused",
        `${target.baseUrl} did not approve the link: ${answer?.searchParams.get("error_description") ?? answer?.searchParams.get("error") ?? "no code came back"}.`,
      );

    const tokenResponse = yield* send(
      HttpClientRequest.post(url("/oauth/mcp/token")).pipe(
        HttpClientRequest.bodyUrlParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: LINK_REDIRECT_URI,
          client_id: client.client_id,
          code_verifier: verifier,
          resource,
        }),
      ),
    );
    const tokenBody = yield* bodyOf(tokenResponse);
    if (tokenResponse.status !== 200)
      return yield* fail(
        "link_refused",
        `${target.baseUrl} would not issue the session: ${refusal(tokenBody) ?? `HTTP ${tokenResponse.status}`}.`,
      );
    const token = yield* decoded(AuthMcpTokenResult, "the token request")(tokenBody);
    return { descriptor, token };
  });

  const list: LinkedHosts["Service"]["list"] = read.pipe(
    Effect.map((catalog) =>
      catalog.links.map(view).toSorted((left, right) => left.name.localeCompare(right.name)),
    ),
  );

  const find: LinkedHosts["Service"]["find"] = (name) =>
    read.pipe(
      Effect.map((catalog) =>
        Option.fromNullishOr(catalog.links.find((link) => link.name === name.trim())).pipe(
          Option.map((link) => ({ host: view(link), token: link.token })),
        ),
      ),
    );

  const names: LinkedHosts["Service"]["names"] = read.pipe(
    Effect.map((catalog) => catalog.links.map((link) => link.name)),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );

  const link: LinkedHosts["Service"]["link"] = <E, R, E2 = never, R2 = never>(input: {
    readonly name: string;
    readonly url: string;
    readonly code?: string | undefined;
    readonly access: AuthMcpClientAccess;
    readonly clientName: string;
    readonly label?: string | undefined;
    readonly beforeSave: Effect.Effect<void, E, R>;
    readonly acceptDescriptor?: (
      descriptor: ExecutionEnvironmentDescriptor,
    ) => Effect.Effect<void, E2, R2>;
  }) =>
    Effect.gen(function* () {
      const name = input.name.trim();
      if (!LINK_NAME.test(name))
        return yield* fail(
          "invalid_request",
          `"${input.name}" cannot name a linked host: use lowercase letters, digits, ".", "_" and "-", up to 63 characters.`,
        );
      const target = parseLinkTarget(input.url, input.code);
      if (typeof target === "string") return yield* fail("invalid_request", target);
      const { descriptor, token } = yield* exchange(target, input.access, input.clientName);
      const now = yield* Clock.currentTimeMillis;
      const stored: StoredLink = {
        name,
        baseUrl: target.baseUrl,
        environmentId: descriptor.environmentId,
        label: input.label?.trim() || descriptor.label,
        serverVersion: descriptor.serverVersion,
        access: input.access,
        token: token.access_token,
        linkedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + token.expires_in * 1000)),
      };
      return yield* lock.withPermits(1)(
        Effect.gen(function* () {
          // The exchange took several requests; the caller may have lost its authority.
          yield* input.beforeSave;
          if (input.acceptDescriptor) yield* input.acceptDescriptor(descriptor);
          const catalog = yield* read;
          const replaced = catalog.links.some((existing) => existing.name === name);
          yield* write({
            version: 1,
            links: [...catalog.links.filter((existing) => existing.name !== name), stored],
          });
          yield* PubSub.publish(signals, undefined);
          return { host: view(stored), replaced };
        }),
      );
    });

  const unlink: LinkedHosts["Service"]["unlink"] = (name) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const catalog = yield* read;
        const found = catalog.links.find((existing) => existing.name === name.trim());
        if (found === undefined) return Option.none();
        yield* write({
          version: 1,
          links: catalog.links.filter((existing) => existing !== found),
        });
        yield* PubSub.publish(signals, undefined);
        return Option.some(view(found));
      }),
    );

  return LinkedHosts.of({ changes: Stream.fromPubSub(signals), list, find, names, link, unlink });
});

export const layer = Layer.effect(LinkedHosts, make);
