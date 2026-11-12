import test from "node:test";
import assert from "node:assert/strict";
import {createProject,amendProject,expectedState,replayProject} from "../app/core.mjs";
import {creation,revision,at} from "./fixtures.mjs";
import {participantPacket,participantReviewHtml,reviewedTerms} from "../app/participant-review.mjs";
import {personalPaymentContext,personalPaymentContextHtml} from "../app/personal-payment-context.mjs";

function example(){
 let p=createProject(creation()); const next=revision(2);next.items[0].unitMinor=2000;
 p=amendProject(p,expectedState(p),{eventId:"change",at:at(12),revision:next});
 const state=replayProject(p);
 const history={projectId:state.project.projectId,revisionId:state.current.revisionId,checkedAt:"2026-11-10T17:00:00.000Z",orders:[
 {memberId:"asha",memberName:"Asha",revisionId:"r1",ordinal:1,amount:"60.00",orderId:"ASHAORDER01",captured:true,captureStatus:"COMPLETED",captureId:"ASHACAPTURE01",status:"COMPLETED"},
 {memberId:"ben",memberName:"PRIVATE BEN",revisionId:"r1",ordinal:1,amount:"100.00",orderId:"PRIVATEBENORDER",status:"CREATED",budget:11000}
 ]};return {state,history};
}
test("personal export keeps captured60 separate from proposed40 and excludes other people/provider fields",()=>{
 const {state,history}=example();const packet=participantPacket(state,"asha");
 assert.equal(packet.amountMinor,4000);
 const context=personalPaymentContext(state,"asha",history);
 const html=participantReviewHtml(packet,{paymentContext:context});
 assert.match(html,/\$60.00/);assert.match(html,/\$40.00/);assert.match(html,/Completed capture observed/);
 assert.match(html,/not a calculation of what remains to pay/);assert.match(html,/10 Nov 2026, 17:00 UTC/);
 assert.doesNotMatch(html,/PRIVATE BEN|PRIVATEBENORDER|11000/);
 assert.deepEqual(Object.keys(context.orders[0]).sort(),["amount","captureId","captureStatus","captured","completedRefunds","orderId","ordinal","status"].sort());
 assert.equal(reviewedTerms(packet),reviewedTerms(participantPacket(state,"asha")),"observations must not silently change proposal approval terms");
});
test("wrong source or unavailable observation never becomes no earlier payments",()=>{
 const {state,history}=example();
 for(const bad of [null,{...history,projectId:"different"},{...history,revisionId:"retired"},{...history,checkedAt:null}]){
  assert.match(personalPaymentContextHtml(personalPaymentContext(state,"asha",bad)),/could not be checked/);
 }
 assert.throws(()=>personalPaymentContext(state,"asha",{...history,orders:[{...history.orders[0],amount:"40.00"}]}),/does not match/);
});
test("unknown and partial refund preserve original amount without implying completed payment or refund balance",()=>{
 const {state,history}=example();
 for(const [status,captureStatus,text] of [["UNKNOWN",null,"Status unavailable"],["COMPLETED","PARTIALLY_REFUNDED","remaining amount needs"]]){
  const row={...history.orders[0],status,captureStatus,captured:false};
  const html=personalPaymentContextHtml(personalPaymentContext(state,"asha",{...history,orders:[row]}));
  assert.match(html,new RegExp(text));assert.match(html,/\$60.00/);assert.doesNotMatch(html,/Completed capture observed/);
 }
});
test("HTML escapes payment references and excludes supplied external links",()=>{
 const {state,history}=example();history.orders[0].orderId="<script>oops</script>";history.orders[0].approveUrl="https://evil.test";
 const html=personalPaymentContextHtml(personalPaymentContext(state,"asha",history));
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|evil.test/);
});

