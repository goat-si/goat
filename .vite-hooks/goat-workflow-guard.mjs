import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const [sha, ref] = NodeProcess.argv.slice(2);
const workflowPath = ".github/workflows/goat-ci.yml";
const nightlyPath = ".github/workflows/goat-nightly.yml";
const disabled = new Set((NodeProcess.env.GOAT_DISABLED_WORKFLOWS ?? "").split("\n"));
const labels = new Set(["self-hosted", "linux", "x64", "goat", "epyc"]);
const actions = new Set([
  "actions/checkout@v6",
  "voidzero-dev/setup-vp@v1",
  "actions/upload-artifact@v4",
]);
// goat-nightly.yml signs on the Mac Studio and publishes with the goat-releases App,
// so it may only run after a successful dev push of goat-ci, never from a pull request.
const nightlyActions = new Set([
  ...actions,
  "actions/download-artifact@v4",
  "actions/create-github-app-token@v2",
  "dtolnay/rust-toolchain@stable",
]);
const hostedRunners = new Set([
  "ubuntu-24.04",
  "ubuntu-24.04-arm",
  "windows-2025",
  "windows-11-arm",
]);
const selfHostedRunners = [
  ["self-hosted", "linux", "x64", "goat", "epyc"],
  ["self-hosted", "macos", "arm64", "goat", "mac-studio"],
];
const prepareGate =
  "github.repository == 'goat-si/goat' && (github.event_name == 'workflow_dispatch' || (github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push' && github.event.workflow_run.head_branch == 'dev' && github.event.workflow_run.head_repository.full_name == 'goat-si/goat'))";
const downstreamGate = "needs.prepare.result == 'success' && needs.prepare.outputs.skip == 'false'";
const verifiedRef = "${{ needs.prepare.outputs.sha }}";
const prepareRef = "${{ steps.resolve.outputs.sha }}";
let status = 0;

function refuse(reason, path = workflowPath) {
  console.error(`goat pre-push: ${path} in ${ref} (${sha}): ${reason}; refusing to push`);
  status = 1;
}

function isMapping(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

// Load only an installed repository parser, choosing the first package name in lexical order.
function loadYaml() {
  const store = NodePath.join(root, "node_modules/.pnpm");
  const name = NodeFS.readdirSync(store)
    .filter((entry) => entry.startsWith("yaml@2."))
    .sort()[0];
  if (!name) throw new Error("missing yaml");
  const packageDir = NodePath.join(store, name, "node_modules/yaml");
  const metadata = JSON.parse(
    NodeFS.readFileSync(NodePath.join(packageDir, "package.json"), "utf8"),
  );
  if (typeof metadata.version !== "string" || !metadata.version.startsWith("2.")) {
    throw new Error("wrong yaml version");
  }
  const entry = NodeModule.createRequire(import.meta.url).resolve(packageDir);
  return NodeModule.createRequire(entry)(entry);
}

// Aliased keys are resolved by toJS; also reject merge keys outside the validated fields.
function rejectMergeKeys(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  if (Object.hasOwn(value, "<<")) throw new Error("merge key");
  for (const item of Object.values(value)) rejectMergeKeys(item, seen);
}

function parseWorkflow(source, yaml) {
  let workflow;
  try {
    const doc = yaml.parseDocument(source, { version: "1.2", uniqueKeys: true, merge: false });
    if (doc.errors.length > 0 || doc.directives.yaml.version !== "1.2") {
      throw new Error("invalid document");
    }
    yaml.visit(doc, {
      Pair(_key, pair) {
        if (yaml.isScalar(pair.key) && pair.key.value === "<<") throw new Error("merge key");
      },
    });
    workflow = doc.toJS({ maxAliasCount: 100 });
    rejectMergeKeys(workflow);
  } catch {
    return undefined;
  }
  return workflow;
}

function validateWorkflow(source, yaml) {
  const workflow = parseWorkflow(source, yaml);
  if (workflow === undefined) return refuse("invalid YAML");

  if (!isMapping(workflow)) return refuse("root must be a mapping");
  if (
    !isMapping(workflow.on) ||
    Object.keys(workflow.on).length === 0 ||
    Object.keys(workflow.on).some(
      (event) => !["push", "pull_request", "workflow_dispatch"].includes(event),
    )
  ) {
    return refuse(
      "on must be a nonempty mapping containing only push, pull_request, workflow_dispatch",
    );
  }
  if (
    !isMapping(workflow.jobs) ||
    Object.keys(workflow.jobs).length !== 1 ||
    !Object.hasOwn(workflow.jobs, "ci")
  ) {
    return refuse("jobs must contain exactly ci");
  }
  const job = workflow.jobs.ci;
  if (!isMapping(job)) return refuse("jobs.ci must be a mapping");
  if (Object.hasOwn(job, "uses")) return refuse("jobs.ci.uses is forbidden");
  if (Object.hasOwn(job, "container") || Object.hasOwn(job, "services")) {
    return refuse("jobs.ci.container and jobs.ci.services are forbidden");
  }
  const runners = job["runs-on"];
  if (
    !Array.isArray(runners) ||
    runners.length !== 5 ||
    new Set(runners).size !== 5 ||
    runners.some((label) => typeof label !== "string" || !labels.has(label))
  ) {
    return refuse("jobs.ci.runs-on must contain exactly self-hosted, linux, x64, goat, epyc");
  }
  if (
    !Array.isArray(job.steps) ||
    job.steps.length === 0 ||
    job.steps.some((step) => !isMapping(step))
  ) {
    return refuse("jobs.ci.steps must be a nonempty array of mappings");
  }
  for (const [index, step] of job.steps.entries()) {
    if (Object.hasOwn(step, "run") === Object.hasOwn(step, "uses")) {
      refuse(`step ${index} must contain exactly one of run or uses`);
    } else if (Object.hasOwn(step, "uses") && !actions.has(step.uses)) {
      refuse(`step ${index}.uses is not an allowed action`);
    }
  }
}

/** Collapses whitespace and strips an optional ${{ }} wrapper so folded YAML compares exactly. */
function normalizeExpression(value) {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1] ?? "";
  return text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/** True when text is "(...)" whose outer parentheses close only at the end, ignoring quoted text. */
function isSingleGroup(text) {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "'") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !quoted;
}

