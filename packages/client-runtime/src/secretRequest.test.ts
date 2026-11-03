import { SecretRequestError } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("names the origin where GOAT types the password while the agent gets only a reference", () => {
    expect(secretRequestPrivacyNote({ siteOrigin: "https://example.com" })).toBe(
      "The agent gets only a reference. GOAT types it into a password field on https://example.com",
    );
  });

  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});

it("requires both login fields and builds a private login answer", () => {
  const item = { id: "turn-item:login", threadId: "thread:login" } as never;
  expect(
    secretRequestAnswerInput(item, { type: "save_login", username: " ", password: "password" }),
  ).toBeNull();
  expect(
    secretRequestAnswerInput(item, { type: "save_login", username: "user", password: " " }),
  ).toBeNull();
  expect(
    secretRequestAnswerInput(item, {
      type: "save_login",
      username: " user ",
      password: " password ",
    }),
  ).toEqual({
    threadId: "thread:login",
    turnItemId: "turn-item:login",
    answer: { type: "save_login", username: "user", password: " password " },
  });
});

it("explains that the agent receives only a reference to the site-bound login", () => {
  expect(
    secretRequestPrivacyNote({ requestKind: "login", siteOrigin: "https://example.com" }),
  ).toBe("The agent gets only a reference. GOAT fills this login on https://example.com");
});

it("validates and normalizes a card answer without altering name or CVC", () => {
  const item = { id: "item:card", threadId: "thread:card" } as never;
  const answer = {
    type: "save_card" as const,
    number: "4242 4242-4242 4242",
    expiryMonth: "01",
    expiryYear: "29",
    cvc: "003",
    name: "  Name  ",
  };
  expect(secretRequestAnswerInput(item, { ...answer, cvc: "12" })).toBeNull();
  expect(secretRequestAnswerInput(item, { ...answer, number: "123" })).toBeNull();
  expect(secretRequestAnswerInput(item, answer)).toEqual({
    threadId: "thread:card",
    turnItemId: "item:card",
    answer: { ...answer, number: "4242424242424242", expiryYear: "2029" },
  });
});
