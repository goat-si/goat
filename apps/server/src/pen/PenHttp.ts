import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { connectionOf, type PenConnection } from "../auth/connectionContext.ts";
import { MCP_CLIENT_SUBJECT } from "../auth/mcpClientSubject.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { PenEnablement } from "./PenEnablement.ts";
import { admitPenRequest, bearerOf, type PenRouteGrant } from "./penRoutes.ts";
import { PEN_SESSION_LIMITS, PenSessions } from "./PenSessions.ts";

const empty = (status: number) =>
  HttpServerResponse.empty({ status, headers: { connection: "close" } });

const isUpgrade = (headers: HttpServerRequest.HttpServerRequest["headers"]) =>
  typeof headers["upgrade"] === "string" && headers["upgrade"].toLowerCase() === "websocket";

const grantAdmits = (grant: PenRouteGrant, session: SessionStore.VerifiedSession) => {
  if (session.penBinding === undefined) return false;
  if (grant.scope !== undefined && !session.scopes.includes(grant.scope)) return false;
  return grant.credential === "agent"
    ? session.subject === MCP_CLIENT_SUBJECT && session.principalKind === "outside_client"
    : grant.credential === "proxy" && session.principalKind === "proxied_person";
};

/** The received header lines of a Node request; a request without them cannot carry a duplicate. */
const rawHeadersOf = (request: HttpServerRequest.HttpServerRequest): ReadonlyArray<string> => {
  const source: unknown = request.source;
  const raw =
    typeof source === "object" && source !== null
      ? (source as { readonly rawHeaders?: unknown }).rawHeaders
      : undefined;
  return Array.isArray(raw)
    ? raw.filter((value): value is string => typeof value === "string")
    : [];
};

const admitPen = Effect.fn("PenHttp.admitPen")(function* (
  sessions: SessionStore.SessionStore["Service"],
  request: HttpServerRequest.HttpServerRequest,
  connection: PenConnection,
) {
  const admission = admitPenRequest({
    method: request.method,
    url: request.url,
    upgrade: isUpgrade(request.headers),
    headers: request.headers,
    rawHeaders: rawHeadersOf(request),
  });
  if (admission.kind === "refuse") return Option.some(empty(admission.status));
  if (admission.grants.every((grant) => grant.credential === "none")) return Option.none();
  const session = yield* sessions
    .verify(bearerOf(request.headers["authorization"]) ?? "", connection)
    .pipe(Effect.option);
  if (Option.isNone(session)) return Option.some(empty(401));
  return admission.grants.some((grant) => grantAdmits(grant, session.value))
    ? Option.none()
    : Option.some(empty(404));
});

/**
 * The credential half of the Pen route table (mesh link design §5), before routing for every
 * request. A request the main listener accepted passes untouched. One with no connection context,
 * or a Pen request while the build keeps Pen closed, is 404. A Pen request needs a table row and,
 * on a credentialed row, a live session of that row's kind bound to this connection.
 */
export const layerPenRouteGate = Layer.unwrap(
  Effect.gen(function* () {
    const enablement = yield* PenEnablement;
    const sessions = yield* SessionStore.SessionStore;
    return HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const connection = connectionOf(request);
          if (connection?.kind === "main") return yield* httpEffect;
          if (connection === undefined || !enablement.enabled) return empty(404);
          const refused = yield* admitPen(sessions, request, connection);
          return Option.isSome(refused) ? refused.value : yield* httpEffect;
        }),
      { global: true },
    );
  }),
);

const readBody = (request: HttpServerRequest.HttpServerRequest) =>
  request.stream.pipe(
    Stream.runFoldEffect(
      () => new Uint8Array(0),
      (bytes, chunk) =>
        bytes.length + chunk.length > PEN_SESSION_LIMITS.bodyBytes
          ? Effect.fail("too-large" as const)
          : Effect.succeed(Buffer.concat([bytes, chunk])),
    ),
    Effect.map((bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
  );

/** POST /api/pen/session: a member session issued for the connection's proven member. */
export const layerPenSessionRoute = Layer.unwrap(
  Effect.gen(function* () {
    const penSessions = yield* PenSessions;
    return HttpRouter.add(
      "POST",
      "/api/pen/session",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const connection = connectionOf(request);
        if (connection?.kind !== "pen") return empty(404);
        const declared = Number(request.headers["content-length"] ?? 0);
        if (!(declared <= PEN_SESSION_LIMITS.bodyBytes)) return empty(413);
        const body = yield* readBody(request).pipe(Effect.option);
        if (Option.isNone(body)) return empty(413);
        return yield* penSessions.issue(connection, body.value).pipe(
          Effect.map((issued) =>
            HttpServerResponse.jsonUnsafe(
              {
                token: issued.token,
                expiresAt: DateTime.formatIso(issued.expiresAt),
                scopes: issued.scopes,
                kind: issued.kind,
              },
              { headers: { "cache-control": "no-store" } },
            ),
          ),
          Effect.catchTags({
            PenSessionRefusal: (refusal) =>
              Effect.succeed(
                HttpServerResponse.jsonUnsafe(
                  { code: refusal.code, message: refusal.message },
                  {
                    status: refusal.code === "refused" ? 400 : 503,
                    headers: {
                      "cache-control": "no-store",
                      ...(refusal.code === "overloaded" ? { "retry-after": "5" } : {}),
                    },
                  },
                ),
              ),
          }),
        );
      }),
    );
  }),
);
