import { expect, it, vi } from "vite-plus/test";
import { stripPairingTokenFromUrl, takePairingTokenFromUrl } from "./environments/primary/auth";

it.each(["query", "fragment"] as const)(
  "strips a %s pairing token while preserving router history and preventing back/forward reuse",
  async (placement) => {
    const originalUrl = window.location.href;
    const originalState = window.history.state;
    const token = "synthetic-pairing-token";
    const savedState = { __TSR_index: 42, user: { tab: "settings" } };
    const pop = () =>
      new Promise<void>((resolve) =>
        window.addEventListener("popstate", () => resolve(), { once: true }),
      );
    try {
      window.history.pushState({ __TSR_index: 41, user: { tab: "previous" } }, "", "?previous=1");
      window.history.pushState(
        savedState,
        "",
        `${placement === "query" ? "?" : "#"}token=${token}`,
      );
      expect(takePairingTokenFromUrl()).toBe(token);
      expect(window.history.state).toEqual(savedState);
      expect(window.location.href).not.toContain(token);
      expect(JSON.stringify(window.history.state)).not.toContain(token);
      const back = pop();
      window.history.back();
      await back;
      expect(window.location.href).not.toContain(token);
      const forward = pop();
      window.history.forward();
      await forward;
      expect(window.location.href).not.toContain(token);
      expect(JSON.stringify(window.history.state)).not.toContain(token);
    } finally {
      window.history.replaceState(originalState, "", originalUrl);
    }
  },
);

it("leaves browser history untouched when there is no pairing token", () => {
  const originalUrl = window.location.href;
  const originalState = window.history.state;
  try {
    window.history.replaceState({ __TSR_index: 9, user: "keep" }, "", "?ordinary=1");
    using replace = vi.spyOn(window.history, "replaceState");
    stripPairingTokenFromUrl();
    expect(replace).not.toHaveBeenCalled();
    expect(window.history.state).toEqual({ __TSR_index: 9, user: "keep" });
  } finally {
    window.history.replaceState(originalState, "", originalUrl);
  }
});
