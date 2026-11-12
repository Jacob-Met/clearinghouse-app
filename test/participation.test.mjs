import { groupTabFontCss } from "../app/group-tab-font.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createParticipation} from "../server/participation.mjs";
import {createProject,exportProject,replayProject,amendProject,expectedState} from "../app/core.mjs";
import {participantPacket,reviewedTerms} from "../app/participant-review.mjs";
import {creation,revision,at} from "./fixtures.mjs";
test("private invitations persist, bind one member and retire on a new revision",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-share-"));
 try{
  let clock=Date.now();const options={storagePath:join(dir,"state.json"),now:()=>clock};
  let api=createParticipation(options);let project=createProject(creation());
  const {ownerToken}=await api.create(exportProject(project));
  const invitation=await api.publish(ownerToken,exportProject(project),"asha");
  const token=invitation.path.split("/").pop();
  const html=(await api.review(token));assert.match(html,/Send my response/);assert.ok(!html.replace(groupTabFontCss, "").includes("Ben"));assert.ok(!html.replace(groupTabFontCss, "").includes("Chen"));
  const packet=participantPacket(replayProject(project),"asha");
  const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"propose-limit",proposedBudgetMinor:5500,proposedExcludedItemIds:null,note:"Lower limit",createdAt:new Date(clock).toISOString()};
  await assert.rejects(api.responses(token),e=>e.status===403);
  await assert.rejects(api.reply(token,JSON.stringify({...response,memberId:"ben"})));
  await api.reply(token,JSON.stringify(response));
  api=createParticipation(options);
  assert.equal((await api.responses(ownerToken)).responses.length,1);
  assert.match(await api.review(token),/Your response was received/);
  const beforeReview=await readFile(options.storagePath,"utf8");
  const reopened=await api.review(token);
  assert.match(reopened,/Proposed limit: \$55\.00/);
  assert.match(reopened,/value='propose-limit' checked/);
  assert.match(reopened,/value='55\.00'/);
  assert.match(reopened,/>Lower limit<\/textarea>/);
  assert.equal(await readFile(options.storagePath,"utf8"),beforeReview,"reading the saved reply does not write the journal");
  const otherInvite=await api.publish(ownerToken,exportProject(project),"ben");
  const otherPage=(await api.review(otherInvite.path.split("/").pop())).replace(groupTabFontCss,"");
  assert.doesNotMatch(otherPage,/Lower limit|Proposed limit: \$55\.00/);
  const ownItem=packet.items.find(item=>item.participating);
  const excluded={...response,answer:"propose-exclusions",proposedBudgetMinor:null,proposedExcludedItemIds:[ownItem.id],note:"Leave this item out"};
  await api.reply(token,JSON.stringify(excluded));
  const exclusions=await api.review(token);
  assert.match(exclusions,/Requested item changes/);
  assert.ok(exclusions.includes("Leave out: "+ownItem.label));
  assert.ok(exclusions.includes("value='"+ownItem.id+"' checked"));
  await api.reply(token,JSON.stringify(response));

  const disk=await readFile(options.storagePath,"utf8");assert.ok(!disk.includes(ownerToken));assert.ok(!disk.includes(token));
  project=amendProject(project,expectedState(project),{eventId:"next",at:at(3),revision:revision(2)});
  await api.publish(ownerToken,exportProject(project));
  await assert.rejects(api.reply(token,JSON.stringify(response)),e=>e.status===409);
  assert.equal((await api.responses(ownerToken)).responses.length,0);
  await assert.rejects(api.publish(ownerToken,exportProject(createProject(creation()))),e=>e.status===409);
  const next=await api.publish(ownerToken,exportProject(project),"asha");
  clock+=8*86400000;
  await assert.rejects(api.review(next.path.split("/").pop()),e=>e.status===410);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("payment lookup binds the invitation and rejects a plan changed while provider I/O is outstanding",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-payment-"));
 try {
  let finish,started;
  const began=new Promise(resolve=>started=resolve);
  const api=createParticipation({storagePath:join(dir,"state.json"),paymentReview:async(project,memberId)=>{
   assert.equal(memberId,"asha");assert.ok(project.includes("asha"));
   started();await new Promise(resolve=>finish=resolve);return {};
  }});
  let project=createProject(creation());
  const {ownerToken}=await api.create(exportProject(project));
  const {path}=await api.publish(ownerToken,exportProject(project),"asha");
  const pending=api.review(path.split("/").pop());await began;
  project=amendProject(project,expectedState(project),{eventId:"payment-change",at:at(3),revision:revision(2)});
  await api.publish(ownerToken,exportProject(project));
  finish();await assert.rejects(pending,e=>e.status===409);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test("authenticated recovery binds ownership, preserves invitations and refuses stale history",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-shared-recovery-"));
 try {
  let clock=Date.now();
  const options={storagePath:join(dir,"state.json"),organizerCode:"A".repeat(43),now:()=>clock};
  let api=createParticipation(options);
  const session=(await api.organizerLogin(options.organizerCode)).session;
  const original=exportProject(createProject(creation()));
  const legacy=await api.create(original);
  assert.deepEqual((await api.organizerPlans(session)).plans,[],"sign-in alone cannot expose unbound rooms");
  await assert.rejects(api.organizerPlans(legacy.ownerToken),e=>e.status===401);
  const invite=await api.publish(legacy.ownerToken,original,"asha",session);
  const plans=(await api.organizerPlans(session)).plans;
  assert.equal(plans.length,1);
  assert.equal(plans[0].title,"Example");
  assert.equal(plans[0].totalMinor,22000);
  assert.ok(!JSON.stringify(plans).includes(legacy.ownerToken));
  const secondSession=(await api.organizerLogin(options.organizerCode)).session;
  const opened=await api.organizerOpen(secondSession,plans[0].id);
  assert.equal(opened.project,original);
  assert.notEqual(opened.ownerToken,legacy.ownerToken);
  assert.equal((await api.responses(opened.ownerToken)).responses.length,0);
  assert.match(await api.review(invite.path.split("/").pop()),/Send my response/);
  const next=exportProject(amendProject(createProject(creation()),expectedState(createProject(creation())),{eventId:"shared-next",at:at(3),revision:revision(2)}));
  await api.publish(opened.ownerToken,next,null,secondSession);
  await assert.rejects(api.publish(legacy.ownerToken,original,null,session),e=>e.status===409);
  assert.equal((await api.organizerOpen(session,plans[0].id)).project,next);
  assert.equal((await api.responses(legacy.ownerToken)).ordinal,2,"original owner survives recovery");
  api=createParticipation(options);
  assert.equal((await api.organizerOpen(session,plans[0].id)).ownerToken,opened.ownerToken,"restart preserves recovery authority without rotating original tokens");
  const disk=await readFile(options.storagePath,"utf8");
  assert.ok(!disk.includes(opened.ownerToken));
  assert.ok(!disk.includes(options.organizerCode));
  await assert.rejects(api.organizerOpen(session,"missing"),e=>e.status===404);
  const rotated=createParticipation({...options,organizerCode:"B".repeat(43)});
  const other=(await rotated.organizerLogin("B".repeat(43))).session;
  assert.deepEqual((await rotated.organizerPlans(other)).plans,[]);
  await assert.rejects(rotated.organizerOpen(other,plans[0].id),e=>e.status===404);
  await assert.rejects(rotated.responses(opened.ownerToken),e=>e.status===401);
  clock+=9*60*60*1000;
  await assert.rejects(api.organizerOpen(session,plans[0].id),e=>e.status===401);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test("reissued invitations share one server-ordered current answer even within the same millisecond",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-current-answer-"));
 try{
  const options={storagePath:join(dir,"state.json"),now:()=>1794430000000};
  let api=createParticipation(options);const project=createProject(creation()),text=exportProject(project);
  const {ownerToken}=await api.create(text);
  const first=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  const second=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  const packet=participantPacket(replayProject(project),"asha");
  const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"agree",proposedBudgetMinor:null,proposedExcludedItemIds:null,note:"The first answer",createdAt:new Date(options.now()).toISOString()};
  await api.reply(first,JSON.stringify(response));
  await api.reply(second,JSON.stringify({...response,answer:"decline",note:"I now need a change"}));
  let current=await api.responses(ownerToken);
  assert.equal(current.responses.length,1);assert.equal(JSON.parse(current.responses[0].text).answer,"decline");assert.deepEqual(current.conflicts,[]);
  const beforeRead=await readFile(options.storagePath,"utf8");
  api=createParticipation(options);
  for(const token of [first,second]){
   const html=await api.review(token);assert.match(html,/value='decline' checked/);assert.match(html,/I now need a change/);assert.doesNotMatch(html,/value='agree' checked/);
  }
  assert.equal(await readFile(options.storagePath,"utf8"),beforeRead);
  const db=JSON.parse(beforeRead),room=Object.values(db.rooms)[0];
  assert.ok(Object.values(room.invitations).some(i=>JSON.parse(i.response).note==="The first answer"),"earlier invitation record retained");
  const third=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  assert.match(await api.review(third),/I now need a change/,"fresh link inherits current answer");
  await api.reply(first,JSON.stringify({...response,note:"Explicitly agreeing again"}));
  current=await api.responses(ownerToken);assert.equal(current.responses.length,1);
  assert.equal(JSON.parse(current.responses[0].text).note,"Explicitly agreeing again");
  assert.match(await api.review(third),/value='agree' checked/);
  const next=amendProject(project,expectedState(project),{eventId:"answers-next",at:at(3),revision:revision(2)});
  await api.publish(ownerToken,exportProject(next));assert.equal((await api.responses(ownerToken)).responses.length,0);
  assert.match(await api.review(first),/has not shared the new proposal/);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("legacy tied conflicting replies ask for a fresh answer and are not silently treated as agreement",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-legacy-answer-"));
 try{
  const options={storagePath:join(dir,"state.json"),now:()=>1794430000000};
  let api=createParticipation(options);const project=createProject(creation()),text=exportProject(project);
  const {ownerToken}=await api.create(text);
  const first=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  const second=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  const packet=participantPacket(replayProject(project),"asha");
  const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"agree",proposedBudgetMinor:null,proposedExcludedItemIds:null,note:"Earlier answer",createdAt:new Date(options.now()).toISOString()};
  await api.reply(first,JSON.stringify(response));
  await api.reply(second,JSON.stringify({...response,answer:"decline",note:"Conflicting old answer"}));
  const db=JSON.parse(await readFile(options.storagePath,"utf8")),room=Object.values(db.rooms)[0];
  delete room.responseSequence;for(const invitation of Object.values(room.invitations))delete invitation.receivedSequence;
  await writeFile(options.storagePath,JSON.stringify(db));api=createParticipation(options);
  const beforeRead=await readFile(options.storagePath,"utf8");
  const result=await api.responses(ownerToken);assert.deepEqual(result.responses,[]);assert.deepEqual(result.conflicts,[{memberId:"asha",memberName:"Asha"}]);
  assert.match(await api.review(first),/earlier replies disagree/);
  assert.doesNotMatch(await api.review(first),/value='agree' checked/);
  assert.equal(await readFile(options.storagePath,"utf8"),beforeRead);
  const third=(await api.publish(ownerToken,text,"asha")).path.split("/").pop();
  await api.reply(third,JSON.stringify({...response,answer:"decline",note:"My explicit current answer"}));
  assert.equal((await api.responses(ownerToken)).responses.length,1);
  assert.deepEqual((await api.responses(ownerToken)).conflicts,[]);
  assert.match(await api.review(first),/My explicit current answer/);
 }finally{await rm(dir,{recursive:true,force:true})}
});


test("refreshing an unchanged shared plan preserves its publication time and journal",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-unchanged-publication-"));
 try{
  let clock=1794442000000;
  const options={storagePath:join(dir,"state.json"),organizerCode:"A".repeat(43),now:()=>clock};
  const api=createParticipation(options),session=(await api.organizerLogin(options.organizerCode)).session;
  const project=createProject(creation()),text=exportProject(project);
  const {ownerToken}=await api.create(text,session);
  const before=await readFile(options.storagePath,"utf8"),listed=(await api.organizerPlans(session)).plans;
  clock+=60000;
  await api.publish(ownerToken,text,null,session);
  assert.equal(await readFile(options.storagePath,"utf8"),before,"checking the same plan writes no new publication");
  assert.deepEqual((await api.organizerPlans(session)).plans,listed,"checking replies does not reorder the group list");
  const invite=await api.publish(ownerToken,text,"asha",session);
  assert.match(await api.review(invite.path.split("/").pop()),/Send my response/);
  assert.equal((await api.organizerPlans(session)).plans[0].updatedAt,listed[0].updatedAt,"a new private link does not pretend the plan changed");
  const next=exportProject(amendProject(project,expectedState(project),{eventId:"actual-next",at:at(3),revision:revision(2)}));
  clock+=60000;await api.publish(ownerToken,next,null,session);
  assert.equal((await api.organizerPlans(session)).plans[0].updatedAt,new Date(clock).toISOString());
  assert.equal((await api.organizerPlans(session)).plans[0].ordinal,2);
  const legacy=await api.create(text);
  const count=(await api.organizerPlans(session)).plans.length;
  clock+=60000;await api.publish(legacy.ownerToken,text,null,session);
  assert.equal((await api.organizerPlans(session)).plans.length,count+1,"same-content publication still persists the first authorized owner binding");
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("continuation requires a current same-person organizer invitation and preserves old authority",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-continuation-"));
 try {
  let clock=1794450000000;
  const options={storagePath:join(dir,"state.json"),now:()=>clock};
  let api=createParticipation(options),project=createProject(creation());
  const {ownerToken}=await api.create(exportProject(project));
  const original=(await api.publish(ownerToken,exportProject(project),"asha")).path.split("/").pop();
  const packet=participantPacket(replayProject(project),"asha");
  const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"decline",proposedBudgetMinor:null,proposedExcludedItemIds:null,note:"My original reply",createdAt:new Date(clock).toISOString()};
  await api.reply(original,JSON.stringify(response));
  const oldDb=JSON.parse(await readFile(options.storagePath,"utf8"));
  const oldRoom=Object.values(oldDb.rooms)[0],oldEntry=Object.entries(oldRoom.invitations)[0];
  clock+=60000;
  project=amendProject(project,expectedState(project),{eventId:"continuation-r2",at:at(3),revision:revision(2)});
  await api.publish(ownerToken,exportProject(project),"ben");
  const beforeRead=await readFile(options.storagePath,"utf8");
  const waiting=await api.review(original);
  assert.match(waiting,/has not shared the new proposal/);
  assert.doesNotMatch(waiting.replace(groupTabFontCss,""),/review-current-proposal|Ben|Chen|My original reply/);
  await assert.rejects(api.continueReview(original),e=>e.status===409);
  assert.equal(await readFile(options.storagePath,"utf8"),beforeRead);
  await api.publish(ownerToken,exportProject(project),"asha");
  const authorized=await readFile(options.storagePath,"utf8");
  assert.match(await api.review(original),/Review proposal R2/);
  assert.equal(await readFile(options.storagePath,"utf8"),authorized,"viewing the handoff does not mint access");
  await assert.rejects(api.reply(original,JSON.stringify(response)),e=>e.status===409);
  const next=await api.continueReview(original),nextToken=next.path.split("/").pop();
  const after=await readFile(options.storagePath,"utf8"),room=Object.values(JSON.parse(after).rooms)[0];
  assert.deepEqual(room.invitations[oldEntry[0]],oldEntry[1],"old response and invitation remain unchanged");
  const derived=Object.values(room.invitations).find(row=>row.continuedFrom);
  assert.equal(derived.memberId,"asha");assert.equal(derived.expires,oldEntry[1].expires);
  assert.equal((await api.responses(ownerToken)).responses.length,0,"no carried agreement");
  assert.ok(!after.includes(nextToken));
  api=createParticipation(options);
  assert.deepEqual(await api.continueReview(original),next);
  assert.equal(await readFile(options.storagePath,"utf8"),after,"repeated continuation is idempotent across restart");
  const currentPage=(await api.review(nextToken)).replace(groupTabFontCss,"");
  assert.match(currentPage,/Proposal R2/);assert.doesNotMatch(currentPage,/Ben|Chen|My original reply/);
  const current=participantPacket(replayProject(project),"asha");
  const fresh={...response,revisionId:current.revisionId,ordinal:current.ordinal,amountMinor:current.amountMinor,reviewedTerms:reviewedTerms(current),note:"Reviewed R2"};
  await assert.rejects(api.reply(nextToken,JSON.stringify(response)));
  await api.reply(nextToken,JSON.stringify(fresh));
  assert.equal(JSON.parse((await api.responses(ownerToken)).responses[0].text).note,"Reviewed R2");
  clock=oldEntry[1].expires+1;
  await assert.rejects(api.review(original),e=>e.status===410);
  await assert.rejects(api.review(nextToken),e=>e.status===410);
  await assert.rejects(api.continueReview(original),e=>e.status===410);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test("organizer archive is reversible across sessions without changing group history or invitations",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"clearinghouse-archive-"));
 try {
  const options={storagePath:join(dir,"state.json"),organizerCode:"A".repeat(43)};
  let api=createParticipation(options);
  const session=(await api.organizerLogin(options.organizerCode)).session;
  const second=(await api.organizerLogin(options.organizerCode)).session;
  const project=createProject(creation()),text=exportProject(project);
  const {ownerToken}=await api.create(text,session);
  const invite=await api.publish(ownerToken,text,"asha",session),token=invite.path.split("/").pop();
  const packet=participantPacket(replayProject(project),"asha");
  await api.reply(token,JSON.stringify({format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"decline",proposedBudgetMinor:null,proposedExcludedItemIds:null,note:"Discuss another plan",createdAt:new Date().toISOString()}));
  const legacy=await api.create(text);
  const plan=(await api.organizerPlans(session)).plans[0],before=JSON.parse(await readFile(options.storagePath,"utf8"));
  const originalReview=await api.review(token),originalReplies=await api.responses(ownerToken);
  await assert.rejects(api.organizerArchive(ownerToken,plan.id,true),e=>e.status===401);
  await assert.rejects(api.organizerArchive(token,plan.id,true),e=>e.status===401);
  await assert.rejects(api.organizerArchive(session,plan.id,"true"),e=>e.status===400);
  await assert.rejects(api.organizerArchive(session,"missing",true),e=>e.status===404);
  assert.deepEqual(await api.organizerArchive(session,plan.id,true),{id:plan.id,archived:true});
  let disk=JSON.parse(await readFile(options.storagePath,"utf8")),expected=structuredClone(before);
  expected.rooms[plan.id].archived=true;
  assert.deepEqual(disk,expected,"only the owned room list flag changes");
  const archivedBytes=await readFile(options.storagePath,"utf8");
  await api.organizerArchive(second,plan.id,true);
  assert.equal(await readFile(options.storagePath,"utf8"),archivedBytes,"repeating archive does not rewrite state");
  api=createParticipation(options);
  const listed=(await api.organizerPlans(second)).plans[0];
  assert.equal(listed.archived,true);assert.equal(listed.updatedAt,plan.updatedAt);
  assert.equal((await api.organizerOpen(second,plan.id)).project,text);
  assert.equal(await api.review(token),originalReview);
  assert.deepEqual(await api.responses(ownerToken),originalReplies);
  assert.equal((await api.responses(legacy.ownerToken)).responses.length,0);
  const rotated=createParticipation({...options,organizerCode:"B".repeat(43)});
  const other=(await rotated.organizerLogin("B".repeat(43))).session;
  await assert.rejects(rotated.organizerArchive(other,plan.id,false),e=>e.status===404);
  const restoredSession=(await api.organizerLogin(options.organizerCode)).session;
  const beforeRestore=JSON.parse(await readFile(options.storagePath,"utf8"));
  await api.organizerArchive(restoredSession,plan.id,false);
  disk=JSON.parse(await readFile(options.storagePath,"utf8"));beforeRestore.rooms[plan.id].archived=false;
  assert.deepEqual(disk,beforeRestore);assert.equal((await api.organizerPlans(restoredSession)).plans[0].archived,false);
  assert.equal((await api.organizerOpen(restoredSession,plan.id)).project,text);
 } finally {await rm(dir,{recursive:true,force:true});}
});
