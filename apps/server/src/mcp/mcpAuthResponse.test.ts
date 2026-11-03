import { assert, it } from "@effect/vitest";
import { credentialRefusalMessage } from "./mcpAuthResponse.ts";

it("tells a surviving turn to continue without retrying its stale GOAT tools", () => {
  assert.equal(
    credentialRefusalMessage("earlier_server"),
    "GOAT refused this call: the GOAT server restarted while this turn kept running, so GOAT tools are unavailable for the rest of this turn. Do not retry this tool in this turn; continue without GOAT tools. GOAT installs a fresh credential when the next turn starts.",
  );
});
