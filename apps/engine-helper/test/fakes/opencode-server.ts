// Stand-in executable for exercising actual server process startup and cleanup.
process.stdout.write("opencode server listening on http://127.0.0.1:12345\n");
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
