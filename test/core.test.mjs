import test from "node:test";
import assert from "node:assert/strict";
import { allocateItem, amendProject, approveProject, createProject, DomainError, evaluateRevision, expectedState, exportProject, importProject, replayProject, withdrawApproval } from "../app/core.mjs";
import { at, creation, revision } from "./fixtures.mjs";

test("receiving example conserves cents and exposes budgets", () => {
  const project = createProject(creation());
  const state = replayProject(project);
  assert.deepEqual(state.evaluation.members.map(({ id, amountMinor, overMinor }) => ({ id, amountMinor, overMinor })), [
    { id: "asha", amountMinor: 6000, overMinor: 0 },
    { id: "ben", amountMinor: 10000, overMinor: 0 },
    { id: "chen", amountMinor: 6000, overMinor: 0 }
  ]);
  assert.equal(state.evaluation.totalMinor, 22000);
  assert.equal(state.evaluation.executedMinor, 0);
  assert.equal(state.evaluation.paymentState, "not-executing");
});

test("largest remainder is exact and uses stable ASCII IDs", () => {
  const item = { id: "cent", unitMinor: 1, quantity: 1, weights: [{ memberId: "a", units: 1 }, { memberId: "A", units: 1 }, { memberId: "b", units: 1 }] };
  assert.deepEqual(allocateItem(item), [{ memberId: "A", minor: 1 }, { memberId: "a", minor: 0 }, { memberId: "b", minor: 0 }]);
  assert.deepEqual(allocateItem({ ...item, weights: [...item.weights].reverse() }), allocateItem(item));
});

test("approval declarations bind exact revision and every amendment retires them", () => {
  let project = createProject(creation());
  for (const [index, memberId] of ["asha", "ben", "chen"].entries()) project = approveProject(project, expectedState(project), { eventId: `ea${index}`, at: at(index + 2), memberId });
  assert.equal(replayProject(project).evaluation.agreementRecorded, true);
  const oldExpected = expectedState(project);
  const r2 = revision(2, { note: "label-only amendment" });
  project = amendProject(project, oldExpected, { eventId: "e-amend", at: at(8), revision: r2 });
  assert.deepEqual(replayProject(project).approvals, []);
  assert.throws(() => approveProject(project, oldExpected, { eventId: "stale", at: at(9), memberId: "asha" }), error => error.code === "stale_action");
});

test("infeasible amendments remain visible but refuse approvals", () => {
  let project = createProject(creation());
  const changed = revision(2, {
    note: "Ben leaves and Chen takes two tickets",
    members: [{ id: "asha", name: "Asha", budgetMinor: 9000 }, { id: "chen", name: "Chen", budgetMinor: 8000 }],
    items: [
      { id: "tickets", label: "Tickets", unitMinor: 4000, quantity: 3, weights: [{ memberId: "asha", units: 1 }, { memberId: "chen", units: 2 }] },
      { id: "coach", label: "Coach", unitMinor: 6000, quantity: 1, weights: [{ memberId: "asha", units: 1 }, { memberId: "chen", units: 1 }] }
    ]
  });
  project = amendProject(project, expectedState(project), { eventId: "e2", at: at(3), revision: changed });
  const state = replayProject(project);
  assert.deepEqual(state.evaluation.members.map(member => [member.id, member.amountMinor, member.overMinor]), [["asha", 7000, 0], ["chen", 11000, 3000]]);
  assert.throws(() => approveProject(project, expectedState(project), { eventId: "e3", at: at(4), memberId: "asha" }), error => error.code === "infeasible");
});

