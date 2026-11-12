import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createProject,replayProject,importProject} from "../app/core.mjs";
import {participantPacket,reviewedTerms,parseParticipantResponse,participantExclusionsForDraft} from "../app/participant-review.mjs";
import {creation} from "./fixtures.mjs";
const state=input=>replayProject(createProject(input??creation()));
function exclusion(s,ids,overrides={}) {
 const p=participantPacket(s,"asha");
 return JSON.stringify({format:p.format,projectId:p.projectId,revisionId:p.revisionId,ordinal:p.ordinal,
 memberId:p.memberId,amountMinor:p.amountMinor,reviewedTerms:reviewedTerms(p),answer:"propose-exclusions",
 proposedBudgetMinor:null,proposedExcludedItemIds:ids,note:"I will not use this item.",createdAt:"2026-11-10T20:00:00.000Z",...overrides});
}
test("exact item IDs disambiguate identical labels; preview exposes redistribution without changing history or draft",()=>{
 const input=creation();input.revision.items.forEach(i=>i.label="Shared supplies");const s=state(input);
 const id=s.current.items[0].id,text=exclusion(s,[id]),draft=structuredClone(s.current);
 draft.note="Keep this unrelated note";draft.members[1].name="Pending rename";
 const before=JSON.stringify(draft),history=JSON.stringify(s.project),result=participantExclusionsForDraft(s,text,draft);
 assert.equal(result.changes.length,1);assert.equal(result.changes[0].itemId,id);
 assert.equal(result.before.totalMinor,result.after.totalMinor);
 assert.equal(result.after.items[0].allocations.find(a=>a.memberId==="asha").minor,0);
 assert.equal(result.after.members.find(m=>m.id==="asha").amountMinor,2000);
 assert.ok(result.after.members.some(m=>m.id!=="asha"&&m.amountMinor>result.before.members.find(b=>b.id===m.id).amountMinor));
 assert.equal(JSON.stringify(draft),before);assert.equal(JSON.stringify(s.project),history);
 assert.equal(s.approvals.length,0);
});
test("sole participant, removed item, stale participation and malformed requests cannot silently move obligations",()=>{
 const input=creation();input.revision.items[0].weights.forEach(w=>w.units=w.memberId==="asha"?1:0);const s=state(input),id=s.current.items[0].id,text=exclusion(s,[id]);
 const draft=structuredClone(s.current),before=JSON.stringify(draft);
 assert.throws(()=>participantExclusionsForDraft(s,text,draft),/no participant/);assert.equal(JSON.stringify(draft),before);
 for(const ids of [[],[id,id],["missing"],[null]])assert.throws(()=>parseParticipantResponse(s,exclusion(s,ids)));
 assert.throws(()=>participantExclusionsForDraft(s,text,{...draft,items:draft.items.slice(1)}),/no longer/);
 assert.throws(()=>parseParticipantResponse(s,exclusion(s,[id],{proposedBudgetMinor:100})),/Only a limit/);
 assert.throws(()=>parseParticipantResponse(s,exclusion(s,[id],{answer:"agree"})),/Only an item/);
 const fork=creation();fork.revision.items[0].id="different-item";const normal=state();const old=exclusion(normal,[normal.current.items[0].id]);
 assert.throws(()=>parseParticipantResponse(state(fork),old),/reviewed terms differ/);
});
test("zero-dollar participation remains explicit and request never becomes an automatic exclusion or agreement",()=>{
 const input=creation();input.revision.items[0].unitMinor=0;const s=state(input),p=participantPacket(s,"asha"),id=p.items[0].id;
 assert.equal(p.items[0].amountMinor,0);assert.equal(p.items[0].participating,true);
 const parsed=parseParticipantResponse(s,exclusion(s,[id]));assert.equal(parsed.response.answer,"propose-exclusions");
 const result=participantExclusionsForDraft(s,exclusion(s,[id]),s.current);assert.equal(result.before.totalMinor,result.after.totalMinor);
 const fork=structuredClone(input);fork.revision.items[0].weights.find(w=>w.memberId==="asha").units=0;
 assert.throws(()=>parseParticipantResponse(state(fork),exclusion(s,[id])),/reviewed terms differ/);
});
test.skip("actual archived v3 spending-limit reply stays readable without rewriting its reviewed terms",()=>{
 const project=readFileSync(new URL("../docs/evidence/participant-limit-replies/original-project.json",import.meta.url),"utf8");
 const reply=readFileSync(new URL("../docs/evidence/participant-limit-replies/participant-reply.json",import.meta.url),"utf8");
 const parsed=parseParticipantResponse(replayProject(importProject(project)),reply);
 assert.equal(parsed.response.format,"clearinghouse-participant-response/v3");assert.equal(parsed.response.proposedBudgetMinor,2550);
});
