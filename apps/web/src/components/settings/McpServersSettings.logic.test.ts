import { describe, expect, it } from "vite-plus/test";
import { draftFor, serverFromDraft, supportedProviders } from "./McpServersSettings.logic";

describe("GOAT MCP settings drafts", () => {
  it("preserves redacted secrets when editing unrelated fields", () => {
    const draft = draftFor("linear", {
      enabled: true,
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "••••••" },
    });
    draft.url = "https://example.com/other";
    expect(serverFromDraft(draft, new Set(["linear"]), "linear")).toEqual({
      name: "linear",
      server: {
        enabled: true,
        transport: "http",
        url: "https://example.com/other",
        headers: { Authorization: "••••••" },
      },
    });
  });
  it("rejects invalid names, duplicate keys and URLs carrying secrets", () => {
    const draft = draftFor();
    expect(serverFromDraft({ ...draft, name: "Bad" }, new Set())).toHaveProperty("error");
    expect(
      serverFromDraft(
        {
          ...draft,
          name: "test",
          command: "node",
          entries: [
            { id: "a", key: "TOKEN", value: "a" },
            { id: "b", key: "TOKEN", value: "b" },
          ],
        },
        new Set(),
      ),
    ).toHaveProperty("error");
    expect(
      serverFromDraft(
        { ...draft, name: "test", transport: "http", url: "https://example.com/?token=secret" },
        new Set(),
      ),
    ).toHaveProperty("error");
  });
  it("shows only providers supporting each transport", () => {
    expect(supportedProviders("http")).toBe("Codex, Claude, Cursor");
    expect(supportedProviders("stdio")).toBe("Codex, Claude, Cursor, ACP agents");
  });
});
