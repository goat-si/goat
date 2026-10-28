import { describe, expect, it } from "vite-plus/test";

import { signInStage, type SignInPage, type SignInRecord } from "./signInState.ts";

const page = (facts: Partial<SignInPage> = {}): SignInPage => ({
  origin: "https://login.test",
  signIn: true,
  identifier: "filled",
  password: "empty",
  validation: [],
  humanStep: null,
  accountChoices: 0,
  unreadableFrames: 0,
  ...facts,
});
const stage = (facts: Partial<SignInPage>, record: SignInRecord = {}, documentGeneration = 1) =>
  signInStage(page(facts), record, documentGeneration).stage;
const sent: SignInRecord = { submitted: { documentGeneration: 1, at: 1 } };
const answered: SignInRecord = { submitted: { documentGeneration: 1, at: 1, status: 200 } };

describe("the sign-in stage GOAT reports", () => {
  it("never reports success for a password beside an empty identifier", () => {
    expect(stage({ password: "filled", identifier: "empty" })).toBe("partial");
  });

  it("treats a password-only step as applied, not partial", () => {
    expect(stage({ password: "filled", identifier: "absent" })).toBe("fields_applied");
  });

  it("separates an empty form, a filled one and one whose submission is still pending", () => {
    expect(stage({})).toBe("form_present");
    expect(stage({ password: "filled" })).toBe("fields_applied");
    expect(stage({ password: "filled" }, sent)).toBe("submitted");
  });

  it("reports the site's validation error before anything else on the form", () => {
    expect(stage({ password: "filled", validation: ["Wrong password"] }, sent)).toBe(
      "validation_error",
    );
  });

  it("reports a submission the site refused, or an error shown without a form, as a validation error", () => {
    const later = { signIn: false, identifier: "absent", password: "absent" } as const;
    expect(stage(later, { submitted: { documentGeneration: 1, at: 1, status: 401 } }, 2)).toBe(
      "validation_error",
    );
    expect(stage({ ...later, validation: ["Wrong password"] }, sent, 2)).toBe("validation_error");
    // An alert on a page nobody submitted to says nothing about a sign-in.
    expect(stage({ ...later, validation: ["Cookies"] })).toBe("unknown");
  });

  it("keeps a same-document submission whose form went away as submitted, not accepted", () => {
    expect(stage({ signIn: false, identifier: "absent", password: "absent" }, sent)).toBe(
      "submitted",
    );
  });

  it("says site_accepted for a later page without a form, and signed_in only after a person's hand back", () => {
    const later = { signIn: false, identifier: "absent", password: "absent" } as const;
    expect(stage(later, answered, 2)).toBe("site_accepted");
    expect(stage(later, { ...answered, handedBackAt: 0 }, 2)).toBe("site_accepted");
    expect(stage(later, { ...answered, handedBackAt: 2 }, 2)).toBe("signed_in");
    expect(stage(later, { handedBackAt: 2 }, 2)).toBe("unknown");
  });

  it("does not call a later page accepted while the site never answered the submission", () => {
    const later = { signIn: false, identifier: "absent", password: "absent" } as const;
    expect(stage(later, sent, 2)).toBe("unknown");
    expect(stage(later, { ...sent, handedBackAt: 2 }, 2)).toBe("unknown");
  });

  it("never reports success for a password sent beside an empty identifier, after a hand back too", () => {
    const later = { signIn: false, identifier: "absent", password: "absent" } as const;
    const blank = { submitted: { ...answered.submitted!, identifier: "empty" as const } };
    expect(stage(later, blank, 2)).toBe("partial");
    expect(stage(later, { ...blank, handedBackAt: 2 }, 2)).toBe("partial");
  });

  it("puts a refused submission before a CAPTCHA the failure page shows", () => {
    const refused = { submitted: { documentGeneration: 1, at: 1, status: 401 } };
    expect(stage({ humanStep: "captcha", signIn: false }, refused, 2)).toBe("validation_error");
  });

  it("does not call a later page accepted while a frame it could not read may hold the form", () => {
    const later = { signIn: false, identifier: "absent", password: "absent" } as const;
    expect(stage({ ...later, unreadableFrames: 1 }, answered, 2)).toBe("unknown");
  });

  it("hands CAPTCHA and one-time codes to a person and never picks between accounts", () => {
    expect(stage({ humanStep: "captcha" }, sent, 2)).toBe("human_step");
    expect(stage({ humanStep: "mfa", signIn: false }, sent, 2)).toBe("human_step");
    expect(stage({ accountChoices: 2, password: "filled" })).toBe("account_choice");
  });
});
