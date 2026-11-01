import { assert, describe, it } from "@effect/vitest";

import {
  frozenSessionPrefix,
  SESSION_CONTEXT_RESERVE_TOKENS,
  SESSION_PREFIX_HEADINGS,
  sessionRotationDue,
} from "./channelBotSessionBrief.ts";

const usage = (fields: Partial<Parameters<typeof sessionRotationDue>[0] & object>) => ({
  usedTokens: 1_000,
  updatedAt: "2026-10-28T00:00:00.000Z",
  ...fields,
});

describe("GOAT Bot session brief", () => {
  it("freezes the six parts in their fixed order, marking empty ones", () => {
    const text = frozenSessionPrefix({
      standing: "Be brief.",
      notes: "",
      journal: "Fixed the login page yesterday.",
      tail: [
        { role: "user", text: "how is the disk" },
        { role: "assistant", text: "Checking it now." },
      ],
      openWork: [{ title: "Rotate logs", status: "running" }],
      message: "why is the disk full?",
    });
    const positions = SESSION_PREFIX_HEADINGS.map((heading) => text.indexOf("## " + heading));
    assert.deepStrictEqual(
      positions,
      positions.toSorted((left, right) => left - right),
    );
    assert.isTrue(positions.every((position) => position >= 0));
    assert.include(text, "## Standing notes\n(none)");
    assert.include(text, "Person: how is the disk\nGOAT Bot: Checking it now.");
    assert.include(text, "- Rotate logs (running)");
    assert.isTrue(text.endsWith("why is the disk full?"));
  });

  it("rotates only on a known expired cache or a full context, never on time alone", () => {
    const now = Date.parse("2026-10-28T12:00:00.000Z");
    assert.isUndefined(sessionRotationDue(undefined, now));
    // Unknown expiry and room left: a day later still reuses the session.
    assert.isUndefined(sessionRotationDue(usage({ maxTokens: 200_000 }), now + 86_400_000));
    assert.strictEqual(
      sessionRotationDue(usage({ promptCacheExpiresAt: "2026-10-28T11:59:00.000Z" }), now),
      "cache_expired",
    );
    assert.isUndefined(
      sessionRotationDue(usage({ promptCacheExpiresAt: "2026-10-28T12:05:00.000Z" }), now),
    );
    const budget = 100_000;
    assert.strictEqual(
      sessionRotationDue(
        usage({
          usedTokens: budget - SESSION_CONTEXT_RESERVE_TOKENS + 1,
          autoCompactThreshold: budget,
        }),
        now,
      ),
      "context_budget",
    );
    assert.isUndefined(
      sessionRotationDue(
        usage({
          usedTokens: budget - SESSION_CONTEXT_RESERVE_TOKENS,
          autoCompactThreshold: budget,
        }),
        now,
      ),
    );
    // No budget reported: never invent one.
    assert.isUndefined(sessionRotationDue(usage({ usedTokens: 10_000_000 }), now));
  });
});