test("complete change journey reaches $40/$80 only with fresh declarations", () => {
  let project = createProject(creation());
  for (const [index, memberId] of ["asha", "ben", "chen"].entries()) project = approveProject(project, expectedState(project), { eventId: `r1a${index}`, at: at(index + 2), memberId });
  project = amendProject(project, expectedState(project), { eventId: "withdraw-ben", at: at(6), revision: revision(2, {
    note: "Ben leaves; Chen takes two tickets",
    members: [{ id: "asha", name: "Asha", budgetMinor: 9000 }, { id: "chen", name: "Chen", budgetMinor: 8000 }],
    items: [
      { id: "tickets", label: "Tickets", unitMinor: 4000, quantity: 3, weights: [{ memberId: "asha", units: 1 }, { memberId: "chen", units: 2 }] },
      { id: "coach", label: "Coach", unitMinor: 6000, quantity: 1, weights: [{ memberId: "asha", units: 1 }, { memberId: "chen", units: 1 }] }
    ]
  }) });
  assert.equal(replayProject(project).evaluation.feasible, false);
  project = amendProject(project, expectedState(project), { eventId: "remove-coach", at: at(7), revision: revision(3, {
    note: "Coach unavailable",
    members: [{ id: "asha", name: "Asha", budgetMinor: 9000 }, { id: "chen", name: "Chen", budgetMinor: 8000 }],
    items: [{ id: "tickets", label: "Tickets", unitMinor: 4000, quantity: 3, weights: [{ memberId: "asha", units: 1 }, { memberId: "chen", units: 2 }] }]
  }) });
  assert.deepEqual(replayProject(project).evaluation.members.map(member => [member.id, member.amountMinor]), [["asha", 4000], ["chen", 8000]]);
  assert.deepEqual(replayProject(project).approvals, []);
  project = approveProject(project, expectedState(project), { eventId: "r3a", at: at(8), memberId: "asha" });
  assert.equal(replayProject(project).evaluation.agreementRecorded, false);
  project = approveProject(project, expectedState(project), { eventId: "r3c", at: at(9), memberId: "chen" });
  assert.equal(replayProject(importProject(exportProject(project))).evaluation.agreementRecorded, true);
});

test("withdrawal is append-only and duplicate transitions refuse", () => {
  let project = createProject(creation());
  project = approveProject(project, expectedState(project), { eventId: "e2", at: at(2), memberId: "asha" });
  assert.throws(() => approveProject(project, expectedState(project), { eventId: "e3", at: at(3), memberId: "asha" }), error => error.code === "duplicate_transition");
  project = withdrawApproval(project, expectedState(project), { eventId: "e4", at: at(4), memberId: "asha" });
  assert.equal(replayProject(project).project.events.length, 3);
  assert.throws(() => withdrawApproval(project, expectedState(project), { eventId: "e5", at: at(5), memberId: "asha" }), error => error.code === "duplicate_transition");
});

test("same IDs and sequence cannot authorize different revision content", () => {
  const one = createProject(creation());
  const forkInput = creation(); forkInput.revision = revision(1); forkInput.revision.items[0].unitMinor = 99;
  const fork = createProject(forkInput);
  assert.throws(() => approveProject(fork, expectedState(one), { eventId: "fork-event", at: at(5), memberId: "asha" }), error => error.code === "stale_action");
});

test("export and import validate full history and round trip canonically", () => {
  let project = createProject(creation());
  project = approveProject(project, expectedState(project), { eventId: "e2", at: at(2), memberId: "asha" });
  const text = exportProject(project);
  assert.equal(exportProject(importProject(text)), text);
  const malicious = JSON.parse(text); malicious.ready = true;
  assert.throws(() => importProject(JSON.stringify(malicious)), error => error.code === "unknown_or_missing_field");
  assert.equal(exportProject(project), text);
});

test("all historical revisions are validated and creation cannot repeat", () => {
  const project = createProject(creation());
  const bad = structuredClone(project);
  bad.events.push({ ...bad.events[0], sequence: 2, eventId: "e2", revision: revision(2) });
  assert.throws(() => replayProject(bad), error => error.code === "invalid_transition");
  const invalidDate = structuredClone(project); invalidDate.events[0].at = "2026-99-19T00:00:00.000Z";
  assert.throws(() => replayProject(invalidDate), error => error instanceof DomainError && error.code === "invalid_time");
});

test("sparse arrays and all-zero weights refuse", () => {
  const sparse = creation(); sparse.revision.items = new Array(1);
  assert.throws(() => createProject(sparse), error => error.code === "invalid_shape");
  const zero = creation(); zero.revision.items[0].weights.forEach(weight => { weight.units = 0; });
  assert.throws(() => createProject(zero), error => error.code === "invalid_weights");
});

test("derived evaluation is recursively frozen and detached", () => {
  const r = revision(); const evaluated = evaluateRevision(r);
  assert.equal(Object.isFrozen(evaluated), true);
  assert.equal(Object.isFrozen(evaluated.members[0]), true);
  assert.throws(() => { evaluated.members[0].amountMinor = 1; }, TypeError);
  assert.equal(r.members[0].budgetMinor, 9000);
});
