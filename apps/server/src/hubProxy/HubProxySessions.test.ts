import { expect, it } from "@effect/vitest";
import { HUB_PROXY_NODE_SCOPE_CEILING, type AuthEnvironmentScope } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { enrollmentSecretName } from "./HubProxySessions.ts";
import {
  makeNodes,
  makeSecrets,
  makeSessions,
  makeSsh,
  readScopes,
  serve,
  sshNode,
  startNode,
} from "./testFixtures.ts";

const fixture = Effect.fnUntraced(function* (options?: Parameters<typeof makeSsh>[1]) {
  const nodes = yield* makeNodes();
  const ssh = makeSsh("http://127.0.0.1:1/", { uniqueTokens: true, ...options });
  const secrets = makeSecrets();
  const sessions = yield* makeSessions(nodes.service, ssh.service, secrets.service);
  yield* nodes.subscribed;
  return { nodes, ssh, secrets, sessions };
});

it.effect("caches sessions by the exact scope set, independent of scope order", () =>
  Effect.gen(function* () {
    const { sessions, ssh } = yield* fixture();
    const read = yield* sessions.open("node-1", readScopes);
    const both = yield* sessions.open("node-1", ["orchestration:read", "orchestration:operate"]);
    expect(
      (yield* sessions.open("node-1", ["orchestration:operate", "orchestration:read"])).token,
    ).toBe(both.token);
    expect((yield* sessions.open("node-1", readScopes)).token).toBe(read.token);
    expect(read.token).not.toBe(both.token);
    expect(ssh.issues).toEqual([readScopes, ["orchestration:read", "orchestration:operate"]]);
    expect(ssh.endpoints[0]).toEqual({
      alias: "alias",
      hostname: "actual.host",
      username: "remote-user",
      port: 2201,
    });
  }).pipe(Effect.scoped),
);

it.effect("a cached session follows the node's forward to its new port after a relaunch", () =>
  Effect.gen(function* () {
    const { sessions, ssh } = yield* fixture();
    const before = yield* sessions.open("node-1", readScopes);
    ssh.moveForward("http://127.0.0.1:2/");
    const after = yield* sessions.open("node-1", readScopes);
    expect(after.token).toBe(before.token);
    expect(ssh.issues).toHaveLength(1);
    expect(after.httpBaseUrl).toBe("http://127.0.0.1:2/");
    expect(after.wsBaseUrl).toBe("ws://127.0.0.1:2/");
  }),
);

it.effect("refreshes a node session exactly ten minutes before expiry using TestClock", () =>
  Effect.gen(function* () {
    const { sessions, ssh } = yield* fixture();
    const first = yield* sessions.open("node-1", readScopes);
    yield* TestClock.adjust("709 minutes");
    expect((yield* sessions.open("node-1", readScopes)).token).toBe(first.token);
    expect(ssh.issues).toHaveLength(1);
    yield* TestClock.adjust("1 minute");
    expect((yield* sessions.open("node-1", readScopes)).token).not.toBe(first.token);
    expect(ssh.issues).toHaveLength(2);
  }).pipe(Effect.scoped),
);

it.effect("invalidate drops only the rejected token and preserves another scope-set session", () =>
  Effect.gen(function* () {
    const { sessions, ssh } = yield* fixture();
    const read = yield* sessions.open("node-1", readScopes);
    const both = yield* sessions.open("node-1", ["orchestration:read", "orchestration:operate"]);
    yield* sessions.invalidate("node-1", "unrelated-token");
    expect((yield* sessions.open("node-1", readScopes)).token).toBe(read.token);
    yield* sessions.invalidate("node-1", read.token);
    expect(
      (yield* sessions.open("node-1", ["orchestration:operate", "orchestration:read"])).token,
    ).toBe(both.token);
    expect((yield* sessions.open("node-1", readScopes)).token).not.toBe(read.token);
    expect(ssh.issues).toHaveLength(3);
  }).pipe(Effect.scoped),
);

