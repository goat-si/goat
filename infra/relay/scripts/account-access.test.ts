import { it, expect } from "@effect/vitest";
import { runAccountAccess } from "./account-access.ts";

it("the operator CLI uses HTTPS headers, preserves pending, and never requires database credentials", async () => {
  const requests: { url: string; headers: Headers; body: BodyInit | null | undefined }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    requests.push({ url: String(input), headers: new Headers(init?.headers), body: init?.body });
    return Response.json({ id: "fixture-operation", state: "pending" }, { status: 202 });
  };
  const result = await runAccountAccess(
    ["suspend", "user_fixture", "--key", "fixture-key"],
    { url: "https://relay.example.test", secret: "fixture-operator-secret" },
    fetchImpl,
  );
  expect(result.exitCode).toBe(2);
  expect(requests[0]?.url).toBe(
    "https://relay.example.test/internal/admin/accounts/user_fixture/suspend",
  );
  expect(requests[0]?.headers.get("authorization")).toBe("Bearer fixture-operator-secret");
  expect(requests[0]?.body).toBe("{}");
  expect(JSON.stringify(result)).not.toContain("fixture-operator-secret");
});
it("invalid flags, missing secrets, and insecure URLs fail before any request", async () => {
  let called = false;
  const fetchImpl: typeof fetch = async () => {
    called = true;
    return Response.json({});
  };
  await expect(
    runAccountAccess(
      ["allow", "user_fixture", "--unban"],
      { url: "https://relay.example.test", secret: "fixture-secret" },
      fetchImpl,
    ),
  ).rejects.toThrow("--key");
  await expect(
    runAccountAccess(
      ["show", "user_fixture"],
      { url: "http://relay.example.test", secret: "fixture-secret" },
      fetchImpl,
    ),
  ).rejects.toThrow("HTTPS");
  await expect(
    runAccountAccess(
      ["show", "user_fixture"],
      { url: "https://relay.example.test", secret: undefined },
      fetchImpl,
    ),
  ).rejects.toThrow("trusted environment");
  expect(called).toBe(false);
});
