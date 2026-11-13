import { assert, describe, it } from "@effect/vitest";
import { AuthStandardClientScopes, type DesktopPenMembersState } from "@goat/contracts";
import { SshInvalidTargetError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import * as DesktopPenMembers from "../../pen/DesktopPenMembers.ts";
import * as DesktopSshEnvironment from "../../ssh/DesktopSshEnvironment.ts";
import { unusedManager } from "../../ssh/DesktopSshEnvironment.fixture.ts";
import * as DesktopSshPasswordPrompts from "../../ssh/DesktopSshPasswordPrompts.ts";
import { getPenMembers, issuePenMemberSession } from "./penMembers.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@goat/shared/Net";
import { FetchHttpClient } from "effect/http";

vi.mock("electron", () => ({}));

const node = "a".repeat(26);
const self = { selfNodeId: "s".repeat(26), selfName: "this-mac" };
const target = { alias: `pen-${node}`, hostname: `pen-${node}`, username: "me", port: null };
const session = { token: "member-session", expiresAt: null, scopes: AuthStandardClientScopes };
const refusal = new SshInvalidTargetError({ message: "not vouched for" });
const unavailable: DesktopPenMembersState = { kind: "unavailable", seq: 4, reason: "daemon-down" };

const members = (requireTrusted: DesktopPenMembers.DesktopPenMembersShape["requireTrusted"]) =>
  Layer.succeed(DesktopPenMembers.DesktopPenMembers, {
    state: Effect.succeed(unavailable),
    requireTrusted,
  });

/** The real desktop SSH service over a manager whose only live method is session issuance. */
const ssh = (issueClientSession: SshTunnel.SshEnvironmentManagerShape["issueClientSession"]) =>
  Layer.effect(DesktopSshEnvironment.DesktopSshEnvironment, DesktopSshEnvironment.make).pipe(
    Layer.provide(
      Layer.succeed(SshTunnel.SshEnvironmentManager, { ...unusedManager, issueClientSession }),
    ),
    Layer.provide(
      Layer.succeed(
        DesktopSshPasswordPrompts.DesktopSshPasswordPrompts,
        {} as DesktopSshPasswordPrompts.DesktopSshPasswordPrompts["Service"],
      ),
    ),
    Layer.provide(NetService.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeServices.layer),
  );

describe("Pen member IPC", () => {
  it.effect("reads the member list desktop main holds", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* getPenMembers.handler(undefined), unavailable);
    }).pipe(Effect.provide(members(() => Effect.die("unused")))),
  );

  it.effect(
    "asks the member for a 24-hour session named by this desktop's node id, existing-only",
    () => {
      const asked: unknown[] = [];
      return Effect.gen(function* () {
        const result = yield* issuePenMemberSession.handler({ target, penNodeId: node });
        assert.deepEqual(result, {
          accessToken: "member-session",
          expiresAt: null,
          scopes: [...AuthStandardClientScopes],
        });
        assert.deepEqual(asked, [
          {
            target,
            options: {
              penMember: self.selfNodeId,
              label: "GOAT desktop on this-mac (Pen)",
              ttl: "24h",
              scopes: AuthStandardClientScopes,
              installation: "existing-only",
            },
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            ssh((received, options) =>
              Effect.sync(() => {
                asked.push({ target: received, options });
                return session;
              }),
            ),
            members(() => Effect.succeed(self)),
          ),
        ),
      );
    },
  );

  it.effect("a route Pen does not vouch for is refused before ssh is asked for anything", () =>
    Effect.gen(function* () {
      const exit = yield* issuePenMemberSession
        .handler({ target, penNodeId: node })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ssh(() => Effect.die("ssh must not be reached")),
          members((_target, _nodeId, options) =>
            options.requireReady ? Effect.fail(refusal) : Effect.die("must require a live list"),
          ),
        ),
      ),
    ),
  );

  it.effect("without a live member list no session is asked for", () =>
    Effect.gen(function* () {
      const exit = yield* issuePenMemberSession
        .handler({ target, penNodeId: node })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ssh(() => Effect.die("ssh must not be reached")),
          members(() => Effect.sync(() => undefined)),
        ),
      ),
    ),
  );

  it.effect("a member that leaves while its session is being issued gets no token", () => {
    let checks = 0;
    return Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const fiber = yield* issuePenMemberSession
        .handler({ target, penNodeId: node })
        .pipe(
          Effect.provide(
            ssh(() =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(session),
              ),
            ),
          ),
          Effect.exit,
          Effect.forkChild,
        );
      yield* Deferred.await(entered);
      assert.equal(checks, 1);
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.join(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(checks, 2);
      assert.notInclude(JSON.stringify(exit), "member-session");
    }).pipe(
      Effect.provide(
        members(() =>
          Effect.suspend(() => (++checks === 1 ? Effect.succeed(self) : Effect.fail(refusal))),
        ),
      ),
    );
  });
});
