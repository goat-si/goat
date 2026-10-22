import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  captureMemoryGrantCeiling,
  currentMemoryAccess,
  effectiveMemoryGrant,
  memoryAccessPermit,
} from "./MemoryAccess.ts";
import { MemoryAccessError } from "./MemoryService.ts";

describe("memory authority intersection", () => {
  it("keeps managed defaults distinct from legacy task absence", () => {
    const base = { enableAgentMemoryAccess: true, policyReady: true, readOnly: false };
    expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling: null })).toBe("read_write");
    for (const memoryGrantCeiling of ["none", "read", "read_write"] as const) {
      expect(
        effectiveMemoryGrant({ ...base, memoryGrantCeiling, enableAgentMemoryAccess: false }),
      ).toBe("none");
      expect(effectiveMemoryGrant({ ...base, memoryGrantCeiling, policyReady: false })).toBe(
        "none",
      );
    }
    expect(captureMemoryGrantCeiling(["orchestration:operate"], false)).toBe("none");
    expect(captureMemoryGrantCeiling(["memory:read"], false)).toBe("read");
    expect(captureMemoryGrantCeiling(["memory:read", "memory:write"], false)).toBe("read_write");
    expect(captureMemoryGrantCeiling(["memory:read", "memory:write"], true)).toBe("read");
  });
  it.effect("requires explicit source compound scopes and a repeatable live permit", () =>
    Effect.gen(function* () {
      let active = true;
      let checks = 0;
      const live = Effect.suspend(() => {
        checks++;
        return active ? Effect.void : Effect.fail(new MemoryAccessError({ code: "unavailable" }));
      });
      const permit = memoryAccessPermit(
        {
          readOnly: false,
          grantedScopes: ["memory:read", "orchestration:read"],
          reauthorize: (scopes) => {
            expect(scopes).toEqual(["memory:read", "orchestration:read"]);
            return live;
          },
        },
        "source",
      );
      yield* permit;
      active = false;
      expect((yield* Effect.flip(permit)).message).toBe("Memory access denied.");
      expect(checks).toBe(2);
    }),
  );
  it.effect("blocks an ended live caller before reauthorization on repeated permits", () =>
    Effect.gen(function* () {
      let active = true;
      let reauthorizations = 0;
      const permit = memoryAccessPermit(
        {
          readOnly: false,
          grantedScopes: ["memory:read", "orchestration:read"],
          liveCaller: Effect.suspend(() =>
            active ? Effect.void : Effect.fail(new MemoryAccessError({ code: "unavailable" })),
          ),
          reauthorize: () =>
            Effect.sync(() => {
              reauthorizations++;
            }),
        },
        "source",
      );
      yield* permit;
      expect(reauthorizations).toBe(1);
      active = false;
      expect((yield* Effect.flip(permit)).code).toBe("unavailable");
      expect(reauthorizations).toBe(1);
    }),
  );
  it.effect("denies each missing compound source scope and absent reauthorization", () =>
    Effect.gen(function* () {
      for (const grantedScopes of [["memory:read"], ["orchestration:read"]] as const) {
        let checks = 0;
        const denial = yield* Effect.flip(
          memoryAccessPermit(
            {
              readOnly: false,
              grantedScopes,
              reauthorize: () =>
                Effect.sync(() => {
                  checks++;
                }),
            },
            "source",
          ),
        );
        expect(denial.code).toBe("unavailable");
        expect(checks).toBe(0);
      }
      expect(
        (yield* Effect.flip(
          memoryAccessPermit(
            {
              readOnly: false,
              grantedScopes: ["memory:read", "orchestration:read"],
            },
            "source",
          ),
        )).code,
      ).toBe("unavailable");
    }),
  );
  it.effect("denies writes even with stored grants on a read-only caller", () =>
    Effect.gen(function* () {
      const denial = yield* Effect.flip(
        memoryAccessPermit(
          {
            readOnly: true,
            grantedScopes: ["memory:write"],
            reauthorize: () => Effect.void,
          },
          "write",
        ),
      );
      expect(denial.message).toBe("Memory access denied.");
      yield* memoryAccessPermit(
        { readOnly: false, grantedScopes: ["memory:write"], reauthorize: () => Effect.void },
        "write",
      );
    }),
  );
});

// Expected outcomes describe the policy intersection, independently of the runtime wrapper.
it("explains current permission without widening saved or legacy ceilings", () => {
  const base = { policyReady: true, enableAgentMemoryAccess: true, readOnly: false };
  for (const [input, expected] of [
    [{ memoryGrantCeiling: undefined }, { access: "none", reason: "legacy_none" }],
    [{ memoryGrantCeiling: "none" }, { access: "none", reason: "ceiling" }],
    [{ memoryGrantCeiling: "read" }, { access: "read", reason: "ceiling" }],
    [{ memoryGrantCeiling: "read_write" }, { access: "read_write", reason: "ceiling" }],
    [
      { memoryGrantCeiling: "read_write", readOnly: true },
      { access: "read", reason: "read_only_destination" },
    ],
    [
      { memoryGrantCeiling: "read_write", dispatchScopes: [] },
      { access: "none", reason: "dispatch_scope" },
    ],
    [
      { memoryGrantCeiling: "read_write", dispatchScopes: ["memory:read"] },
      { access: "read", reason: "dispatch_scope" },
    ],
    [
      { memoryGrantCeiling: "read_write", enableAgentMemoryAccess: false },
      { access: "none", reason: "environment_off" },
    ],
    [
      { memoryGrantCeiling: "read_write", policyReady: false },
      { access: "none", reason: "policy_unready" },
    ],
  ] as const) {
    const actual = currentMemoryAccess({ ...base, ...input });
    expect(actual).toEqual(expected);
    expect(effectiveMemoryGrant({ ...base, ...input })).toBe(expected.access);
  }
  for (const memoryGrantCeiling of [undefined, "none", "read", "read_write"] as const) {
    const off = currentMemoryAccess({
      ...base,
      memoryGrantCeiling,
      enableAgentMemoryAccess: false,
    });
    expect(off.access).toBe("none");
    const on = currentMemoryAccess({ ...base, memoryGrantCeiling });
    expect(on.access).toBe(memoryGrantCeiling ?? "none");
  }
});
