"use strict";

// goat-ci decides from the event alone whether a pull_request run is real or ignored, in
// expressions GitHub evaluates before any step runs. These tests evaluate the workflow's own
// concurrency, job name and job if expressions against event payloads, so a trigger change that
// would cancel CI on a title edit or skip it on a retarget fails here instead of on a live PR.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/goat-ci.yml"), "utf8");

const types = workflow
  .match(/\n  pull_request:\n[\s\S]*?\n    types: \[([^\]]*)\]/)[1]
  .split(",")
  .map((type) => type.trim());
const concurrency = workflow.split("\nconcurrency:\n")[1].split("\n\n")[0];
const group = concurrency.match(/  group: >-\n    (.*)\n/)[1];
const cancel = concurrency.match(/  cancel-in-progress: (.*)/)[1];

function job(id) {
  const body = workflow.split("\n  " + id + ":\n")[1].split(/\n  [a-z-]+:\n/)[0];
  return { name: body.match(/^    name: (.*)$/m)[1], if: body.match(/^    if: (.*)$/m)?.[1] };
}
const jobs = {
  scope: job("scope"),
  ci: job("ci"),
  screenshot: job("screenshot-gate"),
  result: job("result"),
};

// The subset of GitHub's expression language goat-ci uses, with its loose equality: strings compare
// case-insensitively, mixed types compare as numbers (null and '' are 0), a missing property is
// null, and && and || return an operand. Anything else throws, so a new construct needs support here.
function evaluate(source, context) {
  const tokens = source.match(
    /\s+|'(?:[^']|'')*'|[A-Za-z_][\w-]*|\d+(?:\.\d+)?|==|!=|&&|\|\||[!().,[\]]/g,
  );
  assert.equal(tokens.join(""), source, "unsupported syntax in " + source);
  const list = tokens.filter((token) => token.trim() !== "");
  let at = 0;
  const peek = () => list[at];
  const take = (expected) => {
    const token = list[at++];
    if (expected !== undefined) assert.equal(token, expected, source);
    return token;
  };
  const truthy = (value) =>
    value !== null && value !== false && value !== 0 && value !== "" && !Number.isNaN(value);
  const number = (value) =>
    value === null
      ? 0
      : typeof value === "boolean"
        ? Number(value)
        : typeof value === "string"
          ? Number(value)
          : typeof value === "number"
            ? value
            : NaN;
  const equal = (left, right) => {
    if (typeof left === "string" && typeof right === "string")
      return left.toLowerCase() === right.toLowerCase();
    if (left === null && right === null) return true;
    if (typeof left === typeof right && typeof left === "object") return left === right;
    return number(left) === number(right);
  };
  const text = (value) => (value === null ? "" : String(value));
  const functions = {
    startswith: (value, prefix) => text(value).toLowerCase().startsWith(text(prefix).toLowerCase()),
    format: (pattern, ...args) =>
      text(pattern).replace(/\{(\d+)\}/g, (_, index) => text(args[index])),
    cancelled: () => false,
  };
  const primary = () => {
    const token = take();
    if (token === "(") {
      const value = or();
      take(")");
      return value;
    }
    if (token === "!") return !truthy(primary());
    if (token.startsWith("'")) return token.slice(1, -1).replaceAll("''", "'");
    if (/^\d/.test(token)) return Number(token);
    if (token === "true" || token === "false") return token === "true";
    if (token === "null") return null;
    if (peek() === "(") {
      const fn = functions[token.toLowerCase()];
      assert.ok(fn, "unsupported function " + token);
      take("(");
      const args = [];
      while (peek() !== ")") {
        args.push(or());
        if (peek() === ",") take(",");
      }
      take(")");
      return fn(...args);
    }
    let value = Object.hasOwn(context, token) ? context[token] : null;
    while (peek() === ".") {
      take(".");
      const key = take();
      value =
        value !== null && typeof value === "object" && Object.hasOwn(value, key)
          ? value[key]
          : null;
    }
    return value;
  };
  const comparison = () => {
    let value = primary();
    while (peek() === "==" || peek() === "!=") {
      const negate = take() === "!=";
      value = equal(value, primary()) !== negate;
    }
    return value;
  };
  const and = () => {
    let value = comparison();
    while (peek() === "&&") {
      take();
      const right = comparison();
      value = truthy(value) ? right : value;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === "||") {
      take();
      const right = and();
      value = truthy(value) ? value : right;
    }
    return value;
  };
  const value = or();
  assert.equal(at, list.length, "unparsed input in " + source);
  return value;
}

