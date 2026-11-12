import test from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { revision } from "./fixtures.mjs";
import { evaluateRevision } from "../app/core.mjs";
import { proposeBudgetRescue } from "../app/budget-rescue.mjs";
import { counterofferFromPreference,preferenceRequest,preferenceFromRoles } from "../server/negotiation-preference.mjs";

const goal=(method,fixedItems=[],fixedPeople=[])=>({method,fixedItems,fixedPeople});
const overBudget=()=>{const source=revision();source.members.find(member=>member.id==="ben").budgetMinor=6000;return source;};

test("equal additional cost preserves coach and yields actual80/60/80, with exact item deltas",()=>{
  const source=overBudget(), snapshot=structuredClone(source);
  const result=counterofferFromPreference(source,goal("balanced_extra",["coach"]));
  assert.deepEqual(result.changes.map(row=>row.afterMinor),[8000,6000,8000]);
  assert.deepEqual(result.changes.map(row=>row.deltaMinor),[2000,-4000,2000]);
  assert.deepEqual(result.candidate.items[1],source.items[1]);
  assert.deepEqual(result.itemChanges.map(item=>item.itemId),["tickets"]);
  assert.equal(result.interpretation.capMinor,2000);
  assert.deepEqual(source,snapshot);
  assert.equal(evaluateRevision(result.candidate).feasible,true);
});
test("a protected person's actual item cents stay fixed, without adding excluded participants",()=>{
  const source=overBudget();source.members.find(member=>member.id==="asha").budgetMinor=11000;
  const result=counterofferFromPreference(source,goal("minimum_change",["coach"],["chen"]));
  assert.deepEqual(result.changes.map(row=>row.afterMinor),[10000,6000,6000]);
  for(const item of result.itemChanges)assert.equal(item.rows.find(row=>row.memberId==="chen").deltaMinor,0);
  const excluded=overBudget();excluded.items[0].weights.find(row=>row.memberId==="asha").units=0;
  assert.throws(()=>counterofferFromPreference(excluded,goal("balanced_extra",["coach"])),/cannot fit/);
});
test("clarification, impossible unchanged shares and the real omitted-coach response cannot become proposals",()=>{
  const source=overBudget();
  assert.throws(()=>counterofferFromPreference(source,goal("clarify")),/more specific/);
  assert.throws(()=>counterofferFromPreference(source,goal("balanced_extra",["tickets","coach"])),/cannot fit/);
  assert.throws(()=>counterofferFromPreference(source,{itemWeights:[{itemId:"tickets",weights:[
    {memberId:"asha",units:1},{memberId:"ben",units:1},{memberId:"chen",units:1}
  ]}],explanation:"Everyone is within budget."}),/supported preference/);
  const impossible=overBudget();impossible.members[0].budgetMinor=7999;
  assert.throws(()=>counterofferFromPreference(impossible,goal("minimum_change")),/fall short by \$0.01/);
});
test("balanced total is distinct from balanced additional cost and conserves exact cents",()=>{
  const source=revision();
  const result=counterofferFromPreference(source,goal("balanced_total",["coach"]));
  assert.deepEqual(result.changes.map(row=>row.afterMinor),[7333,7334,7333]);
  assert.equal(result.interpretation.capMinor,7334);
  assert.deepEqual(result.candidate.items[1],source.items[1]);
  assert.equal(result.totalMinor,22000);
});
test("frozen preferences use existing IDs and no model-supplied allocations or budgets",()=>{
  const source=overBudget();
  assert.throws(()=>counterofferFromPreference(source,goal("balanced_extra",["foreign"])),/do not match/);
  const request=preferenceRequest(source,"Split extra ticket costs equally; keep the coach unchanged.");
  assert.equal(request.schema.additionalProperties,false);
  assert.deepEqual(request.schema.required,["purchases","people"]);
  assert.equal(Object.hasOwn(request.prompt,"mustDecrease"),false);
  assert.equal(request.prompt.purchases.find(item=>item.id==="coach").name,"Coach");
  assert.deepEqual(request.schema.properties.purchases.properties.coach.properties.role.enum,["keep","unspecified"]);
});
test("small exact-cent oracle confirms the minimal possible maximum extra share",()=>{
  for(let total=3;total<=16;total++){
    const source=revision(1,{members:[{id:"a",name:"A",budgetMinor:total},{id:"b",name:"B",budgetMinor:1},{id:"c",name:"C",budgetMinor:total}],
      items:[{id:"meal",label:"Meal",unitMinor:total,quantity:1,weights:[{memberId:"a",units:1},{memberId:"b",units:3},{memberId:"c",units:1}]}]});
    const before=evaluateRevision(source);
    if(before.feasible)continue;
    const result=counterofferFromPreference(source,goal("balanced_extra"));
    let optimum=Infinity;
    for(let a=0;a<=total;a++)for(let b=0;b<=1;b++){
      const c=total-a-b;if(c<0)continue;
      optimum=Math.min(optimum,Math.max(0,a-before.members[0].amountMinor,c-before.members[2].amountMinor));
    }
    assert.equal(result.interpretation.capMinor,optimum,"total="+total);
  }
});
test("ordinary Budget Rescue still uses its original minimal-movement objective",()=>{
  const source=overBudget();
  const result=proposeBudgetRescue(source);
  assert.equal(result.status,"suggestion");
  assert.equal(result.movedMinor,4000);
  assert.equal(result.after.totalMinor,22000);
});

