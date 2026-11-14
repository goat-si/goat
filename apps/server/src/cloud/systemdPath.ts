import * as Schema from "effect/Schema";
import type { BootServicePlan } from "./bootService.ts";

export const systemdUnsafeValue = (plan: BootServicePlan) =>
  /[\x00-\x1f\x7f"'\\]/.test(plan.program[0] ?? "");

export class BootServiceBaseDirUnsupportedError extends Schema.TaggedError<BootServiceBaseDirUnsupportedError>()(
  "BootServiceBaseDirUnsupportedError",
  { baseDir: Schema.String },
) {
  override get message(): string {
    return `systemd cannot run GOAT from ${JSON.stringify(this.baseDir)}: the path contains a quote, backslash or control character. Choose another GOAT home with --base-dir.`;
  }
}
