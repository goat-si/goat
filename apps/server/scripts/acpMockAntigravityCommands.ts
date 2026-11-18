// The commands the mock ACP agent advertises for Antigravity; a fixture command replaces them.
export const antigravityCommands = (command: string | undefined) =>
  command
    ? [{ name: command, description: "Fixture command" }]
    : [
        { name: "plan", description: "Plan a task", input: { hint: "task" } },
        { name: "logout", description: "Sign out" },
      ];
