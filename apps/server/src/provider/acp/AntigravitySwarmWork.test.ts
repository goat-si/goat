import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { NATIVE_ID } from "./AntigravityChildWork.ts";
import { antigravityProfileRoot } from "./AntigravityProfilePaths.ts";
import { readDiskSwarmMembersByConversationId } from "./AntigravitySwarmWork.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.layer(NodeServices.layer)("readDiskSwarmMembersByConversationId", (it) => {
  it.effect("reads valid non-coordinator members and rejects symlinks or oversized rosters", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profile = yield* fs.makeTempDirectoryScoped({ prefix: "goat-swarm-work-" });
      const profileRoot = yield* Effect.promise(() => antigravityProfileRoot(profile));
      expect(profileRoot).toBeDefined();
      const swarmDir = path.join(
        profile,
        "antigravity-acp",
        "brain",
        "root-1",
        ".system_generated",
        "swarm",
      );
      yield* fs.makeDirectory(swarmDir, { recursive: true });
      const rosterPath = path.join(swarmDir, "members.json");

      const validRoster = encodeUnknownJson({
        members: {
          coordinator: { conversation_id: "root-1", role: "coordinator" },
          worker1: {
            conversation_id: "child-1",
            role: "worker",
            desired_state: "RUNNING",
            phase: "ACTIVE",
          },
          worker2: {
            conversation_id: "child-2",
            role: "worker",
            desired_state: "KILLED",
          },
        },
      });
      yield* fs.writeFileString(rosterPath, validRoster);

      const members = yield* Effect.promise(() =>
        readDiskSwarmMembersByConversationId(profileRoot ?? profile, "root-1", 4096, NATIVE_ID),
      );
      expect(members.has("root-1")).toBe(false);
      expect(members.get("child-1")).toEqual({
        name: "worker1",
        role: "worker",
        killed: false,
        parked: false,
      });
      expect(members.get("child-2")?.killed).toBe(true);

      // Oversized roster fails closed without allocating past the cap.
      const capped = yield* Effect.promise(() =>
        readDiskSwarmMembersByConversationId(
          profileRoot ?? profile,
          "root-1",
          validRoster.length - 1,
          NATIVE_ID,
        ),
      );
      expect(capped.size).toBe(0);

      // Symlinked roster fails closed.
      const outside = path.join(profile, "outside.json");
      yield* fs.writeFileString(outside, validRoster);
      yield* fs.remove(rosterPath);
      yield* fs.symlink(outside, rosterPath);
      const linked = yield* Effect.promise(() =>
        readDiskSwarmMembersByConversationId(profileRoot ?? profile, "root-1", 4096, NATIVE_ID),
      );
      expect(linked.size).toBe(0);
    }),
  );
});
