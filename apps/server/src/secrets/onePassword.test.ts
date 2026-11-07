import { describe, expect, it, vi } from "vite-plus/test";
import { readOnePassword, runBounded } from "./onePassword.ts";

describe("1Password references", () => {
  it("returns the exact secret without revealing it in an error", async () => {
    const run = vi.fn().mockResolvedValue("  secret\n");
    await expect(readOnePassword("account", "op://vault/item/field", run)).resolves.toBe(
      "  secret\n",
    );
    expect(run).toHaveBeenCalledWith("op", [
      "--cache=false",
      "read",
      "--account=account",
      "--no-newline",
      "op://vault/item/field",
    ]);
  });

  it("rejects invalid account and reference before starting a process", async () => {
    const run = vi.fn();
    await expect(readOnePassword("--help", "op://vault/item/field", run)).rejects.toThrow();
    await expect(
      readOnePassword("account", "op://vault/item/field\n--help", run),
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it("does not include process errors or secret output in its error", async () => {
    const run = vi.fn().mockRejectedValue(new Error("sensitive process output"));
    await expect(readOnePassword("account", "op://vault/item/field", run)).rejects.toThrow(
      "Could not read secret from 1Password",
    );
    try {
      await readOnePassword("account", "op://vault/item/field", run);
    } catch (error) {
      expect(String(error)).not.toContain("sensitive process output");
    }
  });

  it("refuses an empty secret instead of falling back to another credential", async () => {
    await expect(
      readOnePassword("account", "op://vault/item/field", vi.fn().mockResolvedValue(" \n")),
    ).rejects.toThrow("Could not read secret from 1Password");
  });
});

describe("secret provider subprocess", () => {
  it("captures successful output but refuses oversized output", async () => {
    await expect(
      runBounded(process.execPath, ["-e", "process.stdout.write('fixture')"]),
    ).resolves.toBe("fixture");
    await expect(
      runBounded(process.execPath, ["-e", "process.stdout.write('x'.repeat(1048577))"]),
    ).rejects.toThrow("Secret provider process failed");
  });

  it("terminates an unresponsive subprocess on timeout", async () => {
    vi.useFakeTimers();
    try {
      const result = runBounded(process.execPath, ["-e", "process.stdin.resume()"]);
      const rejected = expect(result).rejects.toThrow("Secret provider process failed");
      await vi.advanceTimersByTimeAsync(45_000);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
