import test from "node:test";
import assert from "node:assert/strict";
import {createProject,replayProject} from "../app/core.mjs";
import {participantPacket,reviewedTerms,parseParticipantResponse,participantExclusionsForDraft} from "../app/participant-review.mjs";
import {creation} from "./fixtures.mjs";
const state=()=>replayProject(createProject(creation()));
function request(s,overrides={}){const p=participantPacket(s,"asha");return JSON.stringify({
 format:"clearinghouse-participant-response/v5",projectId:p.projectId,revisionId:p.revisionId,ordinal:p.ordinal,memberId:p.memberId,amountMinor:p.amountMinor,
 reviewedTerms:reviewedTerms(p,"clearinghouse-participant-response/v5"),answer:"propose-changes",proposedBudgetMinor:4500,proposedExcludedItemIds:["coach"],
 note:"I can spend at most forty-five and will arrange my own ride.",createdAt:"2026-11-12T05:00:00.000Z",...overrides});}
test("combined request reviews exact item and budget consequences without changing source or draft",()=>{
 const s=state(),draft=structuredClone(s.current);draft.members[2].budgetMinor=7900;draft.note="Keep my unfinished note";
 const original=JSON.stringify(s),before=JSON.stringify(draft),text=request(s);
 const parsed=parseParticipantResponse(s,text);assert.equal(parsed.response.answer,"propose-changes");
 const result=participantExclusionsForDraft(s,text,draft);
 assert.deepEqual(result.after.members.map(x=>[x.id,x.amountMinor,x.budgetMinor]),[["asha",4000,4500],["ben",11000,11000],["chen",7000,7900]]);
 assert.equal(result.after.totalMinor,22000);assert.equal(result.proposedBudgetMinor,4500);
 assert.equal(JSON.stringify(s),original);assert.equal(JSON.stringify(draft),before);
 const zero=participantExclusionsForDraft(s,request(s,{proposedBudgetMinor:0}),draft);
 assert.equal(zero.after.members[0].budgetMinor,0);assert.equal(zero.after.members[0].overMinor,4000);assert.equal(zero.after.feasible,false);
});
test("combined requests require both explicit valid choices and their versioned reviewed terms",()=>{
 const s=state();
 for(const patch of [{format:"clearinghouse-participant-response/v4"},{answer:"agree"},{answer:"propose-limit"},{proposedBudgetMinor:null},{proposedBudgetMinor:45.5},{proposedBudgetMinor:-1},{proposedExcludedItemIds:null},{proposedExcludedItemIds:[]},{proposedExcludedItemIds:["coach","coach"]},{proposedExcludedItemIds:["missing"]},{reviewedTerms:"{}"},{revisionId:"old"}])
  assert.throws(()=>parseParticipantResponse(s,request(s,patch)),JSON.stringify(patch));
});
test("combined requests refuse missing draft editors and unassigned purchases before producing a copy",()=>{
 const s=state(),text=request(s);
 const removed=structuredClone(s.current);removed.members=removed.members.filter(x=>x.id!=="asha");assert.throws(()=>participantExclusionsForDraft(s,text,removed),/no longer/);
 const sole=structuredClone(s.current);sole.items[1].weights.forEach(x=>x.units=x.memberId==="asha"?1:0);
 assert.throws(()=>participantExclusionsForDraft(s,text,sole),/no participant/);
 const renamed=creation();renamed.revision.items[1].label="Different ride";
 assert.throws(()=>parseParticipantResponse(replayProject(createProject(renamed)),text),/reviewed terms/);
});