import { createPostgresFixture } from "../src/accounts/test/PostgresFixture.ts";

if (process.argv[2] !== "check")
  throw new Error("Usage: node infra/relay/scripts/test-postgres.ts check");
using fixture = createPostgresFixture();
console.log(fixture.query("SELECT version()"));
console.log("Relay isolated PostgreSQL start/connect/stop prerequisite passed.");
