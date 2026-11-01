import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { CloudRunRegisterInput, cloudRunUrl, parseCloudRunReference } from "./cloudAgents.ts";

const agent = "bc-1a2b3c4d-5e6f-7a8b-9c0d-112233445566";

describe("parseCloudRunReference", () => {
  it("accepts an id or the provider's own page and rebuilds the link from the id", () => {
    expect(parseCloudRunReference("cursorCloud", { externalId: agent })).toEqual({
      ok: true,
      externalId: agent,
      url: `https://cursor.com/agents/${agent}`,
    });
    expect(
      parseCloudRunReference("cursorCloud", { url: `https://www.cursor.com/agents/${agent}` }),
    ).toMatchObject({ ok: true, url: `https://cursor.com/agents/${agent}` });
    expect(
      parseCloudRunReference("claudeCloud", { url: "https://claude.ai/code/session_ABCdef123" }),
    ).toMatchObject({ ok: true, externalId: "session_ABCdef123" });
    expect(
      parseCloudRunReference("devinCloud", { url: "https://app.devin.ai/sessions/abc123def456" }),
    ).toMatchObject({ ok: true, externalId: "abc123def456" });
  });

  it.each([
    ["http", `http://cursor.com/agents/${agent}`, /https/u],
    ["another origin", `https://cursor.com.evil.test/agents/${agent}`, /cursor\.com/u],
    ["internal address", `https://169.254.169.254/agents/${agent}`, /cursor\.com/u],
    ["user info", `https://me:pw@cursor.com/agents/${agent}`, /user name/u],
    ["a port", `https://cursor.com:8443/agents/${agent}`, /port/u],
    ["a query", `https://cursor.com/agents/${agent}?next=https://evil.test`, /query/u],
    ["another path", `https://cursor.com/settings/${agent}`, /run page/u],
    ["an oversized url", `https://cursor.com/agents/${"a".repeat(2100)}`, /2048/u],
  ])("refuses %s", (_name, url, message) => {
    const result = parseCloudRunReference("cursorCloud", { url });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it("refuses ids in another provider's format, mismatched pairs, and nothing at all", () => {
    expect(parseCloudRunReference("cursorCloud", { externalId: "session_abcdefgh" }).ok).toBe(
      false,
    );
    expect(parseCloudRunReference("claudeCloud", { externalId: agent }).ok).toBe(false);
    expect(parseCloudRunReference("cursorCloud", { externalId: "bc-../../etc" }).ok).toBe(false);
    expect(
      parseCloudRunReference("cursorCloud", {
        externalId: agent,
        url: "https://cursor.com/agents/bc-0000000000000000",
      }),
    ).toMatchObject({ ok: false, message: "externalId and url name different runs." });
    expect(parseCloudRunReference("devinCloud", {})).toMatchObject({ ok: false });
  });

  it("keeps rebuilt links on the provider origin", () => {
    expect(new URL(cloudRunUrl("devinCloud", "abc123def456")).origin).toBe("https://app.devin.ai");
  });
});

describe("CloudRunRegisterInput", () => {
  const decode = Schema.decodeUnknownSync(CloudRunRegisterInput);
  const base = { provider: "cursorCloud", externalId: agent, repo: "goat-si/goat" };
  it("caps launcher names, repositories and branches", () => {
    expect(decode({ ...base, launchedBy: "Grok Bot" }).launchedBy).toBe("Grok Bot");
    expect(() => decode({ ...base, launchedBy: "x".repeat(65) })).toThrow();
    expect(() => decode({ ...base, launchedBy: "Bot\n$(id)" })).toThrow();
    expect(() => decode({ ...base, launchedBy: "Bot", repo: "https://github.com/a/b" })).toThrow();
    expect(() => decode({ ...base, launchedBy: "Bot", branch: "--upload-pack=x" })).toThrow();
    expect(() => decode({ ...base, launchedBy: "Bot", externalId: "b".repeat(161) })).toThrow();
  });
});
