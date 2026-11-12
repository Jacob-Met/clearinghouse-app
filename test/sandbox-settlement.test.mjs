import test from "node:test";
import assert from "node:assert/strict";
import { matchesPreparedSandboxOrder, summarizeSandboxChecks, checksFromGroupReconciliation } from "../app/sandbox-settlement.mjs";

const members=[{id:"asha",amountMinor:6000},{id:"ben",amountMinor:10000},{id:"chen",amountMinor:6000},{id:"zero",amountMinor:0}];
const entry={id:"asha",amountMinor:6000,amount:"60.00",orderId:"ORDERTEST001"};
const captured={memberId:"asha",revisionId:"revision-one",orderId:"ORDERTEST001",amount:"60.00",status:"COMPLETED",captured:true,captureId:"CAPTURETEST001",captureStatus:"COMPLETED"};

test("only an exact matching member, revision, amount, capture ID and completed capture can become verified",()=>{
  assert.equal(matchesPreparedSandboxOrder(entry,captured,"revision-one"),true);
  for(const changed of [{memberId:"ben"},{revisionId:"revision-two"},{orderId:"FORGEDORDER"},{amount:"61.00"},
    {status:"APPROVED"},{captureStatus:"PENDING"},{captureId:null},{captured:"true"}])
    assert.equal(matchesPreparedSandboxOrder(entry,{...captured,...changed},"revision-one"),false,JSON.stringify(changed));
  assert.equal(matchesPreparedSandboxOrder(entry,{...captured,captured:false,status:"APPROVED",captureId:null,captureStatus:null},"revision-one"),true);
  assert.equal(matchesPreparedSandboxOrder(entry,{...captured,captured:false,status:"COMPLETED",captureId:null,captureStatus:"PENDING"},"revision-one"),true);
});

test("one completed capture never implies other unchecked members paid",()=>{
  const checks=new Map([["asha",{amountMinor:6000,captured:true}],["ben",{amountMinor:10000,captured:false}]]);
  assert.deepEqual(summarizeSandboxChecks(members,checks),{payable:3,inspected:2,captured:1,totalMinor:6000});
  assert.deepEqual(summarizeSandboxChecks(members,new Map()),{payable:3,inspected:0,captured:0,totalMinor:0});
});

test("an amended obligation cannot inherit earlier local payment evidence",()=>{
  const checks=new Map([["asha",{amountMinor:6000,captured:true}],["ben",{amountMinor:10000,captured:true}]]);
  const amended=members.map(x=>x.id==="asha"?{...x,amountMinor:7000}:x);
  assert.deepEqual(summarizeSandboxChecks(amended,checks),{payable:3,inspected:1,captured:1,totalMinor:10000});
  assert.deepEqual(summarizeSandboxChecks([{id:"zero",amountMinor:0}],checks),{payable:0,inspected:0,captured:0,totalMinor:0});
});

test("verified totals use exact cents, not rounded floating point dollars",()=>{
  const odd=[{id:"a",amountMinor:1999},{id:"b",amountMinor:2001}];
  const checks=new Map([["a",{amountMinor:1999,captured:true}],["b",{amountMinor:2001,captured:true}]]);
  assert.deepEqual(summarizeSandboxChecks(odd,checks),{payable:2,inspected:2,captured:2,totalMinor:4000});
});

test("a group check updates the same headline evidence as individual checks, including external captures",()=>{
  const reconciliation={revisionId:"revision-one",members:[
    captured,
    {...captured,memberId:"ben",amount:"100.00",orderId:"ORDERTEST002",captured:false,captureId:null,captureStatus:"PENDING"},
    {memberId:"chen",amount:"60.00",status:"UNKNOWN",captured:false,captureStatus:null},
    {memberId:"zero",amount:"0.00",status:"NO_OBLIGATION",captured:false}
  ]};
  const checked=checksFromGroupReconciliation(members,reconciliation,"revision-one");
  assert.deepEqual(summarizeSandboxChecks(members,checked),{payable:3,inspected:2,captured:1,totalMinor:6000});
  assert.equal(checked.has("chen"),false,"an unavailable provider response cannot retain a prior paid flag");
  assert.equal(checksFromGroupReconciliation(members,reconciliation,"revision-two").size,0,"a new revision starts without inherited payment evidence");
  const changed=members.map(m=>m.id==="asha"?{...m,amountMinor:4000}:m);
  assert.equal(checksFromGroupReconciliation(changed,reconciliation,"revision-one").has("asha"),false,"old amount cannot become payment for an amended share");
});
