import { DEFAULT_SERVER_SETTINGS } from "@goat/contracts";
import { it, expect } from "vite-plus/test";
import { applyServerSettingsPatch } from "./serverSettings.ts";

it("keeps a source control host's saved tokens when a patch sets another host's token", () => {
  const reference = { provider: "vault", reference: "github/token" };
  const saved = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
    sourceControlHosts: { github: { tokens: { "github.com": reference } } },
  });
  const patched = applyServerSettingsPatch(saved, {
    sourceControlHosts: { github: { tokens: { "ghe.example": "x" } } },
  });
  expect(patched.sourceControlHosts.github?.tokens).toEqual({
    "github.com": reference,
    "ghe.example": "x",
  });
  const recased = applyServerSettingsPatch(saved, {
    sourceControlHosts: { github: { tokens: { " GitHub.com ": "ghp_new" } } },
  });
  expect(recased.sourceControlHosts.github?.tokens).toEqual({ "github.com": "ghp_new" });
  const cleared = applyServerSettingsPatch(saved, {
    sourceControlHosts: { github: { tokens: {} } },
  });
  expect(cleared.sourceControlHosts.github?.tokens).toEqual({});
  const replaced = applyServerSettingsPatch(saved, {
    sourceControlHosts: { github: { tokens: reference } },
  });
  expect(replaced.sourceControlHosts.github?.tokens).toEqual(reference);
});
