import * as Effect from "effect/Effect";

import { penNodeId } from "./attachModel.ts";
import * as Attach from "./DisposableAttach.ts";
import { attach, key, listed, type world } from "./DisposableAttach.testkit.ts";
import { penRouteOf } from "./DisposableEnroll.testkit.ts";
import { LINK_CONTRACTS, LINK_IDENTITY_CONTRACT } from "./enrollModel.ts";
import { HOME_ATTACH_CONTRACTS } from "./features.ts";

/** One enrollment pass; tests run each pass themselves. */
export const enroll = Effect.flatMap(Attach.DisposableAttach, (service) => service.enroll);

/** Attach machine n, let it join Pen with its keys, and settle the admission. */
export const joined = (
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

/** A Home that declares every link contract, the machine key's included. */
export const withIdentity = (home: { contracts: Set<string> }) => {
  home.contracts = new Set([...HOME_ATTACH_CONTRACTS, ...LINK_CONTRACTS, LINK_IDENTITY_CONTRACT]);
};
