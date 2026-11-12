import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { canResolveHumanStep, sessionResolver } from "../handoffs/HumanStepAuthority.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import type { PenPeer } from "./connectionContext.ts";
import { MAIN_LISTENER, onConnection, penConnection } from "./connectionContext.testkit.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";
import { PEN_PROXY_SUBJECT } from "./sessionBinding.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const peer: PenPeer = {
  meshId: "mesh-1",
  nodeId: "node-a",
  signPub: "sign-a",
  noisePub: "noise-a",
  name: "a",
};
const binding = {
  meshId: peer.meshId,
  nodeId: peer.nodeId,
  signPub: peer.signPub,
  noisePub: peer.noisePub,
};

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-pen-principals-" })),
);

type FakeRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];
const bearer = (token: string) =>
  ({ cookies: {}, headers: { authorization: `Bearer ${token}` } }) as unknown as FakeRequest;

it("a session is a person only when it was issued as one (mesh link design §5)", () => {
  const steps = (row: {
    readonly subject: string;
    readonly principalKind?: "person" | "outside_client" | "proxied_person";
  }) => ({
    personOnly: canResolveHumanStep(sessionResolver(row), "person_only"),
    runtimeApproval: canResolveHumanStep(sessionResolver(row), "runtime_approval"),
  });
  expect(steps({ subject: "browser", principalKind: "person" })).toEqual({
    personOnly: true,
    runtimeApproval: true,
  });
  // A member proxy relays its own person's runtime approvals, never consent or secrets.
  expect(steps({ subject: PEN_PROXY_SUBJECT, principalKind: "proxied_person" })).toEqual({
    personOnly: false,
    runtimeApproval: true,
  });
  // A member agent is an outside client without orchestration:approve.
  expect(steps({ subject: MCP_CLIENT_SUBJECT, principalKind: "outside_client" })).toEqual({
    personOnly: false,
    runtimeApproval: false,
  });
  // No stored kind is not a person, whatever the subject says.
  expect(steps({ subject: "browser" })).toEqual({ personOnly: false, runtimeApproval: false });
});

it.layer(NodeServices.layer)("Pen member principals through EnvironmentAuth", (it) => {
  it.effect(
    "/mcp admits a member agent on its own connection with no approvals and refuses a member proxy",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const agent = yield* sessions.issue({
          subject: MCP_CLIENT_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read", "orchestration:operate"],
          principalKind: "outside_client",
          penBinding: binding,
        });
        const proxy = yield* sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "proxied_person",
          penBinding: binding,
        });
        const own = penConnection(peer).context;
        const admitted = yield* auth.authenticateMcpClient(onConnection(bearer(agent.token), own));
        expect(admitted.approvals).toBe(false);
        expect(admitted.childSetupPurpose).toBeUndefined();
        const proxyAtMcp = yield* Effect.exit(
          auth.authenticateMcpClient(onConnection(bearer(proxy.token), own)),
        );
        expect(Exit.isFailure(proxyAtMcp)).toBe(true);
        const agentOnMain = yield* Effect.exit(
          auth.authenticateMcpClient(onConnection(bearer(agent.token), MAIN_LISTENER)),
        );
        expect(Exit.isFailure(agentOnMain)).toBe(true);
      }).pipe(Effect.provide(layerAuth)),
  );

  it.effect(
    "a member proxy authenticates as proxied_person on its connection; a member agent never outside /mcp",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const agent = yield* sessions.issue({
          subject: MCP_CLIENT_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "outside_client",
          penBinding: binding,
        });
        const proxy = yield* sessions.issue({
          subject: PEN_PROXY_SUBJECT,
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          principalKind: "proxied_person",
          penBinding: binding,
        });
        const own = penConnection(peer).context;
        const session = yield* auth.authenticateHttpRequest(onConnection(bearer(proxy.token), own));
        expect(session.principalKind).toBe("proxied_person");
        expect(canResolveHumanStep(sessionResolver(session), "person_only")).toBe(false);
        const agentHttp = yield* Effect.exit(
          auth.authenticateHttpRequest(onConnection(bearer(agent.token), own)),
        );
        expect(Exit.isFailure(agentHttp)).toBe(true);
        // Pen-bound sessions never get WebSocket tickets: their sockets carry a bearer header.
        expect(
          Exit.isFailure(yield* Effect.exit(auth.issueWebSocketTicket(session, { use: "rpc" }))),
        ).toBe(true);
      }).pipe(Effect.provide(layerAuth)),
  );
  it.effect(
    "every existing kind of session is issued as before: a person unless it is an MCP client",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        for (const subject of [
          "desktop-bootstrap",
          "browser",
          "cli-issued-session",
          "hub-proxy",
          "one-time-token",
        ])
          yield* sessions.issue({ subject });
        yield* sessions.issue({ subject: MCP_CLIENT_SUBJECT, method: "bearer-access-token" });
        const kinds = Object.fromEntries(
          (yield* sessions.listActive()).map((session) => [session.subject, session.principalKind]),
        );
        expect(kinds).toEqual({
          "desktop-bootstrap": "person",
          browser: "person",
          "cli-issued-session": "person",
          "hub-proxy": "person",
          "one-time-token": "person",
          [MCP_CLIENT_SUBJECT]: "outside_client",
        });
      }).pipe(Effect.provide(layerAuth)),
  );
});
