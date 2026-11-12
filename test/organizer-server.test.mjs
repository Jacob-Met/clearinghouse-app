import { groupTabFontCss } from "../app/group-tab-font.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {once} from "node:events";
import {request as httpRequest} from "node:http";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createProject,exportProject} from "../app/core.mjs";
import {creation} from "./fixtures.mjs";

test("hosted organizer authenticates before shared/provider routes and leaves invitations private",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-organizer-http-"));
  const code=randomBytes(32).toString("base64url"),origin="https://groups.example.test",host=new URL(origin).host;
  process.env.CLEARINGHOUSE_PARTICIPATION_PATH=join(dir,"participation.json");
  process.env.CLEARINGHOUSE_PAYPAL_STATE_PATH=join(dir,"paypal.json");
  process.env.CLEARINGHOUSE_INVITATION_ORIGIN=origin;
  process.env.CLEARINGHOUSE_ORGANIZER_CODE=code;
  const {server,invitationServer}=await import("../server.mjs");
  server.listen(0,"127.0.0.1");invitationServer.listen(0,"127.0.0.1");
  await Promise.all([once(server,"listening"),once(invitationServer,"listening")]);
  const base="http://127.0.0.1:"+invitationServer.address().port;
  const request=(url,options)=>new Promise((resolve,reject)=>{
    const req=httpRequest(url,options,res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));});
    req.on("error",reject);req.end(options.body);
  });
  const get=(path,cookie="")=>request(base+path,{headers:{Host:host,...(cookie?{Cookie:cookie}:{})}});
  const post=(path,body={},cookie="",token="",requestOrigin=origin)=>request(base+path,{method:"POST",headers:{Host:host,Origin:requestOrigin,"Content-Type":"application/json",...(cookie?{Cookie:cookie}:{}),...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
  try{
    assert.match(await (await get("/")).text(),/organizer-signin/);
    assert.equal((await get("/organizer-signin.mjs")).status,200);
    assert.equal((await get("/app.mjs")).status,401);
    for(const path of ["/api/participation/create","/api/participation/publish","/api/participation/responses","/api/participation/plans","/api/participation/open","/api/participation/archive","/api/paypal-sandbox","/api/ai/suggest"])
      assert.equal((await post(path)).status,401,path);
    assert.equal((await post("/organizer/login",{code:"wrong"})).status,401);
    assert.equal((await post("/organizer/login",{code},"","","https://wrong.example.test")).status,403);
    const login=await post("/organizer/login",{code});assert.equal(login.status,200);
    const cookieHeader=login.headers.get("set-cookie");assert.match(cookieHeader,/HttpOnly; Secure; SameSite=Strict/);
    const cookie=cookieHeader.split(";")[0];
    assert.match(await (await get("/",cookie)).text(),/organizer-session.mjs/);
    for(const path of ["/app.mjs","/organizer-session.mjs","/api/ai/status"])
      assert.equal((await get(path,cookie)).status,200,path);
    assert.equal((await post("/api/participation/create",{},cookie,"","https://wrong.example.test")).status,403);
    const project=exportProject(createProject(creation()));
    const created=await post("/api/participation/create",{project},cookie);
    assert.equal(created.status,200);const owner=await created.json();
    const planList=await post("/api/participation/plans",{},cookie);
    assert.equal(planList.status,200);
    const plans=(await planList.json()).plans;assert.equal(plans.length,1);
    const login2=await post("/organizer/login",{code}),cookie2=login2.headers.get("set-cookie").split(";")[0];
    const reopened=await post("/api/participation/open",{id:plans[0].id},cookie2);
    assert.equal(reopened.status,200);
    const recovered=await reopened.json();assert.equal(recovered.project,project);
    assert.equal((await post("/api/participation/responses",{},cookie2,recovered.ownerToken)).status,200);
    assert.equal((await post("/api/participation/open",{id:plans[0].id},"",owner.ownerToken)).status,401);
    assert.equal((await post("/api/participation/open",{id:plans[0].id},cookie2,"","https://wrong.example.test")).status,403);
    const published=await post("/api/participation/publish",{project,memberId:"asha"},cookie,owner.ownerToken);
    assert.equal(published.status,200);const invite=await published.json();
    assert.equal(new URL(invite.path).origin,origin);
    const review=await get(new URL(invite.path).pathname);assert.equal(review.status,200);
    assert.ok(!(await review.text()).replace(groupTabFontCss, "").includes("Ben"));
    assert.equal((await post("/api/participation/archive",{id:plans[0].id,archived:true},cookie,"","https://wrong.example.test")).status,403);
    assert.equal((await post("/api/participation/archive",{id:plans[0].id,archived:"true"},cookie)).status,400);
    assert.equal((await post("/api/participation/archive",{id:plans[0].id,archived:true},cookie)).status,200);
    assert.equal((await (await post("/api/participation/plans",{},cookie2)).json()).plans[0].archived,true);
    assert.equal((await (await post("/api/participation/open",{id:plans[0].id},cookie2)).json()).project,project);
    assert.equal((await get(new URL(invite.path).pathname)).status,200,"archival leaves the private invitation available");
    assert.equal((await post("/api/participation/archive",{id:plans[0].id,archived:false},cookie2)).status,200);
    assert.equal((await post("/api/participation/responses",{},"",owner.ownerToken)).status,401,"owner capability alone cannot enter organizer routes");
    assert.equal((await post("/api/paypal-sandbox",{},cookie)).status,400,"authenticated request reaches existing checkout validation");
    assert.equal((await post("/organizer/logout",{},cookie)).status,200);
    assert.equal((await get("/app.mjs",cookie)).status,401);
    assert.match(await (await get("/",cookie)).text(),/organizer-signin/);
    assert.deepEqual(await (await get("/healthz")).json(),{ok:true,product:"clearinghouse-invitations",audience:"participants",organizerConfigured:true});
  }finally{
    await Promise.all([new Promise(resolve=>server.close(resolve)),new Promise(resolve=>invitationServer.close(resolve))]);
    await rm(dir,{recursive:true,force:true});
  }
});
