// @effect-diagnostics globalConsole:off globalFetch:off preferSchemaOverJson:off -- Standalone operator HTTP CLI; secrets stay in headers and failures print only bounded messages.
export async function runAccountAccess(
  argv: ReadonlyArray<string>,
  environment: { readonly url: string | undefined; readonly secret: string | undefined },
  fetchImpl: typeof fetch,
) {
  if (!environment.url || !environment.secret || /\s/u.test(environment.secret))
    throw new Error("Set RELAY_OPERATOR_URL and RELAY_OPERATOR_SECRET in the trusted environment.");
  let url: URL;
  try {
    url = new URL(environment.url);
  } catch {
    throw new Error("RELAY_OPERATOR_URL must be a valid HTTPS origin.");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new Error("RELAY_OPERATOR_URL must be an HTTPS origin without embedded credentials.");
  const [command, value, ...flags] = argv;
  if (
    !value ||
    !command ||
    !["show", "suspend", "allow", "delete", "operation", "resume"].includes(command)
  )
    throw new Error(
      "Usage: accounts:access show|suspend|allow|delete <user> [--key <id>] or operation|resume <id>",
    );
  const mutation = command === "suspend" || command === "allow" || command === "delete";
  const key = flags[0] === "--key" ? flags[1] : undefined;
  if (
    (mutation && (!key || flags.length !== 2 || !/^[A-Za-z0-9_-]{1,255}$/u.test(key))) ||
    (!mutation && flags.length)
  )
    throw new Error("Mutations require --key <id>; no other flags are accepted.");
  url.pathname =
    command === "operation" || command === "resume"
      ? `/internal/admin/account-operations/${encodeURIComponent(value)}${command === "resume" ? "/resume" : ""}`
      : `/internal/admin/accounts/${encodeURIComponent(value)}${mutation ? `/${command}` : ""}`;
  url.search = "";
  url.hash = "";
  try {
    const response = await fetchImpl(url, {
      method: mutation || command === "resume" ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${environment.secret}`,
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      ...(mutation ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await response.json();
    return { body, exitCode: !response.ok ? 1 : response.status === 202 ? 2 : 0 };
  } catch (cause) {
    throw new Error("Could not read a relay operator response.", { cause });
  }
}

if (import.meta.main) {
  try {
    const result = await runAccountAccess(
      process.argv.slice(2),
      { url: process.env.RELAY_OPERATOR_URL, secret: process.env.RELAY_OPERATOR_SECRET },
      globalThis.fetch,
    );
    console.log(JSON.stringify(result.body, null, 2));
    process.exitCode = result.exitCode;
    if (result.exitCode === 2)
      console.log("Accepted; relay cleanup is pending. Use operation <id> or resume <id>.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Operator request failed.");
    process.exitCode = 1;
  }
}