// Only "gate" or "gate && (rest)": && binds tighter than ||, so nothing in rest can
// run the job unless prepare succeeded and chose not to skip.
function isDownstreamGate(value) {
  const text = normalizeExpression(value);
  if (text === undefined) return false;
  if (text === downstreamGate) return true;
  const prefix = `${downstreamGate} && `;
  return text.startsWith(prefix) && isSingleGroup(text.slice(prefix.length));
}

function isAllowedRunner(runner) {
  if (typeof runner === "string") return hostedRunners.has(runner);
  if (!Array.isArray(runner) || runner.some((label) => typeof label !== "string")) return false;
  const set = new Set(runner.map((label) => label.toLowerCase()));
  return selfHostedRunners.some(
    (allowed) => set.size === allowed.length && allowed.every((label) => set.has(label)),
  );
}

function jobRunners(job) {
  const runner = job["runs-on"];
  if (runner !== "${{ matrix.runner }}") return [runner];
  const matrix = isMapping(job.strategy) ? job.strategy.matrix : undefined;
  if (!isMapping(matrix)) return [undefined];
  const values = [];
  if (Array.isArray(matrix.runner)) values.push(...matrix.runner);
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) values.push(isMapping(entry) ? entry.runner : undefined);
  }
  return values.length > 0 ? values : [undefined];
}

