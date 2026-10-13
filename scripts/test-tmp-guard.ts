// Report goat-* temp entries a CI job left behind, then fail if there are any.
//
//   node scripts/test-tmp-guard.ts <directory>
//
// CI points TMPDIR at a fresh directory per job, so everything in it came from that job.
// Each test file already reports its own leaks; this catches what outlives a file, such as
// the sandbox of a worker that was killed, or a server that kept writing after its test ended.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const LEAK_PREFIX = "goat-";
const SANDBOX_PREFIX = "goat-test-";

const directory = process.argv[2];
if (directory === undefined) {
  process.stderr.write("usage: node scripts/test-tmp-guard.ts <directory>\n");
  process.exit(2);
}

const goatEntries = (path: string) => {
  try {
    return NodeFS.readdirSync(path).filter((name) => name.startsWith(LEAK_PREFIX));
  } catch {
    return [];
  }
};

const leaked: string[] = [];
for (const name of goatEntries(directory)) {
  leaked.push(name);
  if (name.startsWith(SANDBOX_PREFIX)) {
    for (const inner of goatEntries(NodePath.join(directory, name)))
      leaked.push(`${name}/${inner}`);
  }
}

if (leaked.length === 0) {
  process.stdout.write(`No goat-* temp entries left in ${directory}.\n`);
  process.exit(0);
}

// mkdtemp appends six random characters; group by what remains to name the source.
const counts = new Map<string, number>();
for (const name of leaked) {
  const prefix = NodePath.basename(name).replace(/[A-Za-z0-9]{6}$/, "*");
  counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
}
process.stderr.write(`This job left ${leaked.length} goat-* temp entries in ${directory}:\n`);
for (const [prefix, count] of [...counts].toSorted((a, b) => b[1] - a[1])) {
  process.stderr.write(`  ${String(count).padStart(5)}  ${prefix}\n`);
}
for (const name of leaked) process.stderr.write(`  ${name}\n`);
process.exit(1);
