import { assert, it } from "@effect/vitest";
import { credentialRefusalMessage } from "./mcpAuthResponse.ts";

it("tells a caller with a credential from an earlier server run not to retry in this turn", () => {
  assert.equal(
    credentialRefusalMessage("earlier_server"),
    "GOAT refused this call: this GOAT tool credential is from before the GOAT server restarted or updated, so GOAT tools are unavailable for the rest of this turn. Do not retry this tool in this turn; GOAT installs a fresh credential when a later turn starts.",
  );
});
