import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@goat/contracts";

import { selectPrepareInput } from "./McpPrepareInput.ts";
import type { ProviderMemoryPrepareInput } from "./ProviderSessionManager.ts";

const threadId = ThreadId.make("prepare-input");
const codex = ProviderInstanceId.make("codex");
const cursor = ProviderInstanceId.make("cursor");
const turn = (
  providerInstanceId: ProviderInstanceId,
  turnCapabilities: ReadonlyArray<"browser" | "computer-use">,
): ProviderMemoryPrepareInput => ({ threadId, providerInstanceId, turnCapabilities });

it("a memory rotation re-prepares the admission stored now, not the copy it read before the lock", () => {
  // The rotation read turn A (codex, @browser); turn B (cursor, no chip) opened before it got the lock.
  const stale = turn(codex, ["browser"]);
  const current = { ...turn(cursor, []), destinationUsable: true };
  assert.strictEqual(selectPrepareInput(stale, "stored", current), current);
  // And the other way: the stored turn asked for the browser, the stale copy did not.
  const asked = { ...turn(codex, ["browser"]), destinationUsable: true };
  assert.strictEqual(selectPrepareInput(turn(codex, []), "stored", asked), asked);
  assert.isUndefined(selectPrepareInput(stale, "stored", undefined));
});

it("an internal re-prepare on the same provider keeps the stored turn's chips", () => {
  const prepared = selectPrepareInput(turn(codex, ["browser"]), true, turn(codex, []));
  assert.deepEqual(prepared?.turnCapabilities, []);
  const kept = selectPrepareInput(
    { threadId, providerInstanceId: codex },
    true,
    turn(codex, ["browser"]),
  );
  assert.deepEqual(kept?.turnCapabilities, ["browser"]);
});

it("an open admits exactly its own turn's chips", () => {
  assert.deepEqual(
    selectPrepareInput(turn(codex, []), false, turn(codex, ["browser"]))?.turnCapabilities,
    [],
  );
  assert.deepEqual(
    selectPrepareInput(turn(codex, []), turn(codex, ["browser"]), turn(codex, ["browser"]))
      ?.turnCapabilities,
    [],
  );
  // A reattach to another provider starts from its own input, without the old provider's chips.
  assert.isUndefined(
    selectPrepareInput({ threadId, providerInstanceId: cursor }, true, turn(codex, ["browser"]))
      ?.turnCapabilities,
  );
});
