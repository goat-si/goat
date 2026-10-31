import { describe, expect, it } from "vite-plus/test";
import * as Authority from "./ComputerUseClaimBindAuthority.ts";

const pending = [{ claimId: "claim:1", pid: 42, windowId: 7, origin: "https://example.test" }];
const state = { pid: 42, window_id: 7, mode: "bind", origin_scope: ["https://example.test"] };

describe("claimBind authority", () => {
  it("admits only host bind mode for the exact approved pending window and origin", () => {
    expect(Authority.authorizeClaimBind("claimBind", "get_browser_state", state, pending)).toEqual(
      pending[0],
    );
    expect(
      Authority.authorizeClaimBind(
        undefined,
        "get_browser_state",
        { ...state, authority: "claimBind" },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind("claimBind", "get_browser_state", state, []),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind(
        "claimBind",
        "get_browser_state",
        { ...state, window_id: 8 },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind(
        "claimBind",
        "get_browser_state",
        { ...state, origin_scope: ["https://other.test"] },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind(
        "claimBind",
        "get_browser_state",
        { ...state, mode: "snapshot" },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind("claimBind", "browser_click", state, pending),
    ).toBeUndefined();
  });
  it("allows only an existing-profile background prepare for the pending window", () => {
    const prepare = { pid: 42, window_id: 7, strategy: { kind: "existing_profile" } };
    expect(Authority.authorizeClaimBind("claimBind", "browser_prepare", prepare, pending)).toEqual(
      pending[0],
    );
    expect(
      Authority.authorizeClaimBind(
        "claimBind",
        "browser_prepare",
        { ...prepare, delivery_mode: "foreground" },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind(
        "claimBind",
        "browser_prepare",
        { ...prepare, strategy: { kind: "new_profile" } },
        pending,
      ),
    ).toBeUndefined();
    expect(
      Authority.authorizeClaimBind(undefined, "browser_prepare", prepare, pending),
    ).toBeUndefined();
  });
});
