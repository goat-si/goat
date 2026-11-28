// Stand-in executable for exercising actual server process startup and cleanup.
if (process.env.GOAT_TEST_REQUIRE_NONZERO_PORT === "1") {
  const port = process.argv.find((arg) => arg.startsWith("--port="));
  if (!port || Number(port.slice("--port=".length)) <= 0) process.exit(9);
}
process.stdout.write("opencode server listening on http://127.0.0.1:12345\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