const refund = (id="REFUND001", value="20.00", status="COMPLETED") => ({
 id, status, amount:{currency_code:"USD",value},
 links:[{rel:"up",href:"https://api.sandbox.paypal.com/v2/payments/captures/ASHACAPTURE01"}],
 privateProviderField:"DO NOT EXPORT"
});
test("recipient sees exact completed refund tied to the original capture, without current-proposal credit",()=>{
 const {state,history}=example();
 history.orders[0]={...history.orders[0],captured:false,captureStatus:"PARTIALLY_REFUNDED",refunds:[refund()]};
 history.orders[1].refunds=[refund("PRIVATEBENREFUND","99.00")];
 const context=personalPaymentContext(state,"asha",history);
 assert.deepEqual(context.orders[0].completedRefunds,[{id:"REFUND001",amount:"20.00"}]);
 const packet=participantPacket(state,"asha"),before=reviewedTerms(packet);
 const html=participantReviewHtml(packet,{paymentContext:context});
 assert.match(html,/\$20\.00 refunded/);assert.match(html,/\$60\.00/);assert.match(html,/\$40\.00/);
 assert.match(html,/Payments are not deducted from the proposed share/);assert.match(html,/Refund arrival is not verified/);
 assert.doesNotMatch(html,/DO NOT EXPORT|PRIVATEBENREFUND|PRIVATE BEN|api\.sandbox\.paypal\.com/);
 assert.equal(reviewedTerms(packet),before);
});
test("pending and failed refunds are not shown as completed, and unknown order status never promotes stale amounts",()=>{
 const {state,history}=example();
 const row={...history.orders[0],captured:false,captureStatus:"PARTIALLY_REFUNDED",
  refunds:[refund(),refund("PENDING01","10.00","PENDING"),refund("FAILED001","5.00","FAILED")]};
 let context=personalPaymentContext(state,"asha",{...history,orders:[row]});
 assert.deepEqual(context.orders[0].completedRefunds,[{id:"REFUND001",amount:"20.00"}]);
 context=personalPaymentContext(state,"asha",{...history,orders:[{...row,status:"UNKNOWN"}]});
 assert.deepEqual(context.orders[0].completedRefunds,[]);
 assert.doesNotMatch(personalPaymentContextHtml(context),/\$20\.00 refunded/);
});
test("wrong capture, currency, duplicate IDs, impossible totals and malformed amounts cannot become refund facts",()=>{
 const {state,history}=example();
 const variants=[
 [{...refund(),links:[{rel:"up",href:"https://api.sandbox.paypal.com/v2/payments/captures/OTHER_CAPTURE"}]}],
 [{...refund(),amount:{currency_code:"EUR",value:"20.00"}}],
 [refund(),refund()],
 [refund("REFUND001","40.00"),refund("REFUND002","30.00")],
 [refund("REFUND001","20.001")],
 [{...refund(),amount:{currency_code:"USD",value:["20.00"]}}],
 [{...refund(),links:{rel:"up"}}],
 [{...refund(),links:[{rel:"up",href:"http://api.sandbox.paypal.com/v2/payments/captures/ASHACAPTURE01"}]}],
 [{...refund(),links:[{rel:"up",href:"https://api.sandbox.paypal.com.evil.test/v2/payments/captures/ASHACAPTURE01"}]}]
 ];
 for(const refunds of variants){
  const row={...history.orders[0],captured:false,captureStatus:"PARTIALLY_REFUNDED",refunds};
  const context=personalPaymentContext(state,"asha",{...history,orders:[row]});
  assert.deepEqual(context.orders[0].completedRefunds,[]);
  const html=personalPaymentContextHtml(context);
  assert.match(html,/remaining amount needs/);assert.doesNotMatch(html,/refunded<\/strong>/);
 }
});

test("historical return is explicit during an unavailable check and cannot become current payment",()=>{
 const {state,history}=example(),row={...history.orders[0],status:"UNKNOWN",captured:false,captureId:null,captureStatus:null};
 row.previousObservation={projectId:state.project.projectId,memberId:row.memberId,orderId:row.orderId,revisionId:row.revisionId,ordinal:row.ordinal,
   amountMinor:6000,captureId:"ASHACAPTURE01",captureStatus:"REFUNDED",heldMinor:0,refundedMinor:6000,checkedAt:"2026-11-10T16:00:00.000Z"};
 const context=personalPaymentContext(state,"asha",{...history,orders:[row]}),html=personalPaymentContextHtml(context);
 assert.equal(context.orders[0].captured,false);assert.equal(context.orders[0].status,"UNKNOWN");
 assert.ok(html.includes("$60.00 previously confirmed returned"));assert.match(html,/Earlier check: 10 Nov 2026, 16:00 UTC/);
 assert.match(html,/Current status is unavailable/);assert.doesNotMatch(html,/Completed capture observed/);
 for(const patch of [{projectId:"other"},{memberId:"ben"},{orderId:"OTHERORDER01"},{captureId:"bad"},
   {revisionId:"other"},{ordinal:9},{amountMinor:4000},{refundedMinor:7000},{heldMinor:100},{checkedAt:"invalid"}]){
  const bad={...row,previousObservation:{...row.previousObservation,...patch}};
  const rejected=personalPaymentContext(state,"asha",{...history,orders:[bad]});
  assert.equal(rejected.orders[0].previousObservation,undefined);
  assert.doesNotMatch(personalPaymentContextHtml(rejected),/previously confirmed returned/);
 }
});
