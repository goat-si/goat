// Compare tunnel test inventory in a vitest JSON report against the baseline name list.
// Usage: node inventory.mjs <report.json> [baseline.txt] [expected-file-count]
import * as NodeFS from "node:fs";
const [report, baselinePath = "/tmp/goat-ci/baseline-names.txt", expectedFiles] =
  process.argv.slice(2);
const j = JSON.parse(NodeFS.readFileSync(report, "utf8"));
const target = /\/tunnel(\.(core|runner-switch|protocol-[a-z]+))?\.test\.ts$/;
const files = j.testResults.filter((f) => target.test(f.name));
const tests = files.flatMap((f) => f.assertionResults.map((a) => ({ ...a, file: f.name })));
const names = tests.map((t) => t.fullName).sort();
const baseline = NodeFS.readFileSync(baselinePath, "utf8").trim().split("\n").sort();
const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
const a = count(names),
  b = count(baseline);
const missing = [...b].filter(([k, v]) => (a.get(k) ?? 0) < v).map(([k]) => k);
const extra = [...a].filter(([k, v]) => (b.get(k) ?? 0) < v).map(([k]) => k);
const byStatus = count(tests.map((t) => t.status));
const perFile = files.map((f) => {
  const d = f.assertionResults.reduce((s, x) => s + (x.duration ?? 0), 0);
  return (
    f.name.split("/").pop() +
    " n=" +
    f.assertionResults.length +
    " sum=" +
    (d / 1000).toFixed(1) +
    "s wall=" +
    ((f.endTime - f.startTime) / 1000).toFixed(1) +
    "s"
  );
});
console.log(
  JSON.stringify(
    {
      files: files.length,
      tests: names.length,
      baseline: baseline.length,
      status: Object.fromEntries(byStatus),
      missing,
      extra,
    },
    null,
    1,
  ),
);
console.log(perFile.join("\n"));
const filesOk = expectedFiles === undefined || files.length === Number(expectedFiles);
if (!filesOk) console.log("expected " + expectedFiles + " files, got " + files.length);
const ok =
  filesOk &&
  missing.length === 0 &&
  extra.length === 0 &&
  names.length === baseline.length &&
  (byStatus.get("passed") ?? 0) === names.length;
console.log(ok ? "INVENTORY_OK" : "INVENTORY_MISMATCH");
process.exit(ok ? 0 : 1);