test("already under the common ceiling still repairs unequal one-cent floors",()=>{
  const source=revision(1,{members:[{id:"a",name:"A",budgetMinor:10},{id:"b",name:"B",budgetMinor:10},{id:"c",name:"C",budgetMinor:10}],
    items:[{id:"meal",label:"Meal",unitMinor:4,quantity:1,weights:[{memberId:"a",units:2},{memberId:"b",units:2},{memberId:"c",units:1}]}]});
  // The allocator gives2/1/1, already equal to a cent; a feasible but inequitable
  // 2/2/0 allocation is represented with positive eligibility for C by a tiny weight.
  source.items[0].weights=[{memberId:"a",units:200},{memberId:"b",units:200},{memberId:"c",units:1}];
  assert.deepEqual(evaluateRevision(source).members.map(member=>member.amountMinor),[2,2,0]);
  const result=counterofferFromPreference(source,goal("balanced_total"));
  const amounts=result.changes.map(row=>row.afterMinor);
  assert.deepEqual([...amounts].sort((a,b)=>a-b),[1,1,2]);
});


test("the actual fixed-hotel failure explains its unavoidable lower bound before an invented person constraint",()=>{
  const source=revision(1,{
    members:[{id:"alma",name:"Alma",budgetMinor:4500},{id:"beau",name:"Beau",budgetMinor:6000},{id:"cleo",name:"Cleo",budgetMinor:4500}],
    items:[{id:"hotel",label:"hotel",unitMinor:7000,quantity:1,weights:[{memberId:"alma",units:5000},{memberId:"beau",units:1500},{memberId:"cleo",units:500}]},
      {id:"food",label:"food",unitMinor:3000,quantity:1,weights:[{memberId:"alma",units:2000},{memberId:"beau",units:500},{memberId:"cleo",units:500}]}]
  });
  assert.throws(()=>counterofferFromPreference(source,goal("balanced_extra",["hotel"],["alma"])),{
    message:"Alma cannot fit the $45.00 limit: unchanged hotel shares already total $50.00."
  });
  assert.throws(()=>counterofferFromPreference(source,goal("balanced_extra",[],["alma"])),{
    message:"Keeping Alma's current shares unchanged cannot fit the $45.00 limit: they total $70.00."
  });
});


