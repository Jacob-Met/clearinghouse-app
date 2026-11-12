import { groupTabFontCss } from "../app/group-tab-font.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {mkdtemp,rm,readFile,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createProject,exportProject,replayProject,amendProject,expectedState} from "../app/core.mjs";
import {participantPacket,reviewedTerms} from "../app/participant-review.mjs";
import {creation,revision,at} from "./fixtures.mjs";

test("invitation listener receives a private response without exposing organizer or payment routes",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-isolated-"));
  process.env.CLEARINGHOUSE_PARTICIPATION_PATH=join(dir,"participation.json");
  process.env.CLEARINGHOUSE_INVITATION_ORIGIN="https://guests.example.test";
  const {server,invitationServer}=await import("../server.mjs");
  server.listen(0,"127.0.0.1");invitationServer.listen(0,"127.0.0.1");
  await Promise.all([once(server,"listening"),once(invitationServer,"listening")]);
  const local="http://127.0.0.1:"+server.address().port;
  const guests="http://127.0.0.1:"+invitationServer.address().port;
  // Native HTTP preserves the TLS proxy Host; Node fetch rewrites it to the loopback URL.
  const fetch=(url,options={})=>new Promise((resolve,reject)=>{
    const headers={...options.headers,...(url.startsWith(guests)?{Host:"guests.example.test"}:{})};
    const request=httpRequest(url,{...options,headers},response=>{
      const chunks=[];response.on("data",chunk=>chunks.push(chunk));
      response.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:response.headers})));
    });
    request.on("error",reject);request.end(options.body);
  });
  const post=(base,path,body,token,origin)=>fetch(base+path,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(body)});
  try {
    const health=await fetch(guests+"/healthz");
    assert.deepEqual(await health.json(),{ok:true,product:"clearinghouse-invitations",audience:"participants"});
    const project=createProject(creation()),text=exportProject(project);
    const owner=await (await post(local,"/api/participation/create",{project:text})).json();
    const invitation=await (await post(local,"/api/participation/publish",{project:text,memberId:"asha"},owner.ownerToken)).json();
    assert.equal(new URL(invitation.path).origin,"https://guests.example.test");
    const path=new URL(invitation.path).pathname,token=path.split("/").pop();
    const review=await fetch(guests+path);
    assert.equal(review.status,200);
    const html=await review.text();assert.match(html,/Send my response/);assert.ok(!html.replace(groupTabFontCss, "").includes("Ben"));
    for(const path of ["/","/app.mjs","/api/ai/status","/api/ai/suggest","/api/paypal-sandbox","/api/paypal-sandbox/capture","/api/participation/create","/api/participation/publish","/api/participation/responses"]){
      assert.equal((await fetch(guests+path)).status,404,path+" GET");
      assert.equal((await post(guests,path,{project:text},owner.ownerToken)).status,404,path+" POST");
    }
    const noOrder=await fetch(guests+path+"/pay");
    assert.equal(noOrder.status,303);assert.equal(noOrder.headers.get("location"),path);
    assert.equal(noOrder.headers.get("set-cookie"),null);
    const returned=await fetch(guests+"/payment-return?token=ORDERTEST123",{headers:{Cookie:"__Host-clearinghouse-payment-ORDERTEST123="+token}});
    assert.equal(returned.status,303);assert.equal(returned.headers.get("location"),path);
    assert.match(returned.headers.get("set-cookie"),/Max-Age=0/);
    assert.match(returned.headers.get("set-cookie"),/HttpOnly; SameSite=Lax/);
    assert.equal(returned.headers.get("referrer-policy"),"no-referrer");
    const missing=await fetch(guests+"/payment-return?token=ORDERTEST999",{headers:{Cookie:"__Host-clearinghouse-payment-ORDERTEST123="+token}});
    assert.equal(missing.status,200);assert.match(await missing.text(),/original group invitation/);
    const packet=participantPacket(replayProject(project),"asha");
    const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"agree",proposedBudgetMinor:null,proposedExcludedItemIds:null,note:"",createdAt:new Date().toISOString()};
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},token,"https://wrong.example.test")).status,403);
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},token)).status,403);
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},owner.ownerToken,"https://guests.example.test")).status,403);
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},token,"https://guests.example.test")).status,200);
    const replies=await (await post(local,"/api/participation/responses",{},owner.ownerToken)).json();
    assert.equal(replies.responses.length,1);
    assert.equal(JSON.parse(replies.responses[0].text).answer,"agree");
    const revised=amendProject(project,expectedState(project),{eventId:"http-r2",at:at(3),revision:revision(2)});
    await post(local,"/api/participation/publish",{project:exportProject(revised),memberId:"asha"},owner.ownerToken);
    const changed=await fetch(guests+path);assert.equal(changed.status,200);assert.match(await changed.text(),/Review proposal R2/);
    assert.equal((await post(guests,path+"/continue",{})).status,403);
    assert.equal((await post(guests,path+"/continue",{},null,"https://wrong.example.test")).status,403);
    const next=await post(guests,path+"/continue",{},null,"https://guests.example.test");
    assert.equal(next.status,303);assert.match(next.headers.get("location"),/^\/participant\/[A-Za-z0-9_-]{43}$/);
    assert.notEqual(next.headers.get("location"),path);
    assert.match(await (await fetch(guests+next.headers.get("location"))).text(),/Proposal R2/);
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},token,"https://guests.example.test")).status,409);

    // Unavailable links stay private and read-only, but are usable browser pages.
    const beforeUnavailable = await readFile(join(dir,"participation.json"),"utf8");
    for (const badPath of ["/participant/"+"x".repeat(43), "/participant/incomplete-link"]) {
      const unavailable = await fetch(guests+badPath);
      assert.ok([401,404].includes(unavailable.status));
      assert.match(unavailable.headers.get("content-type"),/text\/html/);
      assert.equal(unavailable.headers.get("cache-control"),"no-store");
      assert.equal(unavailable.headers.get("referrer-policy"),"no-referrer");
      const page=(await unavailable.text()).replace(groupTabFontCss,"");
      assert.match(page,/Ask the person who sent this link/);
      assert.doesNotMatch(page,/<form|<script|Asha|Ben|Authorization|ownerToken/);
    }
    assert.equal(await readFile(join(dir,"participation.json"),"utf8"),beforeUnavailable);
    const expiredDb=JSON.parse(beforeUnavailable);
    for(const room of Object.values(expiredDb.rooms))for(const invite of Object.values(room.invitations))invite.expires=0;
    await writeFile(join(dir,"participation.json"),JSON.stringify(expiredDb));
    const expiredBefore=await readFile(join(dir,"participation.json"),"utf8");
    const expired=await fetch(guests+path);
    assert.equal(expired.status,410);
    assert.match(await expired.text(),/This invitation has expired/);
    assert.equal((await post(guests,"/api/participation/reply",{response:JSON.stringify(response)},token,"https://guests.example.test")).status,410);
    assert.equal((await post(guests,path+"/continue",{},null,"https://guests.example.test")).status,410);
    assert.equal(await readFile(join(dir,"participation.json"),"utf8"),expiredBefore);

  }finally{
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>invitationServer.close(resolve))]);
    await rm(dir,{recursive:true,force:true});
  }
});
