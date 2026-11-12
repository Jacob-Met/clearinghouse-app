import { randomBytes, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { importProject, replayProject, exportProject } from "../app/core.mjs";
import { recipientPacket, parseParticipantResponse, participantReviewHtml, participantContinuationHtml } from "../app/participant-review.mjs";
const digest = value => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
export function createParticipation({storagePath, now = Date.now, organizerCode = null, paymentReview = null}) {
  if(organizerCode && !/^[A-Za-z0-9_-]{43}$/.test(organizerCode)) throw new Error("Organizer code must be a generated 32-byte base64url secret.");
  const organizerHash = organizerCode ? digest(organizerCode) : null;
  let queue = Promise.resolve();
  async function transact(action) {
    const run = queue.then(async () => {
      let db;
      try { db = JSON.parse(await readFile(storagePath, "utf8")); }
      catch (error) { if(error.code !== "ENOENT") throw error; db = {version:1, rooms:{}}; }
      const result = action(db);
      if(result.write) {
        await mkdir(dirname(storagePath), {recursive:true, mode:0o700});
        const tmp = storagePath + "." + secret() + ".tmp";
        await writeFile(tmp, JSON.stringify(db), {mode:0o600});
        await rename(tmp, storagePath);
      }
      return result.value;
    });
    queue = run.catch(()=>{});
    return run;
  }
  function organizerSession(db, token) {
    const row=typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) ? db.organizerSessions?.[digest(token)] : null;
    if(!organizerHash || !row || row.credential !== organizerHash || row.expiresAt <= now())
      fail("Sign in to open the organizer workspace.",401);
    return row;
  }
  const recoveryToken = id => createHmac("sha256",organizerCode).update("clearinghouse-organizer-room-v1\0"+id).digest("base64url");
  function bindOrganizer(db,room,session) {
    if(!session)return;
    organizerSession(db,session);
    if(room.organizerCredential && room.organizerCredential !== organizerHash)
      fail("This shared plan belongs to another organizer credential.",403);
    room.organizerCredential=organizerHash;
  }
  function roomFor(db, token) {
    if(typeof token !== "string" || token.length !== 43) fail("Invitation access is required.",401);
    const key = digest(token);
    for(const [id,room] of Object.entries(db.rooms)) {
      if(room.owner === key || (organizerHash && room.organizerCredential === organizerHash && digest(recoveryToken(id)) === key)) return {id, room, owner:true};
      const invitation = room.invitations[key];
      if(invitation) {
        if(invitation.expires <= now()) fail("This invitation has expired. Ask for a new invitation.",410);
        return {id,room,invitation,owner:false};
      }
    }
    fail("Invitation access is required.",401);
  }
  function organizer(db, token) {
    const access = roomFor(db,token);
    if(!access.owner) fail("Organizer access is required.",403);
    return access.room;
  }
  function current(room, invitation) {
    const state = replayProject(importProject(room.project));
    if(state.current.revisionId !== invitation.revisionId) fail("The group has a newer proposal. Ask for its invitation.",409);
    return state;
  }
  function currentReply(room,state,memberId) {
    const candidates=Object.values(room.invitations).filter(i=>i.response && i.memberId===memberId && i.revisionId===state.current.revisionId);
    if(!candidates.length)return null;
    const ordered=candidates.filter(i=>Number.isSafeInteger(i.receivedSequence) && i.receivedSequence>0);
    const score=i=>ordered.length ? i.receivedSequence : Date.parse(i.receivedAt);
    const pool=ordered.length ? ordered : candidates;
    const newest=Math.max(...pool.map(score));
    if(!Number.isFinite(newest))return {conflict:true};
    const latest=pool.filter(i=>score(i)===newest);
    const parsed=latest.map(i=>{
      const response=parseParticipantResponse(state,i.response).response;
      if(response.memberId!==memberId)fail("This reply belongs to another participant.",403);
      const {createdAt,...meaning}=response;
      return {row:i,meaning:JSON.stringify(meaning)};
    });
    if(new Set(parsed.map(i=>i.meaning)).size>1)return {conflict:true};
    const row=parsed[0].row;
    return {text:row.response,receivedAt:row.receivedAt};
  }
  function currentInvitation(room,state,memberId) {
    return Object.entries(room.invitations).filter(([,row])=>
      !row.continuedFrom && row.memberId===memberId && row.revisionId===state.current.revisionId && row.expires>now())
      .sort((a,b)=>b[1].expires-a[1].expires || a[0].localeCompare(b[0]))[0] || null;
  }
  async function reviewData(token) {
    const snapshot = await transact(db => {
      const {room,invitation,owner} = roomFor(db,token);
      if(owner) fail("Use a participant invitation.",403);
      return {value:{project:room.project,memberId:invitation.memberId,
        packet:recipientPacket(current(room,invitation),invitation.memberId)}};
    });
    const payment = paymentReview ? await paymentReview(snapshot.project,snapshot.memberId) : {};
    // Provider I/O must not hold the journal queue, or let a superseded review escape.
    return transact(db => {
      const {room,invitation,owner} = roomFor(db,token);
      if(owner) fail("Use a participant invitation.",403);
      current(room,invitation);
      if(room.project !== snapshot.project) fail("The plan changed during this check. Reload your invitation.",409);
      const state=current(room,invitation),reply=currentReply(room,state,invitation.memberId);
      const savedResponse=reply?.text ? parseParticipantResponse(state,reply.text).response : null;
      return {value:{packet:snapshot.packet,submitted:!!savedResponse,savedResponse,replyConflict:!!reply?.conflict,...payment}};
    });
  }
  return {
    organizerLogin(code) { return transact(db => {
      if(!organizerHash || typeof code !== "string" || !timingSafeEqual(Buffer.from(digest(code)),Buffer.from(organizerHash)))
        fail("That organizer access code did not match.",401);
      db.organizerSessions ??= {};
      for(const [key,row] of Object.entries(db.organizerSessions))
        if(row.expiresAt <= now() || row.credential !== organizerHash) delete db.organizerSessions[key];
      if(Object.keys(db.organizerSessions).length >= 64) fail("Too many active organizer sessions.",429);
      const session=secret(),expiresAt=now()+8*60*60*1000;
      db.organizerSessions[digest(session)]={expiresAt,credential:organizerHash};
      return {write:true,value:{session,expiresAt}};
    }); },
    organizerRead(token) { return transact(db => {
      const row=organizerSession(db,token);
      return {value:{expiresAt:row.expiresAt}};
    }); },
    organizerLogout(token) { return transact(db => {
      if(typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token) && db.organizerSessions)
        delete db.organizerSessions[digest(token)];
      return {write:true,value:{signedOut:true}};
    }); },
    organizerPlans(session) { return transact(db => {
      organizerSession(db,session);
      const plans=Object.entries(db.rooms).filter(([,room])=>room.organizerCredential===organizerHash).map(([id,room])=>{
        const state=replayProject(importProject(room.project));
        return {id,title:state.project.title,ordinal:state.current.ordinal,totalMinor:state.evaluation.totalMinor,
          members:state.current.members.map(member=>member.name),archived:room.archived===true,updatedAt:room.publishedAt||state.project.events.at(-1).at};
      }).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      return {value:{plans}};
    }); },
    organizerOpen(session,id) { return transact(db => {
      organizerSession(db,session);
      const room=typeof id==="string" ? db.rooms[id] : null;
      if(!room || room.organizerCredential!==organizerHash)fail("That shared plan is not available to this organizer.",404);
      return {value:{project:room.project,ownerToken:recoveryToken(id)}};
    }); },
    organizerArchive(session,id,archived) { return transact(db => {
      organizerSession(db,session);
      if(typeof archived!=="boolean")fail("Choose whether to archive or restore this group.");
      const room=typeof id==="string" ? db.rooms[id] : null;
      if(!room || room.organizerCredential!==organizerHash)fail("That shared plan is not available to this organizer.",404);
      const changed=(room.archived===true)!==archived;
      if(changed)room.archived=archived;
      return {write:changed,value:{id,archived}};
    }); },
    create(project,session=null) { return transact(db => {
      const parsed = importProject(project), ownerToken = secret(), id = secret();
      db.rooms[id] = {owner:digest(ownerToken), project:exportProject(parsed), invitations:{},publishedAt:new Date(now()).toISOString()};
      bindOrganizer(db,db.rooms[id],session);
      return {write:true,value:{ownerToken}};
    }); },
    publish(token, project, memberId = null, session=null) { return transact(db => {
      const room = organizer(db,token), parsed = importProject(project), previous = importProject(room.project);
      if(parsed.projectId !== previous.projectId || parsed.events.length < previous.events.length ||
        JSON.stringify(parsed.events.slice(0,previous.events.length)) !== JSON.stringify(previous.events))
        fail("The shared plan has moved on or has different history. Open its latest organizer copy.",409);
      const state = replayProject(parsed);
      const packet = memberId === null ? null : recipientPacket(state,memberId);
      const previousCredential=room.organizerCredential;
      bindOrganizer(db,room,session);
      const nextProject=exportProject(parsed),changed=nextProject!==room.project;
      if(changed){
        room.project=nextProject;
        room.publishedAt=new Date(now()).toISOString();
      }
      if(!packet) return {write:changed || previousCredential!==room.organizerCredential,value:{ordinal:state.current.ordinal}};
      const invitationToken = secret();
      room.invitations[digest(invitationToken)] = {memberId,revisionId:packet.revisionId,expires:now()+7*86400000,response:null};
      return {write:true,value:{path:"/participant/"+invitationToken,ordinal:packet.ordinal,memberName:packet.memberName}};
    }); },
    async review(token) {
      const transition=await transact(db=>{
        const {room,invitation,owner}=roomFor(db,token);
        if(owner)fail("Use a participant invitation.",403);
        const state=replayProject(importProject(room.project));
        if(state.current.revisionId===invitation.revisionId)return {value:null};
        const grant=currentInvitation(room,state,invitation.memberId);
        return {value:grant?{ordinal:state.current.ordinal,path:"/participant/"+token+"/continue"}:{}};
      });
      if(transition)return participantContinuationHtml(transition);
      const data = await reviewData(token);
      if(!data.packet.removed && data.payerHandoff && !data.payerHandoff.unavailable)
        data.payerHandoff = {...data.payerHandoff,url:"/participant/"+token+"/pay"};
      return participantReviewHtml(data.packet,{...data,shared:true});
    },
    continueReview(token) { return transact(db=>{
      const {room,invitation,owner}=roomFor(db,token);
      if(owner)fail("Use a participant invitation.",403);
      const state=replayProject(importProject(room.project));
      if(state.current.revisionId===invitation.revisionId)return {value:{path:"/participant/"+token}};
      const grant=currentInvitation(room,state,invitation.memberId);
      if(!grant)fail("Ask the organizer to share the current proposal with you.",409);
      // The organizer's current same-person invitation supplies the new authority.
      // Keep the original invitation, reply and expiry unchanged.
      const nextToken=createHmac("sha256",token).update("clearinghouse-invitation-continuation-v1\0"+state.current.revisionId+"\0"+grant[0]).digest("base64url");
      const key=digest(nextToken),existing=room.invitations[key];
      const expires=Math.min(invitation.expires,grant[1].expires);
      if(existing && (existing.memberId!==invitation.memberId || existing.revisionId!==state.current.revisionId || existing.expires!==expires))
        fail("This updated invitation is not available.",409);
      if(!existing)room.invitations[key]={memberId:invitation.memberId,revisionId:state.current.revisionId,expires,response:null,continuedFrom:digest(token)};
      return {write:!existing,value:{path:"/participant/"+nextToken}};
    }); },
    async payer(token) {
      const data = await reviewData(token);
      return !data.packet.removed && data.payerHandoff && !data.payerHandoff.unavailable ? data.payerHandoff : null;
    },
    reply(token, text) { return transact(db => {
      const {room,invitation,owner} = roomFor(db,token);
      if(owner) fail("Use a participant invitation.",403);
      const state = current(room,invitation);
      const {response} = parseParticipantResponse(state,text);
      if(response.memberId !== invitation.memberId) fail("This invitation belongs to another participant.",403);
      const sequence=(room.responseSequence||0)+1;
      if(!Number.isSafeInteger(sequence))fail("This group cannot record another reply.",409);
      room.responseSequence=sequence;
      invitation.receivedSequence=sequence;
      invitation.response = JSON.stringify(response);
      invitation.receivedAt = new Date(now()).toISOString();
      return {write:true,value:{receivedAt:invitation.receivedAt,ordinal:state.current.ordinal}};
    }); },
    responses(token) { return transact(db => {
      const room = organizer(db,token), state = replayProject(importProject(room.project));
      const responses=[],conflicts=[];
      for(const member of state.current.members) {
        const reply=currentReply(room,state,member.id);
        if(reply?.conflict)conflicts.push({memberId:member.id,memberName:member.name});
        else if(reply)responses.push(reply);
      }
      return {value:{ordinal:state.current.ordinal,responses,conflicts}};
    }); }
  };
}
