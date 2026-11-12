import test from "node:test";
import assert from "node:assert/strict";
import { createProject, DomainError, evaluateRevision, replayProject } from "../app/core.mjs";
import { proposeBudgetRescue } from "../app/budget-rescue.mjs";
import { creation, revision } from "./fixtures.mjs";

test("draft evaluation and Budget Rescue enforce the same revision contract as recording", () => {
  const cases = [
    ["blank participant name", r => { r.members[0].name = " "; }],
    ["blank item label", r => { r.items[0].label = ""; }],
    ["fractional budget", r => { r.members[0].budgetMinor = 9000.5; }],
    ["missing budget", r => { r.members[0].budgetMinor = Number.NaN; }],
    ["negative budget", r => { r.members[0].budgetMinor = -1; }],
    ["unsafe budget", r => { r.members[0].budgetMinor = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative price", r => { r.items[0].unitMinor = -4000; }],
    ["fractional price", r => { r.items[0].unitMinor = 4000.5; }],
    ["zero quantity", r => { r.items[0].quantity = 0; }],
    ["unsafe item total", r => { r.items[0].unitMinor = Number.MAX_SAFE_INTEGER; }],
    ["negative weight", r => { r.items[0].weights[0].units = -1; }],
    ["unsafe weight sum", r => { r.items[0].weights.forEach(w => { w.units = Number.MAX_SAFE_INTEGER; }); }],
    ["all zero weights", r => { r.items[0].weights.forEach(w => { w.units = 0; }); }],
    ["missing member weight", r => { r.items[0].weights.pop(); }],
    ["unknown member weight", r => { r.items[0].weights[0].memberId = "unknown"; }],
    ["duplicate member", r => { r.members[1].id = r.members[0].id; }],
    ["duplicate item", r => { r.items[1].id = r.items[0].id; }],
    ["empty members", r => { r.members = []; }],
    ["empty items", r => { r.items = []; }],
    ["sparse items", r => { delete r.items[0]; }],
    ["unsupported policy", r => { r.policy = "unknown"; }],
    ["invalid timestamp", r => { r.createdAt = "tomorrow"; }],
    ["unknown field", r => { r.feasible = true; }]
  ];
  for (const [label, alter] of cases) {
    const input = revision(); alter(input);
    const original = structuredClone(input);
    let recordedError;
    try { createProject({ ...creation(), revision: input }); } catch (error) { recordedError = error; }
    assert.ok(recordedError instanceof DomainError, `${label}: recording must refuse`);
    for (const operation of [evaluateRevision, proposeBudgetRescue]) {
      assert.throws(() => operation(input), error => error instanceof DomainError && error.code === recordedError.code,
        `${label}: ${operation.name} must refuse with ${recordedError.code}`);
      assert.deepEqual(input, original, `${label}: ${operation.name} must leave inputs untouched`);
    }
  }
});

test("direct evaluation rejects a missing or invalid revision ordinal without raw runtime errors", () => {
  for (const ordinal of [undefined, 0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const r = revision(); r.ordinal = ordinal;
    assert.throws(() => evaluateRevision(r), error => error instanceof DomainError && error.code === "invalid_integer");
  }
  for (const r of [null, undefined, {}, []]) {
    assert.throws(() => evaluateRevision(r), error => error instanceof DomainError);
  }
});

test("valid zero-cost, exact-cent tie and amended drafts retain recording-equivalent results", () => {
  const r = revision();
  r.items[0].unitMinor = 1; r.items[0].quantity = 1;
  r.items[0].weights.forEach(w => { w.units = 1; });
  r.items[1].unitMinor = 0;
  const prior = structuredClone(r);
  assert.deepEqual(evaluateRevision(r), replayProject(createProject({ ...creation(), revision: r })).evaluation);
  assert.deepEqual(evaluateRevision(r).members.map(m => m.amountMinor), [1, 0, 0]);
  assert.equal(proposeBudgetRescue(r).status, "already-feasible");
  assert.deepEqual(r, prior);
  r.ordinal = 2;
  assert.equal(evaluateRevision(r).totalMinor, 1, "an unrecorded next revision is still a valid preview");
});
