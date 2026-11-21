import { describe, expect, it } from "vite-plus/test";
import { azureScopeFromRemote, scopeAzureCliArgs } from "./azureCliScope.ts";

describe("Azure CLI remote scope", () => {
  it("decodes project and repository names while preserving the host family", () => {
    expect(azureScopeFromRemote("git@ssh.dev.azure.com:v3/Org/My%20Project/Repo%20Name")).toEqual({
      organization: "https://dev.azure.com/Org",
      project: "My Project",
      repository: "Repo Name",
    });
    expect(azureScopeFromRemote("git@vs-ssh.visualstudio.com:v3/Org/Project/Repo")).toEqual({
      organization: "https://Org.visualstudio.com",
      project: "Project",
      repository: "Repo",
    });
    expect(
      azureScopeFromRemote("https://scm.example:8443/tfs/Collection/Project/_git/Repo", true),
    ).toEqual({
      organization: "https://scm.example:8443/tfs/Collection",
      project: "Project",
      repository: "Repo",
    });
  });
  it("keeps detection for invalid or unsafe remote paths and preserves explicit flags", () => {
    const args = ["repos", "pr", "list", "--detect", "true"];
    for (const remote of [
      "https://github.com/team/project/_git/repo",
      "https://dev.azure.com/org/p/_git/%40file",
      "https://dev.azure.com/org/p/_git/bad%2Fpath",
      "https://dev.azure.com/org/p/_git/bad%FF",
    ]) {
      expect(scopeAzureCliArgs(args, remote)).toEqual(args);
    }
    const explicit = [...args, "--organization=https://custom.example", "--project=Custom"];
    expect(scopeAzureCliArgs(explicit, "https://dev.azure.com/org/p/_git/repo")).toEqual(explicit);
  });
});
