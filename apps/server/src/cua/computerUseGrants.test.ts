import { assert, describe, it } from "@effect/vitest";
import { ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { coversApps, holderOf } from "./computerUseGrants.ts";
import type { ComputerUseLease } from "./ComputerUseLeases.ts";

const holder = ThreadId.make("thread:holder");
const lease = (apps: ReadonlyArray<string>): ComputerUseLease => ({
  threadId: holder,
  handoffId: TurnItemId.make("handoff:holder"),
  expiresAt: DateTime.makeUnsafe(60_000),
  apps,
});
const heldBy = (held: ReadonlyArray<string>, wanted: ReadonlyArray<string>) =>
  Option.isSome(holderOf([lease(held)], ThreadId.make("thread:asking"), wanted, undefined));

describe("app identities across holders and approvals", () => {
  it("tells Linux paths apart by case, and Windows paths by how Windows spells them", () => {
    assert.isFalse(heldBy(["/opt/Notes"], ["/opt/notes"]));
    assert.isTrue(heldBy(["/opt/Notes"], ["/opt/Notes"]));
    assert.isTrue(heldBy(["C:\\Apps\\Notes.exe"], ["\\\\?\\c:/apps//notes.EXE"]));
    assert.isTrue(heldBy(["com.example.Notes"], ["COM.EXAMPLE.NOTES"]));

    assert.isFalse(coversApps(["/opt/Notes"], ["/opt/notes"]));
    assert.isTrue(coversApps(["/opt/Notes"], ["/opt/Notes"]));
    assert.isTrue(coversApps(["\\\\?\\UNC\\server\\share\\App.exe"], ["//SERVER/share/app.exe"]));
    assert.isTrue(coversApps(undefined, ["/opt/notes"]));
  });
});
