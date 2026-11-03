import { describe, expect, it } from "vite-plus/test";
import { toolPriorityLaunch, toolPriorityShellLaunch } from "./toolPriority.ts";

describe("toolPriorityLaunch", () => {
  it("preserves argv while lowering priority through the resolved system nice", () => {
    expect(
      toolPriorityLaunch("/usr/bin/nice", "/path with spaces/tool", ["a b", "'x'", ""]),
    ).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", "10", "/path with spaces/tool", "a b", "'x'", ""],
    });
    expect(toolPriorityLaunch(undefined, "tool", ["a b"])).toEqual({
      command: "tool",
      args: ["a b"],
    });
    expect(toolPriorityLaunch("/usr/bin/nice", "tool", ["x"], false)).toEqual({
      command: "tool",
      args: ["x"],
    });
  });

  it("runs a Unix shell command line through /bin/sh -c like Node's shell option", () => {
    expect(toolPriorityShellLaunch("/usr/bin/nice", "echo $HOME && ls | wc -l")).toEqual({
      command: "/usr/bin/nice",
      args: ["-n", "10", "/bin/sh", "-c", "echo $HOME && ls | wc -l"],
      shell: false,
    });
    expect(toolPriorityShellLaunch(undefined, "dir")).toEqual({
      command: "dir",
      args: [],
      shell: true,
    });
  });
});
