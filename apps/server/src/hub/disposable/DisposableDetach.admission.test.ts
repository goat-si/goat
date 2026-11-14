import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { world } from "./DisposableAttach.testkit.ts";
import { fakeDetachHome } from "./DisposableDetach.testkit.ts";
import { detach, detachPass, linked, PERSON } from "./DisposableDetach.flow.testkit.ts";
import type { Detach } from "./detachModel.ts";
import { decodeEnroll, encodeEnroll } from "./enrollModel.ts";

// A linked machine whose retirement force stopped and whose read-back could not read the journal:
// each state below needs an OpenCodex fault at a narrow moment, so it is stored as GOAT keeps it.

const store = (attachId: string, detachState: Detach, conflict = false) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly enroll_json: string }>`SELECT enroll_json
      FROM disposable_machines WHERE attach_id = ${attachId}`;
    const enrolled = decodeEnroll(row?.enroll_json ?? "{}");
    const json = encodeEnroll({
      ...enrolled,
      detach: detachState,
      health: { failures: 0, checkedAtMs: 0 },
      ...(conflict ? { stop: "host_key_changed" } : {}),
    });
    const conflicts = JSON.stringify(conflict ? ["host_key_changed"] : []);
    yield* sql`UPDATE disposable_machines SET enroll_json = ${json}, conflicts_json = ${conflicts}
      WHERE attach_id = ${attachId}`;
  });

it.effect(
  "after a link_retirement_owned stop, a person's detach reads the stored owner first: nothing held, it purges instead of forcing",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        yield* store(attachId, {
          step: "revoke",
          attempt: 2,
          operationId: attachId + ".force.2",
          force: true,
          stop: "link_retirement_owned",
          outcome: "retirement_owned",
          refusal: "link_retirement_owned",
          owner: attachId + ".force.1",
        });
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        yield* detachPass;
        expect(ocx.sent.filter((id) => id.includes(".force."))).toEqual([]);
        expect(ocx.sent.at(-1)).toContain(".purge.");
      }),
    ),
);

it.effect(
  "a stop stored with no outcome keeps its force id: a person's detach reads it first and repeats what OpenCodex still holds",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId, linkId } = yield* linked(pen, home, host, 1);
        const force1 = attachId + ".force.1";
        ocx.revokes.set(force1, {
          operationId: force1,
          linkId,
          force: true,
          state: "unknown",
          code: "key_revoke_failed",
          ownsReceipt: true,
        });
        yield* store(attachId, {
          step: "revoke",
          attempt: 1,
          operationId: force1,
          sends: 3,
          force: true,
          stop: "revoke_unsettled",
        });
        yield* detach(PERSON, attachId, "d-1");
        yield* detachPass;
        expect(ocx.sent).toEqual([force1]);
        expect(ocx.tombstones.size).toBe(1);
      }),
    ),
);

it.effect(
  "a Force on an open purge stays a force while the purge stays open another pass, and the force id follows once it settles",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        const forces = () => ocx.sent.filter((id) => id.includes(".force."));
        ocx.purgeOpen = true;
        yield* detach(PERSON, attachId, "d-1");
        for (let pass = 0; pass < 4; pass += 1) yield* detachPass;
        yield* detach(PERSON, attachId, "d-2", true);
        yield* detachPass;
        expect(forces()).toEqual([]);
        ocx.purgeOpen = false;
        yield* detachPass;
        expect(forces()).toHaveLength(1);
      }),
    ),
);

it.effect(
  "a person's Force on a linked conflict row stays a force: it never becomes a purge that the conflict stops",
  () =>
    world((pen, home, _grant, host) =>
      Effect.gen(function* () {
        const ocx = fakeDetachHome(host);
        const { attachId } = yield* linked(pen, home, host, 1);
        yield* store(
          attachId,
          {
            step: "revoke",
            attempt: 1,
            operationId: attachId + ".force.1",
            sends: 3,
            force: true,
            stop: "revoke_unsettled",
            outcome: "not_found",
          },
          true,
        );
        yield* detach(PERSON, attachId, "d-1", true);
        yield* detachPass;
        yield* detachPass;
        // The force removes the link without the machine; recover then cleans the machine.
        expect(ocx.sent).toEqual([attachId + ".force.1"]);
      }),
    ),
);
