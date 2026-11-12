import test from "node:test";
import assert from "node:assert/strict";
import {createProject,amendProject,approveProject,expectedState,replayProject} from "../app/core.mjs";
import {creation,revision,at} from "./fixtures.mjs";
import {paymentSettlement,retainedPayment} from "../app/payment-settlement.mjs";

function changedPlan(){
 let project=createProject(creation());
 for(const [i,memberId] of ["asha","ben","chen"].entries())
  project=approveProject(project,expectedState(project),{eventId:"agree-old-"+memberId,at:at(i+3),memberId});
 project=amendProject(project,expectedState(project),{eventId:"change",at:at(10),revision:revision(2,{
  members:[{id:"asha",name:"Asha",budgetMinor:20000},{id:"ben",name:"Ben",budgetMinor:20000}],
  items:[{id:"new-event",label:"Revised event",unitMinor:16000,quantity:1,weights:[{memberId:"asha",units:1},{memberId:"ben",units:3}]}]
 })});
 for(const [i,memberId] of ["asha","ben"].entries())
  project=approveProject(project,expectedState(project),{eventId:"agree-new-"+memberId,at:at(i+11),memberId});
 return replayProject(project);
}
const paid=(memberId,amount)=>({memberId,memberName:memberId,revisionId:"r1",ordinal:1,orderId:"ORDER-"+memberId,
 captureId:"CAPTURE-"+memberId,amount,status:"COMPLETED",captureStatus:"COMPLETED",captured:true,refunds:[],refundsKnown:false});
const refund=(captureId,amountMinor)=>({id:"REFUND-asha",status:"COMPLETED",amountMinor,links:[{rel:"up",href:"https://api-m.sandbox.paypal.com/v2/payments/captures/"+captureId}]});
const original=()=>[paid("asha","60.00"),paid("ben","100.00"),paid("chen","60.00")];

test("a changed event retains each person's payment and exposes only net top-up or return",()=>{
 const result=paymentSettlement(changedPlan(),original());
 assert.equal(result.known,true);assert.equal(result.settled,false);
 assert.equal(result.obligationMinor,16000);assert.equal(result.heldMinor,22000);
 assert.equal(result.topUpMinor,2000);assert.equal(result.refundDueMinor,8000);
 assert.equal(result.heldMinor+result.topUpMinor-result.refundDueMinor,result.obligationMinor);
 assert.deepEqual(result.members.map(({memberId,creditMinor,topUpMinor,refundDueMinor,current})=>({memberId,creditMinor,topUpMinor,refundDueMinor,current})),[
  {memberId:"asha",creditMinor:4000,topUpMinor:0,refundDueMinor:2000,current:true},
  {memberId:"ben",creditMinor:10000,topUpMinor:2000,refundDueMinor:0,current:true},
  {memberId:"chen",creditMinor:0,topUpMinor:0,refundDueMinor:6000,current:false}
 ]);
});

test("unknown or pending money does not become a new amount due and known captures remain visible",()=>{
 const orders=original();orders.push({...paid("ben","20.00"),orderId:"ORDER-ben-new",captureId:null,status:"UNKNOWN",captureStatus:null,captured:false});
 const result=paymentSettlement(changedPlan(),orders),ben=result.members.find(x=>x.memberId==="ben");
 assert.equal(result.known,false);assert.equal(result.topUpMinor,null);assert.equal(result.refundDueMinor,null);
 assert.equal(result.knownHeldMinor,22000);assert.equal(ben.knownHeldMinor,10000);
 assert.equal(ben.heldMinor,null);assert.equal(ben.topUpMinor,null);assert.equal(result.settled,false);
 orders[3]={...orders[3],status:"COMPLETED",captureStatus:"PENDING"};
 assert.equal(paymentSettlement(changedPlan(),orders).members.find(x=>x.memberId==="ben").topUpMinor,null);
});

test("partial refund requires explicit matching refund amounts; missing or conflicting observations block credit",()=>{
 const order={...paid("asha","60.00"),captured:false,captureStatus:"PARTIALLY_REFUNDED"};
 assert.equal(retainedPayment(order).known,false);
 order.refundsKnown=true;order.refunds=[refund("CAPTURE-asha",2000)];
 assert.deepEqual(retainedPayment(order),{known:true,amountMinor:6000,heldMinor:4000,refundedMinor:2000});
 assert.equal(retainedPayment({...order,refundUncertain:true}).known,false);
 assert.equal(retainedPayment({...order,refunds:[...order.refunds,...order.refunds]}).known,false);
 assert.equal(retainedPayment({...order,refunds:[refund("CAPTURE-asha",6000)]}).known,false);
 assert.equal(retainedPayment({...paid("asha","60.00"),refunds:order.refunds}).known,false);
});

test("a fully refunded departure and verified top-up reconcile without counting provider records twice",()=>{
 const orders=original();
 orders[0]={...orders[0],captured:false,captureStatus:"PARTIALLY_REFUNDED",refundsKnown:true,refunds:[refund("CAPTURE-asha",2000)]};
 orders[2]={...orders[2],captured:false,captureStatus:"REFUNDED"};
 orders.push({...paid("ben","20.00"),orderId:"ORDER-ben-extra",captureId:"CAPTURE-ben-extra",revisionId:"r2",ordinal:2});
 const result=paymentSettlement(changedPlan(),[...orders,structuredClone(orders[0])]);
 assert.equal(result.settled,true);assert.equal(result.heldMinor,16000);assert.equal(result.topUpMinor,0);assert.equal(result.refundDueMinor,0);
 assert.throws(()=>paymentSettlement(changedPlan(),[...orders,{...orders[0],amount:"99.99"}]),/disagree/);
 assert.throws(()=>paymentSettlement(changedPlan(),[...orders,{...orders[0],orderId:"OTHER-ORDER"}]),/conflicting/);
 assert.throws(()=>paymentSettlement(changedPlan(),[paid("foreign","1.00")]),/outside/);
});
