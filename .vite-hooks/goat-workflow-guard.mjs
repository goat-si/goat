import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const [sha, ref] = NodeProcess.argv.slice(2);
const workflowPath = ".github/workflows/goat-ci.yml";
const nightlyPath = ".github/workflows/goat-nightly.yml";
const closeOutsidePrsPath = ".github/workflows/close-outside-prs.yml";
const disabled = new Set((NodeProcess.env.GOAT_DISABLED_WORKFLOWS ?? "").split("\n"));
const labels = new Set(["self-hosted", "linux", "x64", "goat", "epyc"]);
// goat-ci jobs run on a pinned GitHub-hosted image or on EPYC, never on a moving label.
const goatCiHostedRunner = "ubuntu-24.04";
// A manual run or a same-repository pull request goes to EPYC and a fork's pull request to the
// hosted image (#426). The trust test is the expression itself, so it is pinned whole.
const goatCiTrustedRunner =
  '(github.event_name == \'workflow_dispatch\' || github.event.pull_request.head.repo.full_name == github.repository) && fromJSON(\'["self-hosted","linux","x64","goat","epyc"]\') || \'ubuntu-24.04\'';
// goat-scope picks the matrix, ci runs it, goat-ci-result aggregates.
const goatCiJobs = new Set(["scope", "ci", "screenshot-gate", "result"]);
// No Actions artifacts anywhere: goat-si is on the free plan and a full artifact
// quota fails every upload. goat-nightly hands off through a staging draft release.
const actions = new Set(["actions/checkout@v6", "voidzero-dev/setup-vp@v1"]);
// goat-nightly.yml signs on the Mac Studio and publishes with the goat-releases App,
// so it may only run after a successful manual goat-ci run on dev, never from a pull request.
const nightlyActions = new Set([
  ...actions,
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
  "github.repository == 'goat-si/goat' && (github.event_name == 'workflow_dispatch' || (vars.GOAT_RELEASES_PUBLISH == 'true' && github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.display_title == 'goat-ci all on dev' && github.event.workflow_run.head_branch == 'dev' && github.event.workflow_run.head_repository.full_name == 'goat-si/goat'))";
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
    !Object.hasOwn(workflow.jobs, "ci") ||
    Object.keys(workflow.jobs).some((name) => !goatCiJobs.has(name))
  ) {
    return refuse("jobs must contain ci and optionally scope, screenshot-gate, result");
  }
  for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!isMapping(job)) return refuse(`jobs.${name} must be a mapping`);
    if (name === "screenshot-gate") {
      const permissions = job.permissions;
      if (
        !isMapping(permissions) ||
        Object.keys(permissions).length !== 4 ||
        permissions.contents !== "read" ||
        permissions.issues !== "read" ||
        permissions["pull-requests"] !== "read" ||
        permissions.checks !== "write"
      ) {
        return refuse(
          "jobs.screenshot-gate.permissions must grant only contents/issues/pull-requests: read and checks: write",
        );
      }
    }
    if (Object.hasOwn(job, "uses")) return refuse(`jobs.${name}.uses is forbidden`);
    if (Object.hasOwn(job, "container") || Object.hasOwn(job, "services")) {
      return refuse(`jobs.${name}.container and jobs.${name}.services are forbidden`);
    }
    const runners = job["runs-on"];
    const trusted =
      typeof runners === "string" &&
      runners.trim().startsWith("${{") &&
      normalizeExpression(runners) === goatCiTrustedRunner;
    if (
      runners !== goatCiHostedRunner &&
      !trusted &&
      (!Array.isArray(runners) ||
        runners.length !== 5 ||
        new Set(runners).size !== 5 ||
        runners.some((label) => typeof label !== "string" || !labels.has(label)))
    ) {
      return refuse(
        `jobs.${name}.runs-on must be ${goatCiHostedRunner}, exactly self-hosted, linux, x64, goat, epyc, or the trusted-run EPYC expression`,
      );
    }
    if (
      !Array.isArray(job.steps) ||
      job.steps.length === 0 ||
      job.steps.some((step) => !isMapping(step))
    ) {
      return refuse(`jobs.${name}.steps must be a nonempty array of mappings`);
    }
    for (const [index, step] of job.steps.entries()) {
      if (Object.hasOwn(step, "run") === Object.hasOwn(step, "uses")) {
        refuse(`step ${index} must contain exactly one of run or uses`);
      } else if (Object.hasOwn(step, "uses") && !actions.has(step.uses)) {
        refuse(`step ${index}.uses is not an allowed action`);
      }
    }
  }
}