test("explicit roles derive helper exclusions from exact recorded limits, without freezing the person to reduce",()=>{
  const source=overBudget();source.members[0].budgetMinor=10000;
  const request="Reduce Ben to his limit. Asha covers the extra ticket cost. Keep coach unchanged.";
  const roles={purchases:{tickets:{role:"unspecified",quote:""},coach:{role:"keep",quote:"Keep coach unchanged"}},
    people:{asha:{role:"help",quote:"Asha covers the extra ticket cost"},ben:{role:"reduce",quote:"Reduce Ben to his limit"},chen:{role:"unspecified",quote:""}}};
  const result=preferenceFromRoles(source,request,"balanced_extra",roles);
  assert.equal(result.error,null);
  assert.deepEqual(result.preference,{method:"balanced_extra",fixedItems:["coach"],fixedPeople:["chen"]});
  assert.deepEqual(counterofferFromPreference(source,result.preference).changes.map(row=>row.afterMinor),[10000,6000,6000]);
});
test("a model cannot use the coach instruction to ground unchanged tickets or an invented quote to freeze Ben",()=>{
  const source=overBudget(),request="Reduce Ben to his limit. Split the extra ticket cost equally. Keep coach unchanged.";
  const roles={purchases:{tickets:{role:"keep",quote:"Keep coach unchanged"},coach:{role:"unspecified",quote:""}},
    people:{asha:{role:"unspecified",quote:""},ben:{role:"keep",quote:"Keep Ben unchanged"},chen:{role:"unspecified",quote:""}}};
  const result=preferenceFromRoles(source,request,"balanced_extra",roles);
  assert.match(result.error,/Ticket.*not supported/i);
  assert.deepEqual(result.preference.fixedItems,["tickets"]);
  assert.deepEqual(result.preference.fixedPeople,["ben"]);
  roles.purchases.tickets={role:"unspecified",quote:""};
  assert.match(preferenceFromRoles(source,request,"balanced_extra",roles).error,/Ben.*not supported/);
});

test("a missing coach quote links to its sole original clause without altering the model output",()=>{
  const source=overBudget();source.items[0].label="Event tickets";source.items[1].label="Shared coach";
  const request="Reduce Ben to his recorded limit. Split the extra ticket cost equally between Asha and Chen. Keep the coach unchanged.";
  const roles={purchases:{tickets:{role:"unspecified",quote:""},coach:{role:"keep",quote:""}},
    people:{asha:{role:"help",quote:"Split the extra ticket cost equally between Asha and Chen"},ben:{role:"reduce",quote:"Reduce Ben to his recorded limit"},chen:{role:"help",quote:"Split the extra ticket cost equally between Asha and Chen"}}};
  const original=JSON.stringify(roles);
  const reading=preferenceFromRoles(source,request,"balanced_extra",roles);
  assert.equal(reading.error,null);
  assert.equal(JSON.stringify(roles),original);
  assert.equal(reading.evidence.purchases.coach.quote,"");
  assert.deepEqual(reading.evidence.sourceLinkedQuotes,[{kind:"purchases",id:"coach",quote:"Keep the coach unchanged."}]);
  assert.deepEqual(counterofferFromPreference(source,reading.preference).changes.map(row=>row.afterMinor),[8000,6000,8000]);
  assert.match(preferenceFromRoles(source,request+" The coach can also change.","balanced_extra",roles).error,/not supported/);
});


test.skip("original semicolon/period variation preserves the exact volunteer allocation without changing raw model evidence",()=>{
  const original=JSON.parse(readFileSync(new URL("../docs/evidence/model-negotiation/independent03/results.json",import.meta.url),"utf8")).results[0];
  const roles=original.result.body.modelEvidence;
  const snapshot=JSON.stringify(roles);
  const reading=preferenceFromRoles(original.input.revision,original.input.goal,original.result.body.modelInterpretation.method,roles);
  assert.equal(reading.error,null);
  assert.equal(JSON.stringify(roles),snapshot);
  const answer=counterofferFromPreference(original.input.revision,reading.preference);
  assert.deepEqual(answer.changes.map(row=>row.afterMinor),original.expected.expected);
  const actual=evaluateRevision(answer.candidate);
  assert.deepEqual(actual.items.map(item=>original.input.revision.members.map(person=>item.allocations.find(row=>row.memberId===person.id).minor)),original.expected.expectedItems);
  const fabricated=structuredClone(roles);fabricated.people.ivo.quote="Ivo will NOT take all the excess.";
  assert.match(preferenceFromRoles(original.input.revision,original.input.goal,original.result.body.modelInterpretation.method,fabricated).error,/not supported/);
});
