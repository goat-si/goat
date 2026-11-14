import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Attach from "./DisposableAttach.ts";
import { listed, rows, type world } from "./DisposableAttach.testkit.ts";
import { enroll, joined, withIdentity } from "./DisposableEnroll.joined.testkit.ts";

export const HOUR = 60 * 60 * 1000;
export const THREAD: Attach.AttachCaller = {
  provisioner: { kind: "thread", threadId: "thread-provisioner" },
};
export const PERSON: Attach.AttachCaller = { provisioner: { kind: "person", sessionId: "s-1" } };
export const detachPass = Effect.flatMap(Attach.DisposableAttach, (service) => service.detachPass);
export const detach = (
  caller: Attach.AttachCaller,
  attachId: string,
  request: string,
  force?: boolean,
) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.detach(caller, caller.provisioner.kind + ":x", {
      attachId,
      clientRequestId: request,
      ...(force === undefined ? {} : { force }),
    }),
  );
export const release = (caller: Attach.AttachCaller, attachId: string, request: string) =>
  Effect.flatMap(Attach.DisposableAttach, (service) =>
    service.release(caller, caller.provisioner.kind + ":x", { attachId, clientRequestId: request }),
  );

/** Machine n joined and linked as an exclusive lightweight Child. */
export const linked = (
  pen: Parameters<Parameters<typeof world>[0]>[0],
  home: Parameters<Parameters<typeof world>[0]>[1],
  host: Parameters<Parameters<typeof world>[0]>[3],
  n: number,
) =>
  Effect.gen(function* () {
    withIdentity(home);
    const joinedMachine = yield* joined(pen, host, n);
    for (let pass = 0; pass < 4; pass += 1) yield* enroll;
    const machine = yield* listed(joinedMachine.attachId);
    expect(machine?.state).toBe("linked");
    const row = (yield* rows).find((one) => one.attach_id === joinedMachine.attachId);
    return { ...joinedMachine, linkId: String(row?.link_id) };
  });
