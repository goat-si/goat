import type { RunResult } from "@cursor/sdk";
import { RunId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resultTask } from "./adapter.ts";

const task = {
  taskId: "run-fixture",
  acceptedAppRunId: RunId.make("app-run-fixture"),
  source: { repository: "https://github.com/fixture/repo", branch: "feature", sha: "a".repeat(40) },
  localChangesExcluded: true,
  status: "running" as const,
  tracking: "live" as const,
  updatedAt: "2026-10-25T00:00:00.000Z",
};
const failed = (error?: RunResult["error"]): RunResult => ({
  id: "run-fixture",
  status: "error",
  ...(error === undefined ? {} : { error }),
});
const BILLING =
  "Cursor stopped this run because of your Cursor account's usage or billing. Check your Cursor plan, then send the message again.";
const ACCESS =
  "Cursor stopped this run because it refused sign-in or access. Sign in to Cursor again and check repository access, then send the message again.";
const UNEXPECTED = "Cursor's agent hit an unexpected error before it finished.";

describe("Cursor Cloud failed run", () => {
  it.each([
    ["You have no usage credits left.", BILLING],
    ["Authentication: insufficient credits", BILLING],
    ["Your team hit its spend limit; upgrade to continue.", BILLING],
    ["Your team reached its monthly usage limit.", BILLING],
    ["Authentication: required", ACCESS],
    ["Permission denied for repository fixture/repo", ACCESS],
    // Supported phrases still count when they end a sentence.
    ["Insufficient credits.", BILLING],
    ["Usage quota exceeded.", BILLING],
    ["Authentication required.", ACCESS],
    ["Unauthorized.", ACCESS],
    ["No access to this repository.", ACCESS],
    ["The agent stopped because of an unexpected error.", UNEXPECTED],
    // Transport failures that only share a word with account problems.
    ["WebSocket upgrade failed: 502 Bad Gateway", UNEXPECTED],
    ["Could not access the repository host: ETIMEDOUT", UNEXPECTED],
    // Keywords inside repository names are not account problems.
    ["payment-service.git: ETIMEDOUT", UNEXPECTED],
    ["credit.git: ECONNRESET", UNEXPECTED],
    ["forbidden.git: ETIMEDOUT", UNEXPECTED],
    ["Cloning forbidden..git: ETIMEDOUT", UNEXPECTED],
    ["ENOENT: no such file or directory, open 'authentication/failed'", UNEXPECTED],
    ["Cloning authentication-failed: ECONNRESET", UNEXPECTED],
    // Technical failures that use account words for something else keep the general sentence.
    ["remote: 403 Forbidden while cloning payment-service.git", UNEXPECTED],
    ["ERR_CRYPTO_INVALID_KEYLEN: Invalid key length", UNEXPECTED],
    ["Container setup failed: disk quota exceeded", UNEXPECTED],
    ["Container terminated: memory usage limit exceeded", UNEXPECTED],
    ["Container setup failed: disk usage limit exceeded", UNEXPECTED],
    ["EACCES: permission denied, open '/workspace/file'", UNEXPECTED],
    ["npm ERR! 403 Forbidden - GET https://registry.npmjs.org/fixture", UNEXPECTED],
    ["Quota exceeded.", UNEXPECTED],
    ["No access.", UNEXPECTED],
    ["   ", UNEXPECTED],
  ])("says what to fix for %j", (message, expected) => {
    expect(resultTask(task, failed({ message })).error).toBe(expected);
  });
  it("keeps the general sentence when Cursor gave no reason", () => {
    expect(resultTask(task, failed()).error).toBe(UNEXPECTED);
  });
  // The reason is classified, never shown, so nothing in it reaches the card.
  it.each([
    'Upload failed for https://user:hunter2@example.invalid/repo.git {"token":"fixture-short"}',
    'Authentication failed: api_key="fixture short secret" password="fixture;tailsecret"',
    "Authorization: Basic Zm9vOmJhcg== was rejected",
  ])("shows none of Cursor's text (%#)", (message) => {
    const error = resultTask(task, failed({ message })).error;
    for (const fragment of ["hunter2", "fixture-short", "short secret", "tailsecret", "Zm9vOmJhcg"])
      expect(error).not.toContain(fragment);
  });
  it("classifies a long reason without slow matching", () => {
    expect(resultTask(task, failed({ message: "token-".repeat(20_000) })).error).toBe(UNEXPECTED);
  });
});