function validateNightlyWorkflow(source, yaml) {
  const fail = (reason) => refuse(reason, nightlyPath);
  const workflow = parseWorkflow(source, yaml);
  if (workflow === undefined) return fail("invalid YAML");
  if (!isMapping(workflow)) return fail("root must be a mapping");

  const on = workflow.on;
  const run = isMapping(on) ? on.workflow_run : undefined;
  const sameList = (value, expected) =>
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((v, i) => v === expected[i]);
  if (
    !isMapping(on) ||
    Object.keys(on).some((event) => !["workflow_run", "workflow_dispatch"].includes(event)) ||
    !isMapping(run) ||
    !sameList(run.workflows, ["goat-ci"]) ||
    !sameList(run.types, ["completed"]) ||
    !sameList(run.branches, ["dev"])
  ) {
    return fail(
      "on must be workflow_run of goat-ci (completed, branches [dev]) plus optional workflow_dispatch",
    );
  }
  if (
    !isMapping(workflow.permissions) ||
    Object.keys(workflow.permissions).length !== 1 ||
    workflow.permissions.contents !== "read"
  ) {
    return fail("permissions must be exactly contents: read");
  }
  if (!isMapping(workflow.jobs) || !isMapping(workflow.jobs.prepare)) {
    return fail("jobs.prepare must exist");
  }
  const { publish: publishJob, ...rest } = workflow.jobs;
  // Any mention of the secrets context counts: secrets.X, secrets['X'], toJSON(secrets).
  // Context names are case-insensitive in expressions.
  if (/\bsecrets\b/i.test(JSON.stringify({ ...workflow, jobs: rest }))) {
    fail("secrets may only be read by jobs.publish");
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!isMapping(job)) {
      fail(`jobs.${name} must be a mapping`);
      continue;
    }
    if (
      Object.hasOwn(job, "uses") ||
      Object.hasOwn(job, "container") ||
      Object.hasOwn(job, "services")
    ) {
      fail(`jobs.${name} must not use uses, container or services`);
    }
    if (JSON.stringify(job.permissions ?? {}).includes("write")) {
      fail(`jobs.${name} must not request write permissions`);
    }
    if (name === "prepare") {
      if (normalizeExpression(job.if) !== prepareGate)
        fail("jobs.prepare.if must be the dev-push gate");
      if (Object.hasOwn(job, "needs")) fail("jobs.prepare must not need other jobs");
    } else {
      const needs = typeof job.needs === "string" ? [job.needs] : job.needs;
      if (!Array.isArray(needs) || !needs.includes("prepare")) {
        fail(`jobs.${name}.needs must include prepare`);
      }
      if (!isDownstreamGate(job.if)) {
        fail(`jobs.${name}.if must start with the prepare gate`);
      }
    }
    if (jobRunners(job).some((runner) => !isAllowedRunner(runner))) {
      fail(`jobs.${name}.runs-on must be an allowed hosted runner, EPYC, or the Mac Studio`);
    }
    if (name === "publish" && job["runs-on"] !== "ubuntu-24.04") {
      fail("jobs.publish must run on ubuntu-24.04");
    }
    if (
      !Array.isArray(job.steps) ||
      job.steps.length === 0 ||
      job.steps.some((step) => !isMapping(step))
    ) {
      fail(`jobs.${name}.steps must be a nonempty array of mappings`);
      continue;
    }
    for (const [index, step] of job.steps.entries()) {
      if (Object.hasOwn(step, "run") === Object.hasOwn(step, "uses")) {
        fail(`jobs.${name} step ${index} must contain exactly one of run or uses`);
        continue;
      }
      if (!Object.hasOwn(step, "uses")) continue;
      if (!nightlyActions.has(step.uses))
        fail(`jobs.${name} step ${index}.uses is not an allowed action`);
      if (step.uses === "actions/create-github-app-token@v2" && job !== publishJob) {
        fail("only jobs.publish may create a GitHub App token");
      }
      if (step.uses === "actions/checkout@v6") {
        const expected = name === "prepare" ? prepareRef : verifiedRef;
        const options = isMapping(step.with) ? step.with : {};
        if (options.ref !== expected || options["persist-credentials"] !== false) {
          fail(
            `jobs.${name} step ${index} must check out ${expected} with persist-credentials: false`,
          );
        }
      }
    }
  }
}

let paths;
try {
  paths = NodeChildProcess.execFileSync(
    "git",
    ["--no-replace-objects", "ls-tree", "-rz", "--name-only", sha, "--", ".github/workflows"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\0")
    .filter(Boolean);
} catch {
  console.error(
    `goat pre-push: cannot enumerate pushed workflows in ${ref} (${sha}); refusing to push`,
  );
  NodeProcess.exit(1);
}
for (const path of paths) {
  if (
    path !== workflowPath &&
    path !== nightlyPath &&
    /\.ya?ml$/.test(path) &&
    !disabled.has(path)
  ) {
    console.error(`goat pre-push: ${path} in ${ref} is not disabled on goat-si/goat`);
    status = 1;
  }
}
for (const path of [workflowPath, nightlyPath]) {
  if (!paths.includes(path)) continue;
  let source;
  try {
    source = NodeChildProcess.execFileSync(
      "git",
      ["--no-replace-objects", "show", `${sha}:${path}`],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    refuse("cannot read pushed workflow", path);
    NodeProcess.exit(1);
  }
  let yaml;
  try {
    yaml = loadYaml();
  } catch {
    console.error(
      "goat pre-push: repository yaml@2.* is unavailable or unloadable; run vp i; refusing to push",
    );
    NodeProcess.exit(1);
  }
  if (path === workflowPath) validateWorkflow(source, yaml);
  else validateNightlyWorkflow(source, yaml);
}
if (status !== 0) NodeProcess.exit(status);
