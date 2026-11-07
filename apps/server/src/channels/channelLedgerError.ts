import * as Schema from "effect/Schema";

export class ChannelLedgerError extends Schema.TaggedError<ChannelLedgerError>()(
  "ChannelLedgerError",
  {
    reason: Schema.Literals([
      "persistence",
      "version_conflict",
      "idempotency_conflict",
      "ownership_lost",
      // A member bot was deleted (or never active) by the time its input was stored.
      "bot_inactive",
    ]),
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Channel ledger " + this.reason + ": " + this.detail;
  }
}