it.effect.each([
  { grants: ["orchestration:read", "orchestration:operate"] },
  { grants: [] },
] satisfies Array<{ grants: Array<AuthEnvironmentScope> }>)(
  "refuses issued scopes that differ from requested scopes ($grants)",
  ({ grants }) =>
    Effect.gen(function* () {
      const { sessions, ssh } = yield* fixture({ grants });
      expect(yield* Effect.flip(sessions.open("node-1", readScopes))).toMatchObject({
        reason: "refused",
      });
      expect(yield* Effect.flip(sessions.open("node-1", readScopes))).toMatchObject({
        reason: "refused",
      });
      expect(ssh.issues).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect(
  "refreshes snapshots every 60 seconds while relays exist and stops after the last release",
  () =>
    Effect.gen(function* () {
      const node = yield* startNode();
      const nodes = yield* makeNodes();
      const sessions = yield* makeSessions(
        nodes.service,
        makeSsh(node.baseUrl).service,
        makeSecrets().service,
      );
      yield* nodes.subscribed;
      const firstScope = yield* Scope.make();
      const secondScope = yield* Scope.make();
      yield* sessions.trackRelay("node-1").pipe(Effect.provideService(Scope.Scope, firstScope));
      expect(yield* Queue.take(node.shellRequests)).toBe(1);
      yield* sessions.trackRelay("node-1").pipe(Effect.provideService(Scope.Scope, secondScope));
      yield* TestClock.adjust("59 seconds");
      expect(yield* Queue.size(node.shellRequests)).toBe(0);
      const before = Option.getOrThrow(yield* sessions.snapshot("node-1"));
      expect(JSON.parse(before.body).snapshotSequence).toBe(1);
      yield* TestClock.adjust("1 second");
      expect(yield* Queue.take(node.shellRequests)).toBe(2);
      yield* Scope.close(firstScope, Exit.void);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Queue.take(node.shellRequests)).toBe(3);
      yield* Scope.close(secondScope, Exit.void);
      expect(yield* Queue.take(node.shellRequests)).toBe(4);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Queue.size(node.shellRequests)).toBe(0);
      const last = Option.getOrThrow(yield* sessions.snapshot("node-1"));
      expect(JSON.parse(last.body).snapshotSequence).toBe(4);
      expect(last.capturedAt).not.toBe(before.capturedAt);
    }).pipe(Effect.scoped),
);

it.effect("requires enrollment before opening a linked route", () =>
  Effect.gen(function* () {
    const nodes = yield* makeNodes({
      ...sshNode,
      routes: [{ kind: "linked", baseUrl: "https://node.invalid" }],
    });
    const ssh = makeSsh("http://127.0.0.1:1/");
    const sessions = yield* makeSessions(nodes.service, ssh.service, makeSecrets().service);
    expect(yield* Effect.flip(sessions.open("node-1", readScopes))).toMatchObject({
      reason: "enrollment_required",
    });
    expect(ssh.endpoints).toEqual([]);
    expect(ssh.issues).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "enrolls with the exact ceiling and client label, persists the secret, and unenroll revokes access",
  () =>
    Effect.gen(function* () {
      const forms: Array<URLSearchParams> = [];
      const baseUrl = yield* serve(
        HttpRouter.add(
          "*",
          "/*",
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (request.url === "/.well-known/goat/environment")
              return HttpServerResponse.jsonUnsafe({ environmentId: sshNode.environmentId });
            expect(request.url).toBe("/oauth/token");
            expect(request.method).toBe("POST");
            expect(request.headers["content-type"]).toContain("application/x-www-form-urlencoded");
            forms.push(new URLSearchParams(yield* request.text));
            return HttpServerResponse.jsonUnsafe({
              access_token: "ENROLLED_NODE_TOKEN",
              token_type: "Bearer",
              expires_in: 3600,
              scope: HUB_PROXY_NODE_SCOPE_CEILING.join(" "),
            });
          }),
        ),
      );
      const nodes = yield* makeNodes({
        ...sshNode,
        routes: [{ kind: "linked", baseUrl: baseUrl.replace(/\/$/u, "") }],
      });
      const secrets = makeSecrets();
      const sessions = yield* makeSessions(
        nodes.service,
        makeSsh(baseUrl).service,
        secrets.service,
      );
      yield* nodes.subscribed;
      expect(
        yield* sessions.enroll({
          nodeId: "node-1",
          pairingUrl: `${baseUrl}pair#token=pairing-secret`,
        }),
      ).toEqual({ scopes: HUB_PROXY_NODE_SCOPE_CEILING });
      expect(forms).toHaveLength(1);
      expect(forms[0]?.get("scope")).toBe(HUB_PROXY_NODE_SCOPE_CEILING.join(" "));
      expect(forms[0]?.get("client_label")).toBe("GOAT hub proxy");
      expect(forms[0]?.get("subject_token")).toBe("pairing-secret");
      expect(forms[0]?.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:token-exchange");
      expect([...secrets.values.keys()]).toEqual([enrollmentSecretName("node-1")]);
      const stored = JSON.parse(
        new TextDecoder().decode(secrets.values.get(enrollmentSecretName("node-1"))),
      );
      expect(stored).toMatchObject({
        nodeId: "node-1",
        token: "ENROLLED_NODE_TOKEN",
        scopes: HUB_PROXY_NODE_SCOPE_CEILING,
      });
      const opened = yield* sessions.open("node-1", readScopes);
      expect(opened.token).toBe(stored.token);
      const revoked = yield* sessions.revoked("node-1", opened.generation).pipe(Effect.forkScoped);
      expect(yield* sessions.unenroll("node-1")).toBe(true);
      yield* Fiber.join(revoked);
      expect(secrets.values.has(enrollmentSecretName("node-1"))).toBe(false);
      expect(yield* sessions.isCurrent("node-1", opened.generation)).toBe(false);
      expect(yield* Effect.flip(sessions.open("node-1", readScopes))).toMatchObject({
        reason: "enrollment_required",
      });
    }).pipe(Effect.scoped),
);

it.effect("S2: limit reports SSH rights without acquiring an endpoint or issuing a session", () =>
  Effect.gen(function* () {
    const { sessions, ssh } = yield* fixture();
    const scopes = ["orchestration:read", "orchestration:operate"] as const;
    expect(yield* sessions.limit("node-1", scopes)).toEqual(scopes);
    expect(yield* sessions.limit("missing", scopes)).toEqual([]);
    expect(ssh.endpoints).toEqual([]);
    expect(ssh.issues).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("a read-only refresh keeps a linked node's operate session for uploads", () =>
  Effect.gen(function* () {
    const baseUrl = "https://node.invalid";
    const nodes = yield* makeNodes({ ...sshNode, routes: [{ kind: "linked", baseUrl }] });
    const secrets = makeSecrets();
    const sessions = yield* makeSessions(nodes.service, makeSsh(baseUrl).service, secrets.service);
    yield* nodes.subscribed;
    const operate = ["orchestration:read", "orchestration:operate"] as const;
    yield* secrets.service.set(
      enrollmentSecretName("node-1"),
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          nodeId: "node-1",
          baseUrl,
          token: "linked-token",
          scopes: operate,
          expiresAt: null,
        }),
      ),
    );
    yield* sessions.open("node-1", operate);
    // What the snapshot refresher does while a relay is open.
    yield* sessions.open("node-1", readScopes);
    const forUpload = yield* sessions.peek("node-1", "orchestration:operate");
    expect(Option.getOrNull(forUpload)?.scopes).toEqual(operate);
  }).pipe(Effect.scoped),
);

it.effect("S2: limit stops advertising a linked enrollment once it expires", () =>
  Effect.gen(function* () {
    const baseUrl = "https://node.invalid";
    const nodes = yield* makeNodes({ ...sshNode, routes: [{ kind: "linked", baseUrl }] });
    const secrets = makeSecrets();
    const ssh = makeSsh(baseUrl);
    const sessions = yield* makeSessions(nodes.service, ssh.service, secrets.service);
    yield* nodes.subscribed;
    const scopes = ["orchestration:read", "orchestration:operate"] as const;
    yield* secrets.service.set(
      enrollmentSecretName("node-1"),
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          nodeId: "node-1",
          baseUrl,
          token: "linked-token",
          scopes,
          // TestClock starts at the epoch.
          expiresAt: "1970-01-01T01:00:00.000Z",
        }),
      ),
    );
    expect(yield* sessions.limit("node-1", scopes)).toEqual(scopes);
    yield* TestClock.adjust("1 hour");
    expect(yield* sessions.limit("node-1", scopes)).toEqual([]);
    expect(ssh.endpoints).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect(
  "S2: limit follows linked enrollment scopes, replacement and rejection without dialing",
  () =>
    Effect.gen(function* () {
      const baseUrl = "https://node.invalid";
      const nodes = yield* makeNodes({ ...sshNode, routes: [{ kind: "linked", baseUrl }] });
      const secrets = makeSecrets();
      const ssh = makeSsh(baseUrl);
      const sessions = yield* makeSessions(nodes.service, ssh.service, secrets.service);
      yield* nodes.subscribed;
      const scopes = ["orchestration:read", "orchestration:operate"] as const;
      const save = (granted: ReadonlyArray<AuthEnvironmentScope>) =>
        secrets.service.set(
          enrollmentSecretName("node-1"),
          new TextEncoder().encode(
            JSON.stringify({
              version: 1,
              nodeId: "node-1",
              baseUrl,
              token: "linked-token",
              scopes: granted,
              expiresAt: null,
            }),
          ),
        );
      expect(yield* sessions.limit("node-1", scopes)).toEqual([]);
      yield* save(readScopes);
      expect(yield* sessions.limit("node-1", scopes)).toEqual(["orchestration:read"]);
      yield* save(scopes);
      expect(yield* sessions.limit("node-1", scopes)).toEqual([
        "orchestration:read",
        "orchestration:operate",
      ]);
      const opened = yield* sessions.open("node-1", scopes);
      expect(opened.scopes).toEqual(["orchestration:read", "orchestration:operate"]);
      yield* sessions.invalidate("node-1", opened.token);
      expect(yield* sessions.limit("node-1", scopes)).toEqual([]);
      expect(ssh.endpoints).toEqual([]);
      expect(ssh.issues).toEqual([]);
    }).pipe(Effect.scoped),
);
