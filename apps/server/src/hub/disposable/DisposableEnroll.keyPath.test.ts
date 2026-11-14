import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import { attach, key, listed, world } from "./DisposableAttach.testkit.ts";
import { penRouteOf } from "./DisposableEnroll.testkit.ts";
import { LINK_CONTRACTS, LINK_IDENTITY_CONTRACT } from "./enrollModel.ts";
import { HOME_ATTACH_CONTRACTS } from "./features.ts";
import type { KeyPathAnswer } from "./keyPath.ts";

const enroll = Effect.flatMap(Attach.DisposableAttach, (service) => service.enroll);

/** Attach machine n, let it join Pen with its keys, and settle the admission. */
const joined = (
  pen: Parameters<Parameters<typeof world>[0]>[0],
  host: Parameters<Parameters<typeof world>[0]>[3],
  n: number,
) =>
  Effect.gen(function* () {
    const started = yield* attach(n);
    pen.control.join(started.attachId + ".1", true);
    const nodeId = penNodeId(key(n)) ?? "";
    host.control.routes.set(
      nodeId,
      penRouteOf({ nodeId, noisePub: key(100 + n) }, "ssh-ed25519 " + String(n).repeat(68)),
    );
    yield* listed(started.attachId);
    return { attachId: started.attachId, nodeId };
  });
const linkCalls = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter((args) => args[0] === "link");
const withIdentity = (home: { contracts: Set<string> }) => {
  home.contracts = new Set([...HOME_ATTACH_CONTRACTS, ...LINK_CONTRACTS, LINK_IDENTITY_CONTRACT]);
};

it.effect(
  "a key folder of yours others can write holds the link with the folder and the chmod named, and it goes on once fixed",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        host.control.keyPath = {
          kind: "directory",
          directory: "/home/me",
          problem: "writable",
          owner: 501,
          chmod: true,
        };
        for (let pass = 0; pass < 3; pass += 1) yield* enroll;
        expect(linkCalls(host.control.calls)).toEqual([]);
        expect(yield* listed(attachId)).toMatchObject({
          state: "attaching",
          message: expect.stringContaining("chmod go-w /home/me"),
        });
        host.control.keyPath = { kind: "ok" };
        yield* enroll;
        yield* enroll;
        expect(yield* listed(attachId)).toMatchObject({ state: "linked" });
      }),
    ),
);

it.effect(
  "a shared folder, another user's folder or an unreadable one on the key's path holds the link with no chmod advice",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        withIdentity(home);
        const { attachId } = yield* joined(pen, host, 1);
        const cases: ReadonlyArray<readonly [KeyPathAnswer, string]> = [
          // A team share (2775 root:team), or any folder when GOAT runs as root.
          [
            {
              kind: "directory",
              directory: "/srv/team",
              problem: "writable",
              owner: 0,
              chmod: false,
            },
            "/srv/team can be written by its group or others",
          ],
          [
            {
              kind: "directory",
              directory: "/opt/apps",
              problem: "owner",
              owner: 4242,
              chmod: false,
            },
            "/opt/apps belongs to another user",
          ],
          [{ kind: "unreadable" }, "GOAT could not read a folder on the path"],
        ];
        for (const [answer, says] of cases) {
          host.control.keyPath = answer;
          for (let pass = 0; pass < 3; pass += 1) yield* enroll;
          const machine = yield* listed(attachId);
          expect(machine).toMatchObject({
            state: "attaching",
            message: expect.stringContaining(says),
          });
          expect(machine?.message).not.toContain("chmod");
          if (answer.kind === "directory") expect(machine?.message).toContain("never change");
        }
        expect(linkCalls(host.control.calls)).toEqual([]);
      }),
    ),
);

it.effect("a symlink another user owns on the key's path holds the link and is named", () =>
  world((pen, home, _grant, host) =>
    Effect.gen(function* () {
      withIdentity(home);
      const { attachId } = yield* joined(pen, host, 1);
      host.control.keyPath = { kind: "symlink", path: "/srv/shared/goat" };
      for (let pass = 0; pass < 3; pass += 1) yield* enroll;
      expect(linkCalls(host.control.calls)).toEqual([]);
      expect(yield* listed(attachId)).toMatchObject({
        state: "attaching",
        message: expect.stringContaining("symlink another user owns, /srv/shared/goat"),
      });
    }),
  ),
);
