import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@goat/contracts";
import * as Schema from "effect/Schema";
import * as AgentSessionScanner from "./AgentSessionTranscriptParser.ts";

const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function makeRecordLimitTranscript(cwd: string, overflow: boolean): string {
  const records =
    [
      encodeTranscriptRecord({
        type: "session_meta",
        payload: { id: "record-limit-session", cwd },
      }),
      encodeTranscriptRecord({
        type: "event_msg",
        payload: { type: "user_message", message: "First prompt" },
      }),
    ].join("\n") +
    "\n" +
    "{}\n".repeat(99_998);
  return overflow
    ? records +
        "\n" +
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Overflow prompt" },
        }) +
        "\n"
    : records;
}

describe("parseAgentSessionTranscript", () => {
  it.each([false, true])(
    "handles the exact record limit and an interior blank overflow=%s",
    (overflow) => {
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        contents: makeRecordLimitTranscript("/project", overflow),
        source: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        fallbackSessionId: "unused",
        lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      });
      if (overflow) expect(thread).toBeNull();
      else expect(thread?.messages.map((message) => message.text)).toEqual(["First prompt"]);
    },
  );

  it.each([199, 200, 201, 205])(
    "counts only omitted conversation messages for a %s-message Claude transcript",
    (count) => {
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        contents: [
          ...Array.from({ length: count }, (_, index) =>
            encodeTranscriptRecord({
              type: index === 0 ? "user" : "assistant",
              sessionId: "claude-session",
              message: { content: `Message ${index}` },
            }),
          ),
          encodeTranscriptRecord({ type: "user", isMeta: true, message: { content: "Setup" } }),
          encodeTranscriptRecord({
            type: "user",
            isCompactSummary: true,
            message: { content: "Summary" },
          }),
          encodeTranscriptRecord({
            type: "assistant",
            isSidechain: true,
            message: { content: "Sidechain" },
          }),
          encodeTranscriptRecord({
            type: "assistant",
            message: { content: [{ type: "tool_use" }] },
          }),
          "malformed",
        ].join("\n"),
        source: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        fallbackSessionId: "fallback",
        lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      });

      expect(thread?.omittedMessageCount).toBe(Math.max(0, count - 200));
      expect(thread?.messages).toHaveLength(Math.min(200, count));
      expect(thread?.messages[0]?.text).toBe("Message 0");
      expect(thread?.messages.at(-1)?.text).toBe(`Message ${count - 1}`);
    },
  );

  it("keeps Claude text and titles while dropping malformed and tool records", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        "not valid json",
        JSON.stringify({ type: "ai-title", aiTitle: "Fix authentication" }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          isMeta: true,
          message: { role: "user", content: "Injected skill instructions" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          isCompactSummary: true,
          message: { role: "user", content: "Injected compaction summary" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          timestamp: "2026-08-24T10:00:00.000Z",
          message: { role: "user", content: [{ type: "text", text: "Fix authentication" }] },
        }),
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          message: { role: "user", content: [{ type: "tool_result", text: "hidden" }] },
        }),
        ...[
          "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the login flow</command-args>",
          "<local-command-stdout>Enabled plan mode</local-command-stdout>",
          "<bash-input>npm test</bash-input>",
          "<bash-stdout>1 passed</bash-stdout><bash-stderr></bash-stderr>",
          "<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>",
          "[Request interrupted by user for tool use]",
        ].map((content) =>
          JSON.stringify({
            type: "user",
            sessionId: "claude-session",
            message: { role: "user", content },
          }),
        ),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "claude-sonnet-5",
            content: [{ type: "text", text: "Updated the login flow" }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: "claude-session",
          message: {
            role: "assistant",
            model: "<synthetic>",
            content: [{ type: "text", text: "The provider request failed" }],
          },
        }),
      ].join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toMatchObject({
      providerSessionId: "claude-session",
      title: "Fix authentication",
      model: "claude-sonnet-5",
      messages: [
        { role: "user", text: "Fix authentication" },
        { role: "user", text: "/review the login flow" },
        { role: "user", text: "!npm test" },
        { role: "assistant", text: "Updated the login flow" },
        { role: "assistant", text: "The provider request failed" },
      ],
    });
  });

  it.each([
    { customTitles: ["Refactor auth module"], expected: "Refactor auth module" },
    // Claude writes an empty customTitle when the user clears a rename.
    { customTitles: ["Refactor auth module", ""], expected: "Generated title" },
    // Some launchers rename the session to the raw markup of its opening command.
    {
      customTitles: ["<command-message>pstack:poteto-mode</command-message>"],
      expected: "Generated title",
    },
    {
      customTitles: ["<local-command-stdout>Enabled plan mode</local-command-stdout>"],
      expected: "Generated title",
    },
    { customTitles: ["<bash-input>npm test</bash-input>"], expected: "Generated title" },
  ])("uses Claude custom titles $customTitles over the AI title", ({ customTitles, expected }) => {
    const aiTitle = JSON.stringify({
      type: "ai-title",
      aiTitle: "Generated title",
      sessionId: "claude-session",
    });
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        JSON.stringify({
          type: "user",
          sessionId: "claude-session",
          timestamp: "2026-08-24T10:00:00.000Z",
          message: { role: "user", content: "Tighten the session checks" },
        }),
        // Claude rewrites both records on every metadata flush with ai-title
        // last, so a later ai-title must not override the user's rename.
        ...customTitles.flatMap((customTitle) => [
          JSON.stringify({ type: "custom-title", customTitle, sessionId: "claude-session" }),
          aiTitle,
        ]),
      ].join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.title).toBe(expected);
  });

  it.each([
    {
      first:
        "<command-name>/pstack:arena</command-name><command-args>Compare designs</command-args>",
      title: "Compare designs",
    },
    {
      first: "<command-name>/clear</command-name><command-message>clear</command-message>",
      title: "Plan the release",
    },
    { first: "/Users/me/app fails to build", title: "/Users/me/app fails to build" },
  ])("titles a Claude thread after its request, not command markup: $title", ({ first, title }) => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [first, "Plan the release"]
        .map((content) =>
          JSON.stringify({ type: "user", sessionId: "claude-session", message: { content } }),
        )
        .join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.title).toBe(title);
  });

  it.each([199, 200])("keeps the canonical first prompt with %s later Codex messages", (count) => {
    const canonicalPrompt = "\n  Keep the canonical prompt  \n";
    const canonicalTimestamp = "2026-08-24T10:01:00.000Z";
    const laterAssistantMessages = Array.from({ length: count }, (_, index) =>
      encodeTranscriptRecord({
        type: "response_item",
        timestamp: `2026-08-24T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Assistant message ${index}` }],
        },
      }),
    );
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Keep the canonical prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: canonicalTimestamp,
          payload: { type: "user_message", message: canonicalPrompt },
        }),
        ...laterAssistantMessages,
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.omittedMessageCount).toBe(count - 199);
    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]).toMatchObject({
      role: "user",
      text: canonicalPrompt,
      createdAt: canonicalTimestamp,
    });
  });

  it("restores the canonical first prompt when a later user message remains", () => {
    const canonicalPrompt = "\n  Keep the canonical prompt  \n";
    const canonicalTimestamp = "2026-08-24T10:01:00.000Z";
    const assistantMessages = Array.from({ length: 198 }, (_, index) =>
      encodeTranscriptRecord({
        type: "response_item",
        timestamp: `2026-08-24T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Assistant message ${index}` }],
        },
      }),
    );
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T10:00:00.000Z",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [{ type: "input_text", text: "Keep the canonical prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: canonicalTimestamp,
          payload: { type: "user_message", message: canonicalPrompt },
        }),
        ...assistantMessages,
        encodeTranscriptRecord({
          type: "event_msg",
          timestamp: "2026-08-24T11:58:30.000Z",
          payload: { type: "user_message", message: "Keep this later prompt" },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          timestamp: "2026-08-24T11:59:00.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Keep this latest response" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.omittedMessageCount).toBe(1);
    expect(thread?.messages).toHaveLength(200);
    expect(thread?.messages[0]).toMatchObject({
      role: "user",
      text: canonicalPrompt,
      createdAt: canonicalTimestamp,
    });
    expect(
      thread?.messages.filter((message) => message.text.trim() === canonicalPrompt.trim()),
    ).toHaveLength(1);
    expect(thread?.messages.some((message) => message.text === "Keep this later prompt")).toBe(
      true,
    );
    expect(thread?.messages.at(-1)?.text).toBe("Keep this latest response");
  });

  it("keeps mixed-format response users when turn IDs repeat after an assistant", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-older" },
            content: [{ type: "input_text", text: "Keep this older prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Keep this newer prompt" },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-newer" },
            content: [{ type: "input_text", text: "Keep this newer prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Ask again when needed" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-newer" },
            content: [{ type: "input_text", text: "Keep this newer prompt" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Keep this older prompt",
      "Keep this newer prompt",
      "Ask again when needed",
      "Keep this newer prompt",
    ]);
  });

  it("preserves response user text when Codex turn metadata is ambiguous", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: ["unexpected"],
            content: [{ type: "input_text", text: "Keep this legacy prompt" }],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "   " },
            content: [{ type: "input_text", text: "Keep this prompt with a blank turn ID" }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Keep this legacy prompt",
      "Keep this prompt with a blank turn ID",
    ]);
  });

  it("uses the first valid Codex session ID when a fork copies ancestor metadata", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({
          type: "session_meta",
          payload: { id: "fork-session", forked_from_id: "parent-session" },
        }),
        encodeTranscriptRecord({
          type: "session_meta",
          payload: { id: "parent-session" },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: { type: "user_message", message: "Continue in the fork" },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread?.providerSessionId).toBe("fork-session");
  });

  it("skips Codex transcripts without a resumable session ID", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: encodeTranscriptRecord({
        type: "event_msg",
        payload: { type: "user_message", message: "This transcript has no session metadata" },
      }),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "rollout-2026-08-24T12-00-00-not-a-session-id",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toBeNull();
  });

  it("uses the canonical Codex event when its turn has generated response context", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "<environment_context>\n<cwd>/tmp/project</cwd>\n<shell>zsh</shell>\n</environment_context>",
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nPrivate project rules\n</INSTRUCTIONS>",
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Do something here so it looks like a real project.",
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
            content: [
              {
                type: "input_text",
                text: "Do something here so it looks like a real project.",
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Created the project." }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Do something here so it looks like a real project.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Do something here so it looks like a real project.",
      "Created the project.",
    ]);
  });

  it("preserves context markup in response-only Codex messages", () => {
    const context = "<environment_context>\n<cwd>/tmp/project</cwd>\n</environment_context>";
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: [
        encodeTranscriptRecord({ type: "session_meta", payload: { id: "codex-session" } }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: context,
              },
            ],
          },
        }),
        encodeTranscriptRecord({
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Initialize Git and add a README." }],
          },
        }),
      ].join("\n"),
      source: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      fallbackSessionId: "fallback",
      lastActiveAtMs: Date.parse("2026-08-25T08:00:00.000Z"),
    });

    expect(thread?.title).toBe("Initialize Git and add a README.");
    expect(thread?.messages.map((message) => message.text)).toEqual([
      context,
      "Initialize Git and add a README.",
    ]);
  });

  it.each([
    { command: "/clear", reply: undefined, expected: null },
    { command: "/review", reply: "Found two issues", expected: "/review" },
  ])("handles a bare Claude command and its reply: $command", ({ command, reply, expected }) => {
    const records = [
      { type: "user", message: { content: `<command-name>${command}</command-name>` } },
      ...(reply ? [{ type: "assistant", message: { content: reply } }] : []),
    ];
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: records.map((record) => JSON.stringify(record)).join("\n"),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "claude-session",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });
    expect(thread?.title ?? null).toBe(expected);
  });

  it.each([false, true])(
    "retains a Claude error only when a model also answered: %s",
    (modelAnswered) => {
      const records = [
        { type: "user", message: { role: "user", content: "plugin" } },
        ...(modelAnswered
          ? [
              {
                type: "assistant",
                message: {
                  role: "assistant",
                  model: "claude-sonnet-4-5",
                  content: "Which plugin?",
                },
              },
            ]
          : []),
        {
          type: "assistant",
          message: { role: "assistant", model: "<synthetic>", content: "Invalid API key" },
        },
      ];
      const thread = AgentSessionScanner.parseAgentSessionTranscript({
        contents: records.map((record) => JSON.stringify(record)).join("\n"),
        source: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        fallbackSessionId: "claude-session",
        lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
      });
      expect(thread?.messages.map((message) => message.text) ?? null).toEqual(
        modelAnswered ? ["plugin", "Which plugin?", "Invalid API key"] : null,
      );
    },
  );

  it("skips sessions without a visible user message", () => {
    const thread = AgentSessionScanner.parseAgentSessionTranscript({
      contents: JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Done" },
      }),
      source: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      fallbackSessionId: "claude-session",
      lastActiveAtMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(thread).toBeNull();
  });
});