/** Collapses whitespace and strips an optional ${{ }} wrapper so folded YAML compares exactly. */
function normalizeExpression(value) {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  const wrapped = /^\$\{\{([\s\S]*)\}\}$/.exec(text);
  if (wrapped) text = wrapped[1] ?? "";
  // A partial wrapper turns the condition into a format() string, which is always
  // truthy, so delimiters may only wrap the whole condition.
  if (text.includes("${{") || text.includes("}}")) return undefined;
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
  const axis = Array.isArray(matrix.runner) ? matrix.runner : undefined;
  if (axis) values.push(...axis);
  if (Array.isArray(matrix.include)) {
    // An include entry without a runner only extends combinations that already
    // have an allowed runner from the axis (GitHub's include semantics).
    for (const entry of matrix.include) {
      if (!isMapping(entry)) values.push(undefined);
      else if (Object.hasOwn(entry, "runner") || !axis) values.push(entry.runner);
    }
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
  // Workflow-wide env or defaults would reach prepare's resolve step.
  if (Object.hasOwn(workflow, "env") || Object.hasOwn(workflow, "defaults")) {
    return fail("workflow-level env and defaults are not allowed");
  }
  if (!isMapping(workflow.jobs) || !isMapping(workflow.jobs.prepare)) {
    return fail("jobs.prepare must exist");
  }
  const rest = Object.fromEntries(
    Object.entries(workflow.jobs).filter(([name]) => name !== "publish"),
  );
  // Any mention of the secrets context counts: secrets.X, secrets['X'], toJSON(secrets),
  // in any case and after any whitespace. Decoded strings are inspected, not JSON text.
  if (mentionsSecrets({ ...workflow, jobs: rest })) {
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
    // The staging hand-off (scripts/nightly-staging.ts) reads and writes a draft
    // release in goat-si/goat, which needs contents: write and nothing else.
    // prepare verifies the commit and never needs it.
    if (Object.hasOwn(job, "permissions")) {
      const permissions = job.permissions;
      const contentsWrite =
        isMapping(permissions) &&
        Object.keys(permissions).length === 1 &&
        permissions.contents === "write";
      const readOnly = !JSON.stringify(permissions ?? {}).includes("write");
      if (name === "prepare" ? !readOnly : !(contentsWrite || readOnly)) {
        fail(
          name === "prepare"
            ? "jobs.prepare must not request write permissions"
            : `jobs.${name} may only request contents: write`,
        );
      }
    }
    if (name === "prepare") {
      if (normalizeExpression(job.if) !== prepareGate)
        fail("jobs.prepare.if must be the manual dev run gate");
      if (Object.hasOwn(job, "needs")) fail("jobs.prepare must not need other jobs");
      // Downstream checkouts trust needs.prepare.outputs.sha, so it must come from
      // the resolve step that checks the commit against dev.
      const outputs = isMapping(job.outputs) ? job.outputs : {};
      if (
        outputs.sha !== "${{ steps.resolve.outputs.sha }}" ||
        outputs.skip !== "${{ steps.resolve.outputs.skip }}" ||
        // First step, so no earlier step can change PATH or BASH_ENV; and no job
        // env or defaults, which could change its environment or interpreter.
        !Array.isArray(job.steps) ||
        !isMapping(job.steps[0]) ||
        job.steps[0].id !== "resolve" ||
        !isPinnedResolve(job.steps[0]) ||
        Object.hasOwn(job, "env") ||
        Object.hasOwn(job, "defaults") ||
        Object.hasOwn(job, "continue-on-error") ||
        // Later steps run only when the resolver succeeded and chose to build; its
        // skip output exists only after it verified the commit.
        job.steps
          .slice(1)
          .some(
            (step) =>
              !isMapping(step) ||
              normalizeExpression(step.if) !== "steps.resolve.outputs.skip == 'false'" ||
              Object.hasOwn(step, "continue-on-error"),
          )
      ) {
        fail("jobs.prepare outputs sha and skip must come from its pinned resolve step");
      }
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
      if (step.uses === "actions/create-github-app-token@v2" && name !== "publish") {
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

/** True when any key or string value inside value mentions the secrets context. */
const secretsContext = /(?:^|[^A-Za-z0-9_-])secrets(?![A-Za-z0-9_-])/i;

/**
 * True when an expression inside value reads the secrets context: secrets.X,
 * secrets['X'] or toJSON(secrets), in any case and with any whitespace. Only
 * expression text counts: ${{ … }} segments anywhere, and whole `if` values,
 * which GitHub evaluates as expressions without the wrapper.
 */
// Any string or mapping key that carries an expression is scanned as a whole, so
// quoting inside the expression cannot hide the reference.
function mentionsSecrets(value, key = "") {
  if (typeof value === "string") {
    return (key === "if" || value.includes("${{")) && secretsContext.test(value);
  }
  if (Array.isArray(value)) return value.some((item) => mentionsSecrets(item));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([entryKey, item]) => mentionsSecrets(entryKey) || mentionsSecrets(item, entryKey),
    );
  }
  return false;
}

// prepare's resolve step is what checks the commit against dev; every checkout
// trusts its sha output. Changing that step means updating this pin on purpose.
// The whole step is pinned (any added key such as if or continue-on-error changes it).
const pinnedResolveSha256 = "7e2fda2ab95f3ce5626b6e0fcc95eb39f3d9c99e19590a610a6e0e9996543fd0";
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .toSorted()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}
function isPinnedResolve(step) {
  const pinned = JSON.stringify(canonical(step));
  return NodeCrypto.createHash("sha256").update(pinned).digest("hex") === pinnedResolveSha256;
}

// close-outside-prs.yml stays active on goat-si/goat on purpose (#426, #430). It runs on
// pull_request_target with a write token from the default branch (main), so it must never check out or
// run pull request code. A blocklist of commands cannot promise that, so the reviewed job is
// pinned whole: any change to it, including step names, scripts and env, means reviewing it
// again and updating this hash on purpose.
const pinnedCloseOutsideJobSha256 =
  "1f8e3fb2ec56cb45493b0a0a6758252f5f119cf9f749bd857546370b3d585e5b";

function validateCloseOutsidePrsWorkflow(source, yaml) {
  const fail = (reason) => refuse(reason, closeOutsidePrsPath);
  const workflow = parseWorkflow(source, yaml);
  if (workflow === undefined) return fail("invalid YAML");
  if (!isMapping(workflow)) return fail("root must be a mapping");
  const trigger = isMapping(workflow.on) ? workflow.on.pull_request_target : undefined;
  if (
    !isMapping(workflow.on) ||
    Object.keys(workflow.on).length !== 1 ||
    !isMapping(trigger) ||
    Object.keys(trigger).length !== 1 ||
    !Array.isArray(trigger.types) ||
    trigger.types.length !== 2 ||
    trigger.types[0] !== "opened" ||
    trigger.types[1] !== "reopened"
  ) {
    return fail("on must be exactly pull_request_target with types [opened, reopened]");
  }
  if (
    !isMapping(workflow.permissions) ||
    Object.keys(workflow.permissions).length !== 1 ||
    workflow.permissions["pull-requests"] !== "write"
  ) {
    return fail("permissions must be exactly pull-requests: write");
  }
  if (Object.keys(workflow).some((key) => !["name", "on", "permissions", "jobs"].includes(key))) {
    return fail("only name, on, permissions and jobs are allowed at the workflow level");
  }
  if (typeof workflow.name !== "undefined" && typeof workflow.name !== "string") {
    return fail("name must be a string");
  }
  if (workflow.name?.includes("${{")) return fail("name must not contain expressions");
  const job = isMapping(workflow.jobs) ? workflow.jobs.close : undefined;
  if (Object.keys(workflow.jobs ?? {}).length !== 1 || !isMapping(job)) {
    return fail("jobs must be exactly close");
  }
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(canonical(job)))
    .digest("hex");
  if (digest !== pinnedCloseOutsideJobSha256) {
    return fail("jobs.close must match the reviewed job; review it and update the pinned hash");
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
    path !== closeOutsidePrsPath &&
    /\.ya?ml$/.test(path) &&
    !disabled.has(path)
  ) {
    console.error(`goat pre-push: ${path} in ${ref} is not disabled on goat-si/goat`);
    status = 1;
  }
}
for (const path of [workflowPath, nightlyPath, closeOutsidePrsPath]) {
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
  else if (path === nightlyPath) validateNightlyWorkflow(source, yaml);
  else validateCloseOutsidePrsWorkflow(source, yaml);
}
if (status !== 0) NodeProcess.exit(status);
