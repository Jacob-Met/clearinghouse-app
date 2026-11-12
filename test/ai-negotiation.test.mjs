import test from "node:test";
import assert from "node:assert/strict";
import { validateSuggestion, SuggestionError } from "../app/ai-negotiation.mjs";
import { evaluateRevision } from "../app/core.mjs";
import { revision } from "./fixtures.mjs";

const proposal = () => ({
  explanation: "Ben has a lower limit: move some ticket and coach weight to the other travelers.",
  itemWeights: [
    {itemId:"tickets", weights:[{memberId:"asha",units:2},{memberId:"ben",units:1},{memberId:"chen",units:1}]},
    {itemId:"coach", weights:[{memberId:"asha",units:1},{memberId:"ben",units:1},{memberId:"chen",units:4}]}
  ]
});
test("model-suggested weights change a real draft but preserve exact cents and inputs",()=>{
  const start=revision(), snapshot=JSON.stringify(start);
  const result=validateSuggestion(start,proposal());
  assert.equal(JSON.stringify(start),snapshot);
  assert.equal(result.totalMinor,22000);
  assert.deepEqual(result.changes.map(c=>c.afterMinor),[9000,5000,8000]);
  assert.equal(evaluateRevision(result.candidate).feasible,true);
  assert.deepEqual(result.candidate.members,start.members);
  assert.equal(result.candidate.items[0].unitMinor,4000);
  assert.equal(result.candidate.items[0].quantity,4);
  assert.match(result.disclosure,/No consent/);
});
test("unknown identities, missing items, duplicate weights and negative units fail closed",()=>{
  for(const mutate of [
    x=>x.itemWeights.pop(),
    x=>x.itemWeights[0].itemId="foreign",
    x=>x.itemWeights[0].weights[0].memberId="intruder",
    x=>x.itemWeights[0].weights[0].units=-1,
    x=>x.itemWeights[0].weights[1].memberId="asha",
    x=>x.itemWeights[0].weights[0].units=Number.MAX_SAFE_INTEGER+1
  ]) {
    const x=proposal(); mutate(x);
    assert.throws(()=>validateSuggestion(revision(),x),SuggestionError);
  }
});
test("over-budget, zero-sum and unchanged proposals do not masquerade as usable",()=>{
  const budgetBreach=proposal();
  budgetBreach.itemWeights[0].weights=[{memberId:"asha",units:0},{memberId:"ben",units:1},{memberId:"chen",units:0}];
  assert.throws(()=>validateSuggestion(revision(),budgetBreach),/budget/);
  const zero=proposal(); zero.itemWeights[0].weights.forEach(w=>w.units=0);
  assert.throws(()=>validateSuggestion(revision(),zero),/allocation rules/);
  const unchanged=proposal(); unchanged.itemWeights=revision().items.map(i=>({itemId:i.id,weights:i.weights}));
  assert.throws(()=>validateSuggestion(revision(),unchanged),/different split/);
});
