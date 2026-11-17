import * as Schema from "effect/Schema";

export const HttpsUrl = Schema.String.check(
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === "https:" && url.username.length === 0 && url.password.length === 0) ||
        "ACP Registry URLs must use HTTPS without embedded credentials."
      );
    } catch {
      return "ACP Registry URLs must be valid absolute URLs.";
    }
  }),
);
