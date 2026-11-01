import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { isExhausted } from "./channelPlacement.ts";
import { decodeHostQuotas, remoteQuotaFields } from "./remoteQuotaCandidates.ts";

const NOW = Date.parse("2026-10-20T00:00:00.000Z");
const LATER = "2026-10-20T05:00:00.000Z";

const status = (limits: Record<string, unknown>) => ({
  hosts: [
    {
      metrics: {
        quotas: [
          {
            instanceId: "codex",
            limits: { checkedAt: "2026-10-19T23:59:00.000Z", windows: [], ...limits },
          },
        ],
      },
    },
  ],
});

describe("remote quota candidates", () => {
  it.effect("keeps a projected pool's verdicts when the host sends no raw pool", () =>
    Effect.gen(function* () {
      const open = yield* decodeHostQuotas(
        status({
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
              exhausted: false,
              resetsAt: LATER,
            },
          ],
        }),
      );
      const openFields = remoteQuotaFields(open, "codex");
      assert.isFalse(
        isExhausted(
          {
            value: null,
            host: "studio",
            providerLabel: "Codex",
            preferred: false,
            activeTasks: 0,
            ...openFields,
          },
          NOW,
        ),
      );
      const blocked = yield* decodeHostQuotas(
        status({
          availability: [
            { id: "availability", label: "Availability", exhausted: true, resetsAt: LATER },
          ],
        }),
      );
      const blockedFields = remoteQuotaFields(blocked, "codex");
      assert.isTrue(
        isExhausted(
          {
            value: null,
            host: "studio",
            providerLabel: "Codex",
            preferred: false,
            activeTasks: 0,
            ...blockedFields,
          },
          NOW,
        ),
      );
      assert.strictEqual(blockedFields.checkedAt, "2026-10-19T23:59:00.000Z");
      assert.isUndefined(blockedFields.quotaPool);
      assert.deepStrictEqual(remoteQuotaFields(undefined, "codex"), {
        windows: null,
        checkedAt: undefined,
        quotaPool: undefined,
      });
    }),
  );
});
