// @effect-diagnostics nodeBuiltinImport:off -- a fake Pen control socket on a scratch unix socket.
import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { guardErrors } from "@goat/shared/errorGuards";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../../serverSettings.ts";
import { PenInvites } from "./PenInvites.ts";
import * as PenInvitesSocket from "./PenInvitesSocket.ts";

const SIGN = Buffer.alloc(32, 1).toString("base64url");

/** Answers each op with the line `reply` returns, recording what it was asked. */
const fakePen = (dir: string, reply: (op: Record<string, unknown>) => string) =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeNet.Server; asked: Array<Record<string, unknown>> }>((resume) => {
      const asked: Array<Record<string, unknown>> = [];
      const server = NodeNet.createServer((socket) => {
        socket.once("data", (chunk) => {
          const op = JSON.parse(chunk.toString("utf8")) as Record<string, unknown>;
          asked.push(op);
          socket.end(reply(op) + "\n");
        });
      });
      server.listen(dir + "/control.sock", () => resume(Effect.succeed({ server, asked })));
    }),
    ({ server }) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

const world = <A, E>(
  body: (dir: string) => Effect.Effect<A, E, PenInvites | FileSystem.FileSystem | Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pen-ctl-" });
    return yield* body(dir).pipe(
      Effect.provide(
        PenInvitesSocket.layer.pipe(
          Layer.provide(
            Settings.ServerSettingsService.layerTest({
              pen: {
                executablePath: "/opt/pen",
                stateDir: dir,
                meshId: "a".repeat(26),
                nodeId: "b".repeat(26),
              },
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.live("speaks Pen's bound-invite ops on its control socket and reads only what Pen saved", () =>
  world((dir) =>
    Effect.gen(function* () {
      const pen = yield* fakePen(dir, (op) => {
        switch (op.op) {
          case "status":
            return JSON.stringify({
              nodeId: "x",
              features: ["invite.subject/1", "invite.status/1"],
            });
          case "ls":
            return JSON.stringify({ members: [{ signPub: SIGN, nodeId: "y" }] });
          case "invite":
            return JSON.stringify({
              token: "pen1_T",
              relay: "wss://r",
              expiresAt: 5,
              command: "x",
              windowsCommand: "y",
              id: "inv-1",
              mintId: op.mintId,
            });
          case "invite.status":
            return JSON.stringify({
              t: "invite-status",
              inviteId: "inv-1",
              mintId: "m-1",
              state: "burned",
              nonce: "n1",
              admit: "h1",
              member: true,
            });
          case "invite.cancel":
            return JSON.stringify({ t: "invite-cancel", mintId: "m-1", state: "burned" });
          case "invite.ack":
            // Names no invite at all.
            return JSON.stringify({ t: "invite-ack", state: "acked" });
          default:
            return JSON.stringify({ error: "bad request" });
        }
      });
      const invites = yield* PenInvites;
      expect(yield* invites.features).toEqual(new Set(["invite.subject/1", "invite.status/1"]));
      const members = yield* invites.members;
      expect(members?.has(SIGN)).toBe(true);
      expect(members?.has(Buffer.alloc(32, 2).toString("base64url"))).toBe(false);
      const subject = { signPub: SIGN, noisePub: SIGN, name: "cc-1" };
      expect(yield* invites.mint({ subject, mintId: "m-1", expiresAtMs: 5 })).toEqual({
        inviteId: "inv-1",
        token: "pen1_T",
        expiresAtMs: 5,
      });
      expect(pen.asked.at(-1)).toEqual({ op: "invite", subject, mintId: "m-1", expiresAt: 5 });
      expect(yield* invites.status({ mintId: "m-1" })).toEqual({
        inviteId: "inv-1",
        state: "burned",
        nonce: "n1",
        admit: "h1",
        member: true,
      });
      expect(yield* invites.cancel({ mintId: "m-1" })).toBe("burned");
      // A refusal, or an answer that names another invite or none, is never read as this one.
      const unread = <A, R>(op: Effect.Effect<A, { readonly _tag: string }, R>) =>
        op.pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        );
      expect(yield* unread(invites.cancel({ mintId: "m-2" }))).toBe("PenInviteUnknown");
      expect(yield* unread(invites.status({ mintId: "m-2" }))).toBe("PenInviteUnknown");
      expect(yield* unread(invites.ack({ mintId: "m-1" }))).toBe("PenInviteUnknown");
    }),
  ),
);

it.live("an older Pen whose status lists no features declares none", () =>
  world((dir) =>
    Effect.gen(function* () {
      yield* fakePen(dir, () => JSON.stringify({ nodeId: "x" }));
      expect(yield* (yield* PenInvites).features).toEqual(new Set());
    }),
  ),
);

it.effect("the op timeout destroys a control socket whose connect never completes", () =>
  Effect.gen(function* () {
    const connecting = yield* Deferred.make<NodeNet.Socket>();
    const hanging = PenInvitesSocket.layerConnecting((_path, onError) => {
      const socket = guardErrors(new NodeNet.Socket(), onError);
      Deferred.doneUnsafe(connecting, Effect.succeed(socket));
      return socket;
    });
    yield* Effect.gen(function* () {
      const subject = { signPub: SIGN, noisePub: SIGN, name: "cc-1" };
      const minting = yield* (yield* PenInvites)
        .mint({ subject, mintId: "m-1", expiresAtMs: 5 })
        .pipe(Effect.flip, Effect.forkChild);
      const socket = yield* Deferred.await(connecting);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(minting)).reason).toBe("timed out");
      expect(socket.destroyed).toBe(true);
    }).pipe(
      Effect.provide(
        hanging.pipe(
          Layer.provide(
            Settings.ServerSettingsService.layerTest({
              pen: {
                executablePath: "/opt/pen",
                stateDir: "/nonexistent-pen-state",
                meshId: "a".repeat(26),
                nodeId: "b".repeat(26),
              },
            }),
          ),
        ),
      ),
    );
  }),
);
