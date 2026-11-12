import test from 'node:test';
import assert from 'node:assert/strict';
import {createProject,replayProject,exportProject,importProject,approveProject,amendProject,expectedState} from '../app/core.mjs';
import {participantPacket,participantReviewHtml,reviewedTerms,parseParticipantResponse} from '../app/participant-review.mjs';
import {proposeBudgetRescue} from '../app/budget-rescue.mjs';
import {latestChangeBrief,changeBriefHtml} from '../app/change-brief.mjs';
import {checkoutPlan} from '../app/paypal-sandbox.mjs';
import {produceAiSuggestion} from '../server/ai-suggest.mjs';
import {creation,revision,at} from './fixtures.mjs';
const picnic=()=>createProject({...creation(),title:'Sunday picnic',revision:revision(1,{members:[{id:'inez',name:'Inez',budgetMinor:2000},{id:'omar',name:'Omar',budgetMinor:null},{id:'pavel',name:'Pavel',budgetMinor:null}],items:[{id:'hamper',label:'Picnic hamper',unitMinor:3875,quantity:1,weights:['inez','omar','pavel'].map(memberId=>({memberId,units:1}))}]})});
const response=(p,answer='agree')=>JSON.stringify({format:p.format,projectId:p.projectId,revisionId:p.revisionId,ordinal:p.ordinal,memberId:p.memberId,amountMinor:p.amountMinor,reviewedTerms:reviewedTerms(p),answer,proposedBudgetMinor:null,proposedExcludedItemIds:null,note:'Please confirm my limit.',createdAt:at(5)});
test('unknown limits preserve exact authored allocation and portable history without approval or checkout',()=>{
 const project=picnic(),state=replayProject(importProject(exportProject(project)));
 assert.deepEqual(state.evaluation.members.map(m=>[m.amountMinor,m.overMinor,m.budgetStatus]),[[1292,0,'within'],[1292,null,'unknown'],[1291,null,'unknown']]);
 assert.equal(state.evaluation.totalMinor,3875);assert.equal(state.evaluation.budgetsKnown,false);assert.equal(state.evaluation.feasible,false);assert.equal(state.evaluation.agreementRecorded,false);
 assert.equal(state.current.members[1].budgetMinor,null);
 for(const memberId of ['inez','omar','pavel'])assert.throws(()=>approveProject(project,expectedState(project),{eventId:'approval',at:at(3),memberId}),e=>e.code==='unknown_limits');
 assert.throws(()=>checkoutPlan(exportProject(project)));assert.equal(proposeBudgetRescue(state.current).status,'unknown-limits');
});
test('recipient unknown is neither zero nor within limit; known recipient also cannot approve unresolved group',()=>{
 const state=replayProject(picnic());
 for(const id of ['inez','omar']){const packet=participantPacket(state,id),html=participantReviewHtml(packet);assert.match(html,/value='agree' disabled/);assert.match(html,/spending limit has not been provided/);assert.throws(()=>parseParticipantResponse(state,response(packet)),/still unknown/);assert.equal(parseParticipantResponse(state,response(packet,'decline')).response.answer,'decline');}
 const html=participantReviewHtml(participantPacket(state,'omar'));assert.match(html,/Not provided/);assert.match(html,/Budget check unresolved/);assert.doesNotMatch(html,/Within your limit|\$0\.00/);
});
test('confirming limits records a new reviewable revision; later unknown retires declarations and brief distinguishes unresolved',()=>{
 let project=picnic();const next=structuredClone(replayProject(project).current);next.ordinal=2;next.revisionId='confirmed';next.createdAt=at(8);next.members[1].budgetMinor=1500;next.members[2].budgetMinor=1500;
 project=amendProject(project,expectedState(project),{eventId:'resolve',at:at(8),revision:next});assert.equal(replayProject(project).evaluation.feasible,true);
 for(const [i,memberId] of ['inez','omar','pavel'].entries())project=approveProject(project,expectedState(project),{eventId:'a'+i,at:at(10+i),memberId});assert.equal(replayProject(project).evaluation.agreementRecorded,true);
 const unresolved=structuredClone(next);unresolved.ordinal=3;unresolved.revisionId='unknown-again';unresolved.createdAt=at(15);unresolved.members[1].budgetMinor=null;
 project=amendProject(project,expectedState(project),{eventId:'reopen-limit',at:at(15),revision:unresolved});const state=replayProject(project);assert.deepEqual(state.approvals,[]);assert.equal(state.evaluation.agreementRecorded,false);const brief=latestChangeBrief(state);assert.match(brief.members[1].currentStatus,/unresolved/);assert.match(changeBriefHtml(brief),/not provided/);assert.doesNotMatch(changeBriefHtml(brief),/proposal exceeds at least one/);
});
test('AI budget negotiation refuses unknown limits before contacting configured model',async()=>{
 let calls=0;const result=await produceAiSuggestion({goal:'Help us share',revision:replayProject(picnic()).current},{env:{CLEARINGHOUSE_AI_BASE_URL:'http://127.0.0.1:11434/v1',CLEARINGHOUSE_AI_MODEL:'local'},fetchImpl:async()=>{calls++;throw Error('must not request');}});assert.equal(result.status,400);assert.match(result.body.error,/Confirm every spending limit/);assert.equal(calls,0);
});