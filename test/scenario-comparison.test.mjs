import test from "node:test";
import assert from "node:assert/strict";
import { ScenarioComparison, compareScenarios } from "../app/scenario-comparison.mjs";
import { revision } from "./fixtures.mjs";
const token = { session:1, projectId:"p", sequence:1, revisionFingerprint:"r1" };
test("kept options retain exact cents and independent snapshots, including removed members", () => {
  const store = new ScenarioComparison(); const current = revision();
  const draft = structuredClone(current); draft.items[0].unitMinor = 2001;
  const id = store.pin("Cheaper tickets", draft, token);
  draft.items[0].unitMinor = 9900;
  const entries = store.list(token);
  const result = compareScenarios(current, entries);
  assert.deepEqual(result.totals, [22000,14004]);
  assert.deepEqual(result.people.map(person => person.values[1].amountMinor), [4001,6002,4001]);
  assert.equal(store.copy(id, token).items[0].unitMinor,2001);
  const copy = store.copy(id,token); copy.members[0].name = "Altered";
  assert.equal(store.copy(id,token).members[0].name,"Asha");
});
test("stale agreement remains comparable but cannot be reused; new workspace clears options", () => {
  const store = new ScenarioComparison(); const id = store.pin("Original",revision(),token);
  const changed = {...token, sequence:2};
  assert.equal(store.list(changed)[0].stale,true);
  assert.throws(() => store.copy(id,changed), /recorded agreement changed/);
  assert.equal(store.list({...token,session:2}).length,0);
});
test("invalid amounts and excess options cannot enter comparison", () => {
  const store = new ScenarioComparison(); const broken = revision(); broken.items[0].unitMinor = NaN;
  assert.throws(() => store.pin("Invalid",broken,token));
  for(let i=0;i<6;i++) store.pin("Option "+i,revision(),token);
  assert.throws(() => store.pin("Seventh",revision(),token),/six/);
  store.remove(1); assert.equal(store.list(token).length,5);
});

test("saved options preserve exact source across sessions and stay stale after changes", () => {
  const original = new ScenarioComparison();
  const id = original.pin("Cheaper tickets", revision(), token);
  const saved = original.snapshot(token);
  const reopened = new ScenarioComparison();
  const fresh = {...token,session:91};
  reopened.restore(saved,fresh);
  assert.deepEqual(reopened.copy(id,fresh),revision());
  assert.equal(reopened.pin("Second",revision(),fresh),2);
  const changed = {...fresh,sequence:2,revisionFingerprint:"r2"};
  const later = new ScenarioComparison();
  later.restore(reopened.snapshot(changed),{...changed,session:92});
  assert.equal(later.list({...changed,session:92})[0].stale,true);
  assert.throws(()=>later.copy(id,{...changed,session:92}),/recorded agreement changed/);
  assert.throws(()=>reopened.restore(saved,{...fresh,projectId:"other"}),/match this plan/);
  assert.equal(reopened.list(fresh).length,2,"failed restore is atomic");
  assert.throws(()=>reopened.restore([...saved,...saved],fresh),/match this plan/);
  const bad = structuredClone(saved);bad[0].revision.items[0].unitMinor=NaN;
  assert.throws(()=>reopened.restore(bad,fresh));
});
