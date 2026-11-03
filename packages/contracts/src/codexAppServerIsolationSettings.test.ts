import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CODEX_APP_SERVER_ISOLATION_DEFAULT,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);

it("defaults Codex app-server isolation to its constant and keeps it out of project overrides", () => {
  expect(decodeServerSettings({}).codexAppServerIsolation).toBe(CODEX_APP_SERVER_ISOLATION_DEFAULT);
  for (const value of ["thread", "shared"]) {
    expect(decodeServerSettingsPatch({ codexAppServerIsolation: value })).toEqual({
      codexAppServerIsolation: value,
    });
  }
  expect(() => decodeServerSettingsPatch({ codexAppServerIsolation: "process" })).toThrow();
  expect(PROJECT_SCOPED_SERVER_SETTING_KEYS).not.toContain("codexAppServerIsolation");
});
