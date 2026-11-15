import type { SDKMessage } from "@cursor/sdk";

type Progress = { assistantText: string; text: string };

const toolProgressLabels = new Map<string, readonly [string, string]>([
  ["run_terminal_cmd", ["Running a command", "Command"]],
  ["shell", ["Running a command", "Command"]],
  ["read_file", ["Reading a file", "File read"]],
  ["read", ["Reading a file", "File read"]],
  ["edit_file", ["Editing a file", "File edit"]],
  ["edit", ["Editing a file", "File edit"]],
  ["apply_patch", ["Editing a file", "File edit"]],
  ["grep", ["Searching the code", "Code search"]],
  ["ripgrep", ["Searching the code", "Code search"]],
  ["glob", ["Finding files", "File search"]],
  ["glob_file_search", ["Finding files", "File search"]],
  ["ls", ["Listing files", "File listing"]],
  ["web_search", ["Searching the web", "Web search"]],
  ["webSearch", ["Searching the web", "Web search"]],
  ["web_fetch", ["Reading a web page", "Web page read"]],
  ["webFetch", ["Reading a web page", "Web page read"]],
  ["task", ["Working on a delegated task", "Delegated task"]],
]);

function progressLine(text: string): string {
  const sentence =
    text
      .trim()
      .replace(/\s+/g, " ")
      .split(/(?<=[.!?])\s+/)
      .at(-1) ?? "";
  if (sentence.length <= 240) return sentence;
  // Reserve one UTF-16 unit for the ellipsis without splitting a surrogate pair.
  const end = (sentence.codePointAt(238) ?? 0) > 0xffff ? 238 : 239;
  return `${sentence.slice(0, end)}…`;
}

export function progressText(previous: Progress, message: SDKMessage): Progress {
  switch (message.type) {
    case "assistant": {
      // SDK 1.0.35 assistant content is a text delta, not a display-status suffix.
      const delta = message.message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");
      if (!delta) return previous;
      const accumulated = previous.assistantText + delta;
      let start = Math.max(0, accumulated.length - 8000);
      // A cut inside a surrogate pair must discard both units to stay within the cap.
      if ((accumulated.codePointAt(start - 1) ?? 0) > 0xffff) start += 1;
      const assistantText = accumulated.slice(start);
      return { assistantText, text: progressLine(assistantText) || previous.text };
    }
    case "thinking":
      return previous;
    case "tool_call": {
      const [running, finished] = toolProgressLabels.get(message.name) ?? ["Using a tool", "Tool"];
      return {
        ...previous,
        // The SDK accumulator starts a new assistant step after a completed tool.
        assistantText: message.status === "running" ? previous.assistantText : "",
        text:
          message.status === "running"
            ? `${running}.`
            : `${finished} ${message.status === "completed" ? "completed" : "failed"}.`,
      };
    }
    case "status": {
      const text = {
        CREATING: "Cursor Cloud is starting.",
        RUNNING: "Cursor Cloud is running.",
        FINISHED: "Cursor Cloud finished.",
        ERROR: "Cursor Cloud reported an error. Open the agent for details.",
        CANCELLED: "Cursor Cloud was cancelled.",
        EXPIRED: "Cursor Cloud expired.",
      }[message.status];
      return { ...previous, text };
    }
    case "task":
      return { ...previous, text: progressLine(message.text ?? "") || previous.text };
    default:
      return previous;
  }
}

export type { Progress };
