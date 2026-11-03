import { describe, expect, it } from "vite-plus/test";
import { toolPriorityLaunch, toolPriorityShellLaunch } from "./toolPriority.ts";

describe("toolPriorityLaunch", () => {
  it("preserves Unix argv while lowering priority", () => {
    expect(toolPriorityLaunch("darwin", "/path with spaces/tool", ["a b", "'x'", ""])).toEqual({
      command: "nice",
      args: ["-n", "10", "/path with spaces/tool", "a b", "'x'", ""],
    });
    expect(toolPriorityLaunch("linux", "tool", [])).toEqual({
      command: "nice",
      args: ["-n", "10", "tool"],
    });
    expect(toolPriorityLaunch("win32", "tool", ["a b"])).toEqual({
      command: "tool",
      args: ["a b"],
    });
  });

  it("runs a Unix shell command line through /bin/sh -c like Node's shell option", () => {
    expect(toolPriorityShellLaunch("linux", "echo $HOME && ls | wc -l")).toEqual({
      command: "nice",
      args: ["-n", "10", "/bin/sh", "-c", "echo $HOME && ls | wc -l"],
      shell: false,
    });
    expect(toolPriorityShellLaunch("win32", "dir")).toEqual({
      command: "dir",
      args: [],
      shell: true,
    });
  });
});
