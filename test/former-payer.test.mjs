import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createProject,amendProject,expectedState,replayProject,exportProject} from "../app/core.mjs";
import {creation,revision,at} from "./fixtures.mjs";
import {recipientMembers,recipientPacket,participantPacket,participantReviewHtml} from "../app/participant-review.mjs";
import {personalPaymentContext} from "../app/personal-payment-context.mjs";
import {createParticipation} from "../server/participation.mjs";
import {groupTabFontCss} from "../app/group-tab-font.mjs";
function removed(){
 let project=createProject(creation()),next=revision(2);
 next.members=next.members.filter(m=>m.id!=="asha");
 for(const item of next.items)item.weights=item.weights.filter(w=>w.memberId!=="asha");
 next.note="PRIVATE CURRENT DISCUSSION";
 project=amendProject(project,expectedState(project),{eventId:"removed",at:at(4),revision:next});
 return {project,state:replayProject(project)};
}
function observed(state){
 return {projectId:state.project.projectId,revisionId:state.current.revisionId,checkedAt:"2026-11-11T12:00:00.000Z",orders:[
 {memberId:"asha",memberName:"Asha",revisionId:"r1",ordinal:1,amount:"60.00",orderId:"ASHAORDER01",status:"COMPLETED",captured:true,captureStatus:"COMPLETED",captureId:"ASHACAPTURE01"},
 {memberId:"ben",memberName:"PRIVATE BEN",revisionId:"r1",ordinal:1,amount:"100.00",orderId:"PRIVATEBENORDER",status:"CREATED"}
 ]};
}
test("former payer record retains their own capture and offers no new share or response",()=>{
 const {state}=removed(),packet=recipientPacket(state,"asha");
 assert.equal(packet.removed,true);
 assert.deepEqual(recipientMembers(state).map(m=>[m.id,m.removed]),[["ben",false],["chen",false],["asha",true]]);
 assert.throws(()=>participantPacket(state,"asha"),/not in the current/);
 assert.throws(()=>recipientPacket(state,"unknown"),/no recorded history/);
 const context=personalPaymentContext(state,"asha",observed(state));
 const html=participantReviewHtml(packet,{paymentContext:context,payerHandoff:{url:"https://www.sandbox.paypal.com/checkoutnow?token=BAD"}}).replace(groupTabFontCss,"");
 assert.match(html,/No current share/);assert.match(html,/\$60.00/);assert.match(html,/Completed capture observed/);
 assert.doesNotMatch(html,/id='response-form'|id='packet-data'|<script>|PRIVATE BEN|PRIVATEBENORDER|PRIVATE CURRENT DISCUSSION|token=BAD|Your proposed share|Within your/);
 assert.throws(()=>personalPaymentContext(state,"unknown",observed(state)),/no recorded history/);
 const unavailable=participantReviewHtml(packet,{paymentContext:personalPaymentContext(state,"asha",null)}).replace(groupTabFontCss,"");
 assert.match(unavailable,/could not be checked/);assert.doesNotMatch(unavailable,/Completed capture observed/);
});
test("private former-payer invitation is read-only, scoped and retired when the group changes",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"former-payer-"));
 try{
  const {project,state}=removed();
  const api=createParticipation({storagePath:join(dir,"journal.json"),paymentReview:async(text,id)=>{
   assert.equal(id,"asha");return {paymentContext:personalPaymentContext(replayProject(JSON.parse(text)),id,observed(state)),
    payerHandoff:{url:"https://www.sandbox.paypal.com/checkoutnow?token=BAD"}};
  }});
  const {ownerToken}=await api.create(exportProject(project));
  const invite=await api.publish(ownerToken,exportProject(project),"asha"),token=invite.path.split("/").pop();
  const html=(await api.review(token)).replace(groupTabFontCss,"");
  assert.match(html,/No current share/);assert.doesNotMatch(html,/id='response-form'|token=BAD/);
  assert.equal(await api.payer(token),null);
  await assert.rejects(api.reply(token,JSON.stringify({format:"clearinghouse-participant-response/v4",projectId:state.project.projectId,revisionId:state.current.revisionId,ordinal:2,memberId:"asha",amountMinor:0,answer:"agree",note:"",createdAt:at(5),reviewedTerms:"",proposedBudgetMinor:null,proposedExcludedItemIds:null})),/not in the current/);
  const next=revision(3);const rejoined=amendProject(project,expectedState(project),{eventId:"rejoin",at:at(6),revision:next});
  await api.publish(ownerToken,exportProject(rejoined));
  const changed=(await api.review(token)).replace(groupTabFontCss,"");
  assert.match(changed,/has not shared the new proposal/);
  assert.doesNotMatch(changed,/id='review-current-proposal'|id='response-form'|token=BAD/);
  await assert.rejects(api.continueReview(token),e=>e.status===409);
  assert.equal(recipientPacket(replayProject(rejoined),"asha").removed,undefined);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("former payer sees only their checked return amount, completed state or uncertainty",()=>{
 const {state}=removed(),history=observed(state),packet=recipientPacket(state,"asha");
 const position={projectId:state.project.projectId,revisionId:state.current.revisionId,checkedAt:history.checkedAt,
  paymentPlanCurrent:null,member:{memberId:"asha",current:false,obligationMinor:0,known:true,heldMinor:6000,
   creditMinor:0,topUpMinor:0,refundDueMinor:6000,knownRefundedMinor:0}};
 const render=value=>participantReviewHtml(packet,{paymentContext:personalPaymentContext(state,"asha",history,value)}).replace(groupTabFontCss,"");
 const waiting=render(position);
 assert.match(waiting,/Return to you/);assert.match(waiting,/Waiting to be returned/);
 assert.doesNotMatch(waiting,/PRIVATE BEN|PRIVATEBENORDER|id='response-form'|class='payer-link'/);
 const partial=render({...position,member:{...position.member,heldMinor:4000,refundDueMinor:4000,knownRefundedMinor:2000}});
 assert.match(partial,/\$40.00/);assert.match(partial,/\$20.00 refunded so far/);
 const complete=render({...position,member:{...position.member,heldMinor:0,refundDueMinor:0,knownRefundedMinor:6000}});
 assert.match(complete,/Return completed/);assert.match(complete,/PayPal reports this refund completed/);
 const uncertain=render({...position,member:{...position.member,known:false,heldMinor:null,refundDueMinor:null}});
 assert.match(uncertain,/Status unavailable/);assert.doesNotMatch(uncertain,/Waiting to be returned|Return completed/);
 for(const bad of [{...position,revisionId:"other"},{...position,member:{...position.member,memberId:"ben"}},{...position,member:{...position.member,current:true}}])
  assert.doesNotMatch(render(bad),/Return to you|Return completed/);
});
