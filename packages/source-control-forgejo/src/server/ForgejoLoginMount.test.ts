import { assert, it } from "@effect/vitest";
import { matchForgejoLogin, parseForgejoLogins, parseForgejoRemote } from "./ForgejoCli.ts";

const login = (name: string, url: string) => ({
  name,
  url,
  user: "tester",
  default: "false",
  ssh_host: "forgejo.test",
});
const logins = (entries: ReturnType<typeof login>[]) => parseForgejoLogins(JSON.stringify(entries));

it("selects the deepest matching HTTP mount", () => {
  const remote = parseForgejoRemote("https://forgejo.test/team/project.git");
  assert.isNotNull(remote);
  assert.equal(
    matchForgejoLogin(
      logins([
        login("root", "https://forgejo.test"),
        login("mounted", "https://forgejo.test/team"),
      ]),
      remote!,
    )?.name,
    "mounted",
  );
});

it("retains ambiguity for equally deep HTTP mounts and SSH hosts", () => {
  const entries = logins([
    login("one", "https://forgejo.test/team"),
    login("two", "http://forgejo.test/team"),
  ]);
  const http = parseForgejoRemote("https://forgejo.test/team/project.git");
  const ssh = parseForgejoRemote("git@forgejo.test:team/project.git");
  assert.isNotNull(http);
  assert.isNotNull(ssh);
  assert.isUndefined(matchForgejoLogin(entries, http!));
  assert.isUndefined(matchForgejoLogin(entries, ssh!));
});
