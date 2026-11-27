import { assert } from "@effect/vitest";

export function assertUtf8Scripts(scripts: ReadonlyArray<string>) {
  assert.isNotEmpty(scripts);
  for (const script of scripts) {
    assert.include(script, "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
  }
}
