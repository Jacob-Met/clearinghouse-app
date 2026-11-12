import { groupTabFontCss } from "../app/group-tab-font.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {request as httpRequest} from "node:http";
import {mkdtemp,rm,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createProject,exportProject,replayProject,amendProject,expectedState} from "../app/core.mjs";
import {participantPacket,reviewedTerms} from "../app/participant-review.mjs";
import {creation,revision,at} from "./fixtures.mjs";
const source = fileURLToPath(new URL("../server.mjs", import.meta.url));
// Use native HTTP here: Node fetch ignores the explicit Host required to emulate the TLS proxy.
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, options, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,headers:{get:name=>res.headers[name.toLowerCase()]??null},text:async()=>text,json:async()=>JSON.parse(text)});
      });
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

async function freePort() {
  const socket = createServer(); socket.listen(0,"127.0.0.1"); await once(socket,"listening");
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child,"exit"); child.kill("SIGTERM"); await done;
}
test("real two-listener service carries invitations and replies while organizer and payment routes remain private", async () => {
  const dir = await mkdtemp(join(tmpdir(),"clearinghouse-host-"));
  const organizerPort = await freePort(); let recipientPort = await freePort();
  while (recipientPort === organizerPort) recipientPort = await freePort();
  const origin = "https://invited.example:18451", host = new URL(origin).host;
  const local = "http://127.0.0.1:" + organizerPort, remote = "http://127.0.0.1:" + recipientPort;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH","HOME","TMPDIR","LANG"].includes(key)));
  Object.assign(env,{PORT:String(organizerPort),CLEARINGHOUSE_INVITATION_PORT:String(recipientPort),CLEARINGHOUSE_INVITATION_ORIGIN:origin,CLEARINGHOUSE_PARTICIPATION_PATH:join(dir,"participation.json"),CLEARINGHOUSE_PAYPAL_STATE_PATH:join(dir,"paypal.json")});
  let child; let childLog = "", lastProbe = "";
  const launch = async () => {
    child = spawn(process.execPath,[source],{env,stdio:["ignore","pipe","pipe"]});
    child.stdout.on("data", chunk => {childLog += chunk;}); child.stderr.on("data", chunk => {childLog += chunk;});
    for (let i=0;i<100;i++) {
      if (child.exitCode !== null) throw new Error("Service exited before listening.");
      try { const probe = await request(remote+"/healthz",{headers:{Host:host}}); if (probe.ok) return; lastProbe = probe.status + " " + await probe.text(); } catch(error) { lastProbe = error.message; }
      await new Promise(resolve => setTimeout(resolve,30));
    }
    throw new Error("Invitation service did not start: " + lastProbe + " " + childLog);
  };
  const post = (base,action,body,token,extra={}) => request(base+"/api/participation/"+action,{method:"POST",headers:{"Content-Type":"application/json",Origin:base===remote?origin:local,...(base===remote?{Host:host}:{}),...(token?{Authorization:"Bearer "+token}:{}),...extra},body:JSON.stringify(body)});
  try {
    await launch();
    assert.deepEqual(await (await request(remote+"/healthz",{headers:{Host:host}})).json(),{ok:true,product:"clearinghouse-invitations",audience:"participants"});
    let project = createProject(creation());
    const created = await post(local,"create",{project:exportProject(project)});
    assert.equal(created.status,200); const {ownerToken} = await created.json();
    const published = await post(local,"publish",{project:exportProject(project),memberId:"asha"},ownerToken);
    assert.equal(published.status,200); const invitation = await published.json();
    assert.equal(new URL(invitation.path).origin,origin);
    const path = new URL(invitation.path).pathname, token = path.split("/").pop();
    const review = await request(remote+path,{headers:{Host:host}});
    assert.equal(review.status,200); assert.equal(review.headers.get("referrer-policy"),"no-referrer");
    const html = await review.text(); assert.match(html,/Send my response/); assert.ok(!html.replace(groupTabFontCss, "").includes("Ben")); assert.ok(!html.replace(groupTabFontCss, "").includes("Chen"));
    const before = await readFile(env.CLEARINGHOUSE_PARTICIPATION_PATH,"utf8");
    for (const path of ["/","/app.mjs","/api/ai/status","/api/paypal-sandbox","/api/participation/create","/api/participation/publish","/api/participation/responses"]) {
      const response = await request(remote+path,{method:path.startsWith("/api/")?"POST":"GET",headers:{Host:host,Origin:origin,"Content-Type":"application/json",Authorization:"Bearer "+ownerToken},...(path.startsWith("/api/")?{body:"{}"}:{})});
      assert.equal(response.status,404,path);
    }
    assert.equal(await readFile(env.CLEARINGHOUSE_PARTICIPATION_PATH,"utf8"),before);
    assert.equal((await request(remote+"/healthz",{headers:{Host:"other.example","X-Forwarded-Host":host}})).status,421);
    const packet=participantPacket(replayProject(project),"asha");
    const response={format:packet.format,projectId:packet.projectId,revisionId:packet.revisionId,ordinal:packet.ordinal,memberId:packet.memberId,amountMinor:packet.amountMinor,reviewedTerms:reviewedTerms(packet),answer:"propose-limit",proposedBudgetMinor:5500,proposedExcludedItemIds:null,note:"Lower limit",createdAt:new Date().toISOString()};
    const reply={response:JSON.stringify(response)};
    assert.equal((await post(remote,"reply",reply,token,{Origin:"https://other.example"})).status,403);
    assert.equal((await post(remote,"reply",reply,ownerToken)).status,403);
    assert.equal((await post(remote,"reply",reply,token)).status,200);
    assert.equal((await (await post(local,"responses",{},ownerToken)).json()).responses.length,1);
    await stop(child); await launch();
    assert.match(await (await request(remote+path,{headers:{Host:host}})).text(),/Your response was received/);
    assert.equal((await (await post(local,"responses",{},ownerToken)).json()).responses.length,1);
    project=amendProject(project,expectedState(project),{eventId:"next",at:at(3),revision:revision(2)});
    assert.equal((await post(local,"publish",{project:exportProject(project)},ownerToken)).status,200);
    assert.equal((await post(remote,"reply",reply,token)).status,409);
  } finally { if(child) await stop(child); await rm(dir,{recursive:true,force:true}); }
});
