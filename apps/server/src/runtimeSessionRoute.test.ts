import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  EnvironmentId,
  GOAT_RUNTIME_CONTROL_HEADER,
  GOAT_RUNTIME_SESSION_PATH,
  makeChildSetupPurpose,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as RuntimeControl from "./runtimeControl.ts";
import * as RuntimeSessionRoute from "./runtimeSessionRoute.ts";

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-runtime-session-test-" })),
);

const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as Parameters<
    EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
  >[0];

/** Serves the route with the test's own auth, so what it issues can be checked against it. */
const serve = Effect.fn("test.serveRuntimeSessions")(function* () {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const { handler, dispose } = HttpRouter.toWebHandler(
    RuntimeSessionRoute.layer.pipe(
      Layer.provideMerge(Layer.succeed(EnvironmentAuth.EnvironmentAuth, auth)),
      Layer.provideMerge(
        Layer.succeed(RuntimeControl.RuntimeControl, {
          authenticate: (value) => value === "secret",
        }),
      ),
    ),
    {
      disableLogger: true,
      middleware: (effect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const peer = request.headers["x-test-peer"];
          return yield* effect.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              request.modify({ remoteAddress: Option.fromUndefinedOr(peer) }),
            ),
          );
        }),
    },
  );
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));
  return (input: { peer?: string; token?: string; body: unknown }) =>
    Effect.promise(() =>
      handler(
        new Request(`http://127.0.0.1${GOAT_RUNTIME_SESSION_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(input.peer === undefined ? {} : { "x-test-peer": input.peer }),
            ...(input.token === undefined ? {} : { [GOAT_RUNTIME_CONTROL_HEADER]: input.token }),
          },
          body: JSON.stringify(input.body),
        }),
        Context.empty(),
      ),
    );
});

const mcpSession = {
  kind: "session",
  subject: "mcp-client",
  scopes: ["orchestration:read", "orchestration:operate"],
  ttl: "12h",
  label: "hub",
  runtimeModeCeiling: "approval-required",
};

it.layer(NodeServices.layer)("runtime session route", (it) => {
  it.effect(
    "issues an SSH client a session this server accepts, with the scopes it asked for",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const send = yield* serve();
        const response = yield* send({ peer: "127.0.0.1", token: "secret", body: mcpSession });
        expect(response.status).toBe(200);
        const issued = (yield* Effect.promise(() => response.json())) as {
          token: string;
          subject: string;
          scopes: ReadonlyArray<string>;
          expiresAt: string;
        };
        expect(issued.subject).toBe("mcp-client");
        expect(issued.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
        const accepted = yield* auth.authenticateMcpClient(bearer(issued.token));
        expect(accepted.label).toBe("hub");
        expect(accepted.approvals).toBe(false);

        const pairing = yield* send({ peer: "::1", token: "secret", body: { kind: "pairing" } });
        expect(pairing.status).toBe(200);
        const credential = (yield* Effect.promise(() => pairing.json())) as { credential: string };
        expect(credential.credential.length).toBeGreaterThan(0);
      }).pipe(Effect.scoped, Effect.provide(layerAuth)),
  );

  it.effect(
    "SSH runtime control revokes the exact Child setup session and denies untrusted cleanup",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const send = yield* serve();
        const purpose = makeChildSetupPurpose(
          {
            purpose: "opencodex-child-setup",
            homeEnvironmentId: EnvironmentId.make("home"),
            destinationEnvironmentId: EnvironmentId.make("child"),
            operationId: "runtime-revoke",
            grantId: "consent",
            grantRevision: 1,
          },
          "installCodex",
          "install-1",
          yield* Clock.currentTimeMillis,
        );
        const issued = yield* auth.issueSession({
          subject: "mcp-client",
          scopes: ["orchestration:read"],
          childSetupPurpose: purpose,
        });
        const body = { kind: "revoke", sessionId: issued.sessionId };
        expect((yield* send({ peer: "192.0.2.10", token: "secret", body })).status).toBe(403);
        expect((yield* send({ peer: "127.0.0.1", token: "wrong", body })).status).toBe(403);
        expect((yield* auth.authenticateMcpClient(bearer(issued.token))).sessionId).toBe(
          issued.sessionId,
        );
        const response = yield* send({ peer: "127.0.0.1", token: "secret", body });
        expect(response.status).toBe(200);
        const result = yield* Effect.promise(() => response.json()).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({ sessionId: AuthSessionId, revoked: Schema.Boolean }),
            ),
          ),
        );
        expect(result).toEqual({ sessionId: issued.sessionId, revoked: true });
        expect(
          (yield* auth.authenticateMcpClient(bearer(issued.token)).pipe(Effect.result))._tag,
        ).toBe("Failure");
      }).pipe(Effect.scoped, Effect.provide(layerAuth)),
  );

  it.effect("refuses anyone without a loopback peer and the runtime control token", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const send = yield* serve();
      for (const input of [
        { peer: "192.0.2.10", token: "secret" },
        { peer: "127.0.0.1", token: "wrong" },
        { peer: "127.0.0.1" },
        { token: "secret" },
      ])
        expect((yield* send({ ...input, body: mcpSession })).status).toBe(403);
      for (const body of [
        { ...mcpSession, scopes: [] },
        { ...mcpSession, scopes: ["review:write"] },
        { ...mcpSession, ttl: "soon" },
      ])
        expect((yield* send({ peer: "127.0.0.1", token: "secret", body })).status).toBe(400);
      expect(yield* auth.listSessions()).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(layerAuth)),
  );
});

// Live: the served route reads the real clock, so the purpose must be issued against it too.
it.live("preserves the Child setup purpose through runtime session issuance", () =>
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const send = yield* serve();
    const purpose = makeChildSetupPurpose(
      {
        purpose: "opencodex-child-setup",
        homeEnvironmentId: EnvironmentId.make("home"),
        destinationEnvironmentId: EnvironmentId.make("child"),
        operationId: "runtime-issue",
        grantId: "consent",
        grantRevision: 1,
      },
      "installOpenCodex",
      "install-1",
      yield* Clock.currentTimeMillis,
    );
    const body = { ...mcpSession, scopes: ["orchestration:read"], childSetupPurpose: purpose };
    const response = yield* send({ peer: "127.0.0.1", token: "secret", body });
    expect(response.status).toBe(200);
    const issued = (yield* Effect.promise(() => response.json())) as {
      token: string;
      sessionId: string;
      expiresAt: string;
      childSetupPurpose: unknown;
    };
    expect(issued.childSetupPurpose).toEqual(purpose);
    expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual(purpose.expiresAt);
    const accepted = yield* auth.authenticateMcpClient(bearer(issued.token));
    expect(accepted.childSetupPurpose).toEqual(purpose);
    expect(accepted.access).toBe("read-only");

    // Bounded setup issues only read scope; a broader request is refused, not narrowed.
    const broad = yield* send({
      peer: "127.0.0.1",
      token: "secret",
      body: { ...body, scopes: ["orchestration:read", "orchestration:operate"] },
    });
    expect(broad.status).toBe(500);
    expect((yield* auth.listSessions()).map((session) => session.sessionId)).toEqual([
      issued.sessionId,
    ]);
  }).pipe(Effect.scoped, Effect.provide(layerAuth), Effect.provide(NodeServices.layer)),
);