const unwrap = (field) => field.match(/^\$\{\{ (.*) \}\}$/)?.[1] ?? field;
const interpolate = (field, context) =>
  field.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => {
    const value = evaluate(expression, context);
    return value === null ? "" : String(value);
  });

const repository = "goat-si/goat";
const pullRequest = (repo = repository) => ({
  number: 7,
  head: { repo: { full_name: repo } },
  base: { ref: "dev" },
});

/** What GitHub does with one event: the concurrency it takes, and each gate job's check name and whether it runs. */
function runFor(eventName, event) {
  const context = {
    github: {
      event_name: eventName,
      event,
      run_id: "9001",
      ref: eventName === "pull_request" ? "refs/pull/7/merge" : "refs/heads/dev",
      repository,
    },
    matrix: { title: "check" },
  };
  const gate = (spec) => ({
    name: interpolate(spec.name, context),
    runs: evaluate(unwrap(spec.if), context) === true,
  });
  return {
    triggers: eventName !== "pull_request" || types.includes(event.action),
    group: interpolate(group, context),
    cancel: interpolate(cancel, context) === "true",
    scope: gate(jobs.scope),
    ci: interpolate(jobs.ci.name, context),
    screenshot: gate(jobs.screenshot),
    result: gate(jobs.result),
  };
}

const realRun = {
  triggers: true,
  group: "goat-ci-refs/pull/7/merge",
  cancel: true,
  scope: { name: "goat-scope", runs: true },
  ci: "goat-check",
  screenshot: { name: "goat-screenshot-gate", runs: true },
  result: { name: "goat-ci-result", runs: true },
};
const ignored = { name: "goat-ci (event ignored)", runs: false };
const ignoredRun = {
  triggers: true,
  group: "goat-ci-9001",
  cancel: false,
  scope: ignored,
  ci: ignored.name,
  screenshot: ignored,
  result: ignored,
};

describe("goat-ci pull request triggers", () => {
  it("starts the required checks when a pull request is retargeted, superseding the run against the old base", () => {
    const retarget = {
      action: "edited",
      changes: { base: { ref: { from: "goat/stack" }, sha: { from: "abc123" } } },
      pull_request: pullRequest(),
    };
    assert.deepEqual(runFor("pull_request", retarget), realRun);
  });

  it("skips a title or body edit in a group of its own, so it neither cancels CI nor reports under a required name", () => {
    for (const changes of [{ title: { from: "old title" } }, { body: { from: "old body" } }, {}]) {
      assert.deepEqual(
        runFor("pull_request", { action: "edited", changes, pull_request: pullRequest() }),
        ignoredRun,
        JSON.stringify(changes),
      );
    }
  });

  it("keeps opened, synchronize, reopened and ci:* labels on the shared group under the required names", () => {
    for (const action of ["opened", "synchronize", "reopened"]) {
      assert.deepEqual(
        runFor("pull_request", { action, pull_request: pullRequest() }),
        realRun,
        action,
      );
    }
    const full = { action: "labeled", label: { name: "ci:full" }, pull_request: pullRequest() };
    assert.deepEqual(runFor("pull_request", full), realRun);
  });

  it("still ignores a label other than ci:*", () => {
    const label = { action: "labeled", label: { name: "size:S" }, pull_request: pullRequest() };
    assert.deepEqual(runFor("pull_request", label), ignoredRun);
  });

  it("never runs a fork's retarget, whose jobs would reach the trusted runners", () => {
    const retarget = {
      action: "edited",
      changes: { base: { ref: { from: "main" } } },
      pull_request: pullRequest("someone/goat"),
    };
    const run = runFor("pull_request", retarget);
    assert.deepEqual([run.scope.runs, run.screenshot.runs, run.result.runs], [false, false, false]);
  });

  it("gives a manual run its own group that cancels nothing", () => {
    const run = runFor("workflow_dispatch", { inputs: { lane: "all" } });
    assert.deepEqual(
      { group: run.group, cancel: run.cancel, scope: run.scope, result: run.result },
      {
        group: "goat-ci-9001",
        cancel: false,
        scope: { name: "goat-scope", runs: true },
        result: { name: "goat-ci-result", runs: true },
      },
    );
  });
});
