import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProject, amendProject, approveProject, withdrawApproval, expectedState, exportProject, importProject } from "../app/core.mjs";
import { creation, at, revision } from "./fixtures.mjs";
import { createSandboxCheckout, CheckoutError } from "../app/paypal-sandbox.mjs";

function approvedProject() {
  let project = createProject(creation());
  for (const [i, id] of ["asha", "ben", "chen"].entries()) {
    project = approveProject(project, expectedState(project), { eventId:"approval-"+id, at:at(i+3), memberId:id });
  }
  return exportProject(project);
}

function fixtureProvider() {
  let serial = 0;
  const orders = new Map();
  const calls = { create:0, inspect:0, capture:0, captureRequestIds:[] };
  const json = value => ({ok:true, status:200, json:async()=>structuredClone(value)});
  async function fetchImpl(url, opts={}) {
    const path = new URL(url).pathname;
    if (path === "/v1/oauth2/token") return json({access_token:"fixture-oauth",expires_in:3600});
    if (path === "/v2/checkout/orders" && opts.method === "POST") {
      calls.create++;
      const id = "ORDERTEST" + String(++serial).padStart(4,"0");
      const unit = JSON.parse(opts.body).purchase_units[0];
      orders.set(id,{id,intent:"CAPTURE",status:"CREATED",purchase_units:[unit]});
      return json({id, links:[{rel:"payer-action", href:"https://www.sandbox.paypal.com/checkoutnow?token="+id}]});
    }
    const match = path.match(/^\/v2\/checkout\/orders\/([A-Za-z0-9]+)(\/capture)?$/);
    if (!match || !orders.has(match[1])) throw Error("fixture refused unknown order path");
    const order = orders.get(match[1]);
    if (match[2]) {
      calls.capture++;
      calls.captureRequestIds.push(opts.headers["PayPal-Request-Id"]);
      assert.equal(opts.method,"POST");
      assert.equal(opts.body,"{}");
      assert.equal(order.status,"APPROVED");
      order.status="COMPLETED";
      order.purchase_units[0].payments={captures:[{
        id:"CAPTURE" + match[1],status:"COMPLETED",amount:structuredClone(order.purchase_units[0].amount)
      }]};
      return json(order);
    }
    calls.inspect++;
    assert.equal(opts.method,"GET");
    return json(order);
  }
  return {orders,calls,fetchImpl,approve:id=>{orders.get(id).status="APPROVED";}};
}

test("prepared member must actually approve; one deliberate sandbox capture settles only that member",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
  const prepared=await checkout.prepare(source);
  assert.deepEqual(prepared.created.map(x=>x.amount),["60.00","100.00","60.00"]);
  assert.equal((await checkout.inspect(source,"asha")).status,"CREATED");
  await assert.rejects(checkout.capture(source,"asha"),e=>e instanceof CheckoutError&&e.status===409);
  assert.equal(provider.calls.capture,0);
  provider.approve(prepared.created[0].orderId);
  const first=await checkout.capture(source,"asha");
  assert.equal(first.status,"COMPLETED");
  assert.equal(first.captured,true);
  assert.equal(first.amount,"60.00");
  assert.match(first.captureId,/^CAPTURE/);
  assert.equal(provider.calls.capture,1);
  assert.deepEqual(await checkout.capture(source,"asha"),first);
  assert.equal(provider.calls.capture,1,"provider-confirmed repeat must not issue another capture");
  assert.equal((await checkout.inspect(source,"ben")).captured,false,"other members are not settled by Asha");
});

test("refuse arbitrary member, changed declarations, mismatched provider money and old order links",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
  const prepared=await checkout.prepare(source);
  await assert.rejects(checkout.inspect(source,"nonmember"),e=>e.status===400);
  let rewritten=importProject(source);
  rewritten=withdrawApproval(rewritten,expectedState(rewritten),{eventId:"withdraw-asha",at:at(10),memberId:"asha"});
  rewritten=approveProject(rewritten,expectedState(rewritten),{eventId:"fresh-asha",at:at(11),memberId:"asha"});
  await assert.rejects(checkout.inspect(exportProject(rewritten),"asha"),e=>e.status===409);
  const fresh=await checkout.prepare(exportProject(rewritten));
  assert.notEqual(fresh.created[0].orderId,prepared.created[0].orderId,"changed approval evidence must not reuse the previous order");
  provider.approve(fresh.created[0].orderId);
  const order=provider.orders.get(fresh.created[0].orderId);
  order.purchase_units[0].amount.value="99.99";
  await assert.rejects(checkout.capture(exportProject(rewritten),"asha"),e=>e.status===409&&/amount/.test(e.message));
  assert.equal(provider.calls.capture,0);
});

test("a completed order with a pending capture is not a verified settlement",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
  const prepared=await checkout.prepare(source);
  const order=provider.orders.get(prepared.created[0].orderId);
  order.status="COMPLETED";
  order.purchase_units[0].payments={captures:[{id:"CAPTUREPENDING1",status:"PENDING",amount:structuredClone(order.purchase_units[0].amount)}]};
  const observed=await checkout.inspect(source,"asha");
  assert.equal(observed.captured,false);
  assert.equal(observed.captureStatus,"PENDING");
  await assert.rejects(checkout.capture(source,"asha"),e=>e.status===409);
  assert.equal(provider.calls.capture,0);
});

test("capture is single-flight under concurrent explicit clicks",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
  const prepared=await checkout.prepare(source);
  provider.approve(prepared.created[1].orderId);
  const [a,b]=await Promise.all([checkout.capture(source,"ben"),checkout.capture(source,"ben")]);
  assert.deepEqual(a,b);
  assert.equal(a.amount,"100.00");
  assert.equal(provider.calls.capture,1);
  assert.equal(provider.calls.captureRequestIds[0].length,36);
});

test("prepared orders and provider-confirmed captures recover after independent server restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clearinghouse-paypal-restart-"));
  const storagePath = join(dir, "orders.json");
  const provider = fixtureProvider(), source = approvedProject();
  const client = () => createSandboxCheckout({
    clientId:"private-client", clientSecret:"private-secret",
    fetchImpl:provider.fetchImpl, storagePath
  });
  try {
    const original = await client().prepare(source);
    assert.equal(provider.calls.create,3);
    const raw = await readFile(storagePath,"utf8");
    assert.match(raw,/"version":1/);
    assert.ok(!raw.includes("private-secret") && !raw.includes("fixture-oauth"),
      "recovery file stores order identity but never provider credentials or OAuth tokens");
    const afterRestart = client();
    assert.deepEqual(await afterRestart.prepare(source),original);
    assert.equal(provider.calls.create,3,"server restart must not issue second orders");
    provider.approve(original.created[0].orderId);
    const captured = await afterRestart.capture(source,"asha");
    assert.equal(captured.captured,true);
    const thirdServer = client();
    assert.equal((await thirdServer.inspect(source,"asha")).captureId,captured.captureId);
    assert.equal((await thirdServer.capture(source,"asha")).captured,true);
    assert.equal(provider.calls.capture,1,"recovery must not re-capture completed order");
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("corrupt persisted order file refuses new provider creation rather than silently discarding receipts",async()=>{
  const dir = await mkdtemp(join(tmpdir(),"clearinghouse-paypal-corrupt-"));
  const storagePath = join(dir,"orders.json");
  const provider = fixtureProvider();
  try {
    await writeFile(storagePath,'{"version":1,"rows":[{"key":"forged"}]}');
    const checkout = createSandboxCheckout({
      clientId:"fixture", clientSecret:"fixture", fetchImpl:provider.fetchImpl, storagePath
    });
    await assert.rejects(checkout.prepare(approvedProject()),e=>e instanceof CheckoutError && e.status===503);
    assert.equal(provider.calls.create,0);
    assert.match(await readFile(storagePath,"utf8"),/"forged"/,"corrupt source remains available for diagnosis");
  } finally { await rm(dir,{recursive:true,force:true}); }
});

test("whole-group reconciliation distinguishes exact verified cents from pending and unavailable provider evidence",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  let outageOrder=null;
  const checkout=createSandboxCheckout({
    clientId:"fixture",clientSecret:"fixture",
    fetchImpl:async(url,options)=>{
      if(outageOrder && new URL(url).pathname === "/v2/checkout/orders/"+outageOrder &&
          options.method === "GET") throw new Error("simulated provider outage");
      return provider.fetchImpl(url,options);
    }
  });
  const prepared=await checkout.prepare(source);
  const before=await checkout.reconcile(source);
  assert.equal(before.total,"220.00");
  assert.equal(before.confirmed,"0.00");
  assert.equal(before.notConfirmed,"220.00");
  assert.equal(before.uncertain,"0.00");
  assert.equal(before.members.length,3);
  assert.equal(provider.calls.capture,0,"a read-only check must never capture an order");
  provider.approve(prepared.created[0].orderId);
  await checkout.capture(source,"asha");
  const partial=await checkout.reconcile(source);
  assert.equal(partial.confirmed,"60.00");
  assert.equal(partial.notConfirmed,"160.00");
  assert.equal(partial.allCaptured,false);
  assert.deepEqual(partial.members.map(m=>m.captured),[true,false,false]);
  const ben=provider.orders.get(prepared.created[1].orderId);
  ben.status="COMPLETED";
  ben.purchase_units[0].payments={captures:[{
    id:"PENDINGCAPTURE1",status:"PENDING",amount:structuredClone(ben.purchase_units[0].amount)
  }]};
  outageOrder=prepared.created[2].orderId;
  const uncertain=await checkout.reconcile(source);
  assert.equal(uncertain.confirmed,"60.00");
  assert.equal(uncertain.notConfirmed,"160.00");
  assert.equal(uncertain.uncertain,"160.00");
  assert.equal(uncertain.members[1].captureStatus,"PENDING");
  assert.equal(uncertain.members[1].captured,false);
  assert.equal(uncertain.members[2].status,"UNKNOWN");
  assert.equal(provider.calls.capture,1,"reconciliation must not initiate payment");
});

test("group status never attributes previously captured funds to new local approval evidence",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({
    clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl
  });
  const prepared=await checkout.prepare(source);
  provider.approve(prepared.created[0].orderId);
  await checkout.capture(source,"asha");
  let rewritten=importProject(source);
  rewritten=withdrawApproval(rewritten,expectedState(rewritten),
    {eventId:"reconcile-withdraw",at:at(13),memberId:"asha"});
  rewritten=approveProject(rewritten,expectedState(rewritten),
    {eventId:"reconcile-reapprove",at:at(14),memberId:"asha"});
  const fresh=await checkout.reconcile(exportProject(rewritten));
  assert.equal(fresh.total,"220.00");
  assert.equal(fresh.confirmed,"0.00");
  assert.equal(fresh.notConfirmed,"220.00");
  assert.equal(fresh.members[0].status,"NOT_PREPARED");
  assert.equal(provider.calls.capture,1,"old external capture not forgotten or falsely counted against new agreement");
});

test("real loopback HTTP entrypoint enforces origin and uses the fixture provider through capture",async()=>{
  const realFetch=globalThis.fetch;
  const provider=fixtureProvider();
  const recoveryDir = await mkdtemp(join(tmpdir(), "clearinghouse-http-paypal-"));
  process.env.CLEARINGHOUSE_PAYPAL_STATE_PATH = join(recoveryDir, "orders.json");
  process.env.PAYPAL_SANDBOX_CLIENT_ID="fixture";
  process.env.PAYPAL_SANDBOX_CLIENT_SECRET="fixture";
  globalThis.fetch=async(url,options)=>String(url).startsWith("https://api-m.sandbox.paypal.com")
    ? provider.fetchImpl(url,options) : realFetch(url,options);
  const {server}=await import("../server.mjs?pay-sandbox-http-capture");
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  const base="http://127.0.0.1:"+server.address().port;
  const project=approvedProject();
  const post=(path,body,origin=base)=>realFetch(base+path,{
    method:"POST",headers:{"Content-Type":"application/json",Origin:origin,Host:"127.0.0.1:"+server.address().port},
    body:JSON.stringify(body)
  });
  try {
    const forbidden=await post("/api/paypal-sandbox/capture",{project,memberId:"asha"},"https://foreign.example");
    assert.equal(forbidden.status,403);
    const invented=await post("/api/paypal-sandbox/capture",{project,memberId:"asha",orderId:"FORGEDORDER"});
    assert.equal(invented.status,400);
    const prepare=await post("/api/paypal-sandbox",{project});
    assert.equal(prepare.status,200);
    const created=(await prepare.json()).created;
    assert.equal(created.length,3);
    const before=await post("/api/paypal-sandbox/status",{project,memberId:"asha"});
    assert.equal(before.status,200);
    assert.equal((await before.json()).order.captured,false);
    const unapproved=await post("/api/paypal-sandbox/capture",{project,memberId:"asha"});
    assert.equal(unapproved.status,409);
    provider.approve(created[0].orderId);
    const captured=await post("/api/paypal-sandbox/capture",{project,memberId:"asha"});
    assert.equal(captured.status,200);
    assert.equal((await captured.json()).order.captured,true);
    const other=await post("/api/paypal-sandbox/status",{project,memberId:"ben"});
    assert.equal((await other.json()).order.captured,false);
    assert.equal(provider.calls.capture,1);
    const group=await post("/api/paypal-sandbox/reconcile",{project});
    assert.equal(group.status,200);
    const groupBody=(await group.json()).reconciliation;
    assert.equal(groupBody.confirmed,"60.00");
    assert.equal(groupBody.total,"220.00");
    assert.equal(groupBody.members.length,3);
    assert.equal(groupBody.members[0].captured,true);
    assert.equal(groupBody.members[1].captured,false);
    const extraField=await post("/api/paypal-sandbox/reconcile",{project,memberId:"asha"});
    assert.equal(extraField.status,400);
    const forbiddenGroup=await post("/api/paypal-sandbox/reconcile",{project},"https://other.example");
    assert.equal(forbiddenGroup.status,403);
    assert.equal((await post("/api/paypal-sandbox/capture",{project,memberId:"asha"})).status,200);
    assert.equal(provider.calls.capture,1);
    const next=revision(2);next.items[0].unitMinor=2000;
    const amended=amendProject(importProject(project),expectedState(importProject(project)),{eventId:"http-amend",at:at(12),revision:next});
    const historyResponse=await post("/api/paypal-sandbox/history",{project:exportProject(amended)});
    assert.equal(historyResponse.status,200);
    const history=(await historyResponse.json()).history;
    assert.equal(history.orders[0].amount,"60.00");assert.equal(history.orders[0].captured,true);
    assert.equal(history.ordinal,2);
    assert.equal((await post("/api/paypal-sandbox/history",{project:exportProject(amended),orderId:created[0].orderId})).status,400);
    assert.equal((await post("/api/paypal-sandbox/history",{project},"https://foreign.example")).status,403);
    assert.equal(provider.calls.capture,1);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    globalThis.fetch=realFetch;
    delete process.env.PAYPAL_SANDBOX_CLIENT_ID;
    delete process.env.PAYPAL_SANDBOX_CLIENT_SECRET;
    delete process.env.CLEARINGHOUSE_PAYPAL_STATE_PATH;
    await rm(recoveryDir,{recursive:true,force:true});
  }
});

test("prior captured payment survives amendment, removed member and restart without settling new allocation",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearing-history-")), storagePath=join(dir,"orders.json");
  const provider=fixtureProvider();
  const client=()=>createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl,storagePath});
  try {
    const source=approvedProject(), checkout=client(), prepared=await checkout.prepare(source);
    provider.approve(prepared.created[0].orderId);
    await checkout.capture(source,"asha");
    let project=importProject(source);
    const next=revision(2);next.items[0].unitMinor=2000;
    project=amendProject(project,expectedState(project),{eventId:"amend-2",at:at(12),revision:next});
    const observed=await client().history(exportProject(project));
    assert.equal(observed.orders.length,3);
    const paid=observed.orders.find(row=>row.memberId==="asha");
    assert.equal(paid.amount,"60.00");assert.equal(paid.captured,true);
    assert.equal(paid.ordinal,1);assert.equal(paid.currentMember,true);
    assert.equal(paid.agreementSequence,4);assert.ok(paid.preparedAt);
    assert.equal(observed.ordinal,2);
    await assert.rejects(checkout.reconcile(exportProject(project)),/declaration/);
    const removed=revision(3);removed.members=removed.members.filter(m=>m.id!=="asha");
    for(const item of removed.items)item.weights=item.weights.filter(w=>w.memberId!=="asha");
    project=amendProject(project,expectedState(project),{eventId:"amend-3",at:at(13),revision:removed});
    assert.equal((await client().history(exportProject(project))).orders.find(r=>r.memberId==="asha").currentMember,false);
    assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("same-revision withdrawal and reapproval preserve distinct historical bindings but exclude active orders",async()=>{
  const provider=fixtureProvider(),checkout=createSandboxCheckout({clientId:"f",clientSecret:"f",fetchImpl:provider.fetchImpl});
  let project=importProject(approvedProject());
  const old=await checkout.prepare(exportProject(project));
  assert.deepEqual((await checkout.history(exportProject(project))).orders,[]);
  project=withdrawApproval(project,expectedState(project),{eventId:"withdraw",at:at(10),memberId:"asha"});
  assert.equal((await checkout.history(exportProject(project))).orders.length,3);
  project=approveProject(project,expectedState(project),{eventId:"again",at:at(11),memberId:"asha"});
  const fresh=await checkout.prepare(exportProject(project));
  const history=await checkout.history(exportProject(project));
  assert.deepEqual(history.orders.map(r=>r.orderId),old.created.map(r=>r.orderId));
  assert.ok(history.orders.every(r=>!fresh.created.some(n=>n.orderId===r.orderId)));
  const forged=JSON.parse(exportProject(project));forged.events[1].eventId="different-source";
  assert.deepEqual((await checkout.history(JSON.stringify(forged))).orders,[]);
  assert.equal(provider.calls.capture,0);
});

test("history retains uncertainty and source amount, never invents refund/net money, and skips unrelated registries",async()=>{
  const provider=fixtureProvider();let unavailable=false;
  const checkout=createSandboxCheckout({clientId:"f",clientSecret:"f",fetchImpl:async(url,opts)=>{
    if(unavailable&&opts.method==="GET")throw Error("offline");
    return provider.fetchImpl(url,opts);
  }});
  let project=importProject(approvedProject());const prepared=await checkout.prepare(exportProject(project));
  project=withdrawApproval(project,expectedState(project),{eventId:"withdraw",at:at(10),memberId:"asha"});
  const order=provider.orders.get(prepared.created[0].orderId);
  order.status="COMPLETED";order.purchase_units[0].payments={captures:[{id:"CAPTURETEST1",status:"PARTIALLY_REFUNDED",amount:order.purchase_units[0].amount}]};
  let history=await checkout.history(exportProject(project));
  assert.equal(history.orders[0].captureStatus,"PARTIALLY_REFUNDED");assert.equal(history.orders[0].captured,false);
  unavailable=true;history=await checkout.history(exportProject(project));
  assert.ok(history.orders.every(r=>r.status==="UNKNOWN"&&!r.captured&&r.orderId&&r.amount));
  assert.equal(history.orders[0].amount,"60.00");
  const noCredentials=createSandboxCheckout({fetchImpl:()=>{throw Error("must not call provider");}});
  assert.deepEqual((await noCredentials.history(exportProject(project))).orders,[]);
  const unrelated=JSON.parse(exportProject(project));unrelated.projectId="different-project";
  for(const event of unrelated.events)if(event.projectId)event.projectId="different-project";
  assert.deepEqual((await checkout.history(JSON.stringify(unrelated))).orders,[]);
  assert.equal(provider.calls.capture,0);
});


test("historical refresh caps provider reads at four across many approval lineages",async()=>{
  const provider=fixtureProvider();let active=0,peak=0;
  const checkout=createSandboxCheckout({clientId:"f",clientSecret:"f",fetchImpl:async(url,opts)=>{
    if(opts.method!=="GET")return provider.fetchImpl(url,opts);
    active++;peak=Math.max(peak,active);
    try {await new Promise(resolve=>setTimeout(resolve,5));return await provider.fetchImpl(url,opts);}
    finally{active--;}
  }});
  let project=importProject(approvedProject());
  for(let i=0;i<3;i++){
    await checkout.prepare(exportProject(project));
    project=withdrawApproval(project,expectedState(project),{eventId:"withdraw-"+i,at:at(20+i*2),memberId:"asha"});
    project=approveProject(project,expectedState(project),{eventId:"again-"+i,at:at(21+i*2),memberId:"asha"});
  }
  const history=await checkout.history(exportProject(project));
  assert.equal(history.orders.length,9);assert.equal(peak,4);assert.equal(provider.calls.capture,0);
});

test("invited payer review reads only its source-bound order and never prepares or captures",async()=>{
  const provider=fixtureProvider(), source=approvedProject();
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
  assert.equal((await checkout.payerReview(source,"asha")).prepared,undefined);
  assert.equal(provider.calls.create,0);assert.equal(provider.calls.inspect,0);
  const prepared=await checkout.prepare(source);
  let review=await checkout.payerReview(source,"asha");
  assert.deepEqual(review.prepared.created,[prepared.created[0]]);
  assert.equal(review.order.memberId,"asha");assert.equal(provider.calls.inspect,1);
  assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,0);
  provider.orders.get(prepared.created[0].orderId).purchase_units[0].amount.value="0.01";
  review=await checkout.payerReview(source,"asha");
  assert.equal(review.order.status,"UNKNOWN");assert.equal(review.order.captured,false);
  assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,0);
  await assert.rejects(checkout.payerReview(source,"stranger"));
});

test("group reconciliation restores existing payer controls after restart without preparing another order",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-current-"));
  try {
    const provider=fixtureProvider(),source=approvedProject(),storagePath=join(dir,"orders.json");
    let checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl,storagePath});
    const prepared=await checkout.prepare(source);
    provider.approve(prepared.created[0].orderId);
    await checkout.capture(source,"asha");
    checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl,storagePath});
    const found=await checkout.reconcile(source);
    assert.deepEqual(found.prepared.created,prepared.created);
    assert.equal(found.members[0].captured,true);
    assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,1);
    let changed=importProject(source);
    changed=withdrawApproval(changed,expectedState(changed),{eventId:"withdraw-current",at:at(20),memberId:"asha"});
    changed=approveProject(changed,expectedState(changed),{eventId:"renew-current",at:at(21),memberId:"asha"});
    assert.deepEqual((await checkout.reconcile(exportProject(changed))).prepared.created,[]);
    assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,1);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("former payer review reads only the original person's history and never offers current checkout",async()=>{
 const provider=fixtureProvider(),source=approvedProject();
 const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl});
 const prepared=await checkout.prepare(source);
 provider.approve(prepared.created[0].orderId);await checkout.capture(source,"asha");
 let project=importProject(source),next=revision(2);
 next.members=next.members.filter(m=>m.id!=="asha");
 for(const item of next.items)item.weights=item.weights.filter(w=>w.memberId!=="asha");
 project=amendProject(project,expectedState(project),{eventId:"former-payer",at:at(12),revision:next});
 const review=await checkout.payerReview(exportProject(project),"asha");
 assert.equal(review.prepared,undefined);assert.equal(review.order,undefined);
 assert.equal(review.history.orders.length,1);assert.equal(review.history.orders[0].memberId,"asha");
 assert.equal(review.history.orders[0].orderId,prepared.created[0].orderId);
 assert.equal(review.history.orders[0].captured,true);
 assert.equal(review.settlement.member.current,false);
 assert.equal(review.settlement.member.refundDueMinor,6000);
 assert.equal(review.settlement.member.topUpMinor,0);
 const old=provider.orders.get(prepared.created[0].orderId),capture=old.purchase_units[0].payments.captures[0];
 capture.status="PARTIALLY_REFUNDED";
 old.purchase_units[0].payments.refunds=[{id:"RETURNREMOVED01",status:"COMPLETED",amount:{currency_code:"USD",value:"20.00"},
  links:[{rel:"up",href:"https://api-m.sandbox.paypal.com/v2/payments/captures/"+capture.id}]}];
 const partial=await checkout.payerReview(exportProject(project),"asha");
 assert.equal(partial.settlement.member.refundDueMinor,4000);
 assert.equal(partial.settlement.member.knownRefundedMinor,2000);
 old.purchase_units[0].payments.refunds.push({id:"RETURNPENDING01",status:"PENDING",amount:{currency_code:"USD",value:"10.00"},
  links:[{rel:"up",href:"https://api-m.sandbox.paypal.com/v2/payments/captures/"+capture.id}]});
 assert.equal((await checkout.payerReview(exportProject(project),"asha")).settlement.member.known,false);
 capture.status="REFUNDED";old.purchase_units[0].payments.refunds=[];
 const returned=await checkout.payerReview(exportProject(project),"asha");
 assert.equal(returned.settlement.member.refundDueMinor,0);assert.equal(returned.settlement.member.knownRefundedMinor,6000);
 provider.orders.delete(prepared.created[0].orderId);
 assert.equal((await checkout.payerReview(exportProject(project),"asha")).settlement.member.known,false);
 assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,1);
});

test("changed-plan settlement reads original captures without preparing or moving money",async()=>{
  const provider=fixtureProvider(),source=approvedProject();
  let outage=null;
  const checkout=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:async(url,options)=>{
    if(outage&&new URL(url).pathname.endsWith("/"+outage)&&options.method==="GET")throw Error("unavailable");
    return provider.fetchImpl(url,options);
  }});
  const prepared=await checkout.prepare(source);
  for(const payer of prepared.created){provider.approve(payer.orderId);await checkout.capture(source,payer.id);}
  const changed=netChangedProject(source),result=await checkout.settlement(changed);
  assert.equal(result.heldMinor,22000);assert.equal(result.topUpMinor,2000);assert.equal(result.refundDueMinor,8000);
  assert.equal(result.members.find(x=>x.memberId==="chen").refundDueMinor,6000);
  assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,3);
  outage=prepared.created[1].orderId;
  const uncertain=await checkout.settlement(changed);
  assert.equal(uncertain.known,false);assert.equal(uncertain.members.find(x=>x.memberId==="ben").topUpMinor,null);
  assert.equal(uncertain.members.find(x=>x.memberId==="asha").creditMinor,4000);
  assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,3);
  outage=null;
  const payment=provider.orders.get(prepared.created[0].orderId).purchase_units[0].payments;
  payment.captures[0].status="PARTIALLY_REFUNDED";
  assert.equal((await checkout.settlement(changed)).members.find(x=>x.memberId==="asha").known,false);
  payment.refunds=[{id:"REFUNDASHA0001",status:"COMPLETED",amount:{currency_code:"USD",value:"20.00"},links:[{rel:"up",href:"https://api-m.sandbox.paypal.com/v2/payments/captures/"+payment.captures[0].id}]}];
  const afterRefund=await checkout.settlement(changed);
  assert.equal(afterRefund.members.find(x=>x.memberId==="asha").heldMinor,4000);
  assert.equal(afterRefund.members.find(x=>x.memberId==="asha").refundDueMinor,0);
  assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,3);
  await assert.rejects(checkout.prepare(changed),/retained payments/);
  await assert.rejects(checkout.prepareSettlement(changed,"0".repeat(64)),/changed|uncertain/);
  const topups=await checkout.prepareSettlement(changed,afterRefund.reviewId);
  assert.deepEqual(topups.created.map(row=>[row.id,row.amount,row.obligationMinor,row.creditMinor]),[["ben","20.00",12000,10000]]);
  assert.equal(topups.skipped.find(row=>row.id==="asha").creditMinor,4000);
  assert.equal(provider.calls.create,4);assert.equal(provider.calls.capture,3);
  await assert.rejects(checkout.capture(source,"asha"),/newer payment plan/);
  const departed=provider.orders.get(prepared.created[2].orderId).purchase_units[0].payments;
  departed.captures[0].status="REFUNDED";
  provider.approve(topups.created[0].orderId);
  await checkout.capture(changed,"ben");
  const complete=await checkout.reconcile(changed);
  assert.equal(complete.settlement.settled,true);
  assert.equal(complete.settlement.heldMinor,16000);
  assert.equal(complete.allCaptured,true);
  assert.equal(provider.calls.create,4);assert.equal(provider.calls.capture,4);
});

function netChangedProject(source){
  let project=importProject(source);
  project=amendProject(project,expectedState(project),{eventId:"net-change",at:at(20),revision:revision(2,{
    members:[{id:"asha",name:"Asha",budgetMinor:20000},{id:"ben",name:"Ben",budgetMinor:20000}],
    items:[{id:"event",label:"Changed event",unitMinor:16000,quantity:1,weights:[{memberId:"asha",units:1},{memberId:"ben",units:3}]}]
  })});
  for(const [i,memberId] of ["asha","ben"].entries())
    project=approveProject(project,expectedState(project),{eventId:"net-approve-"+memberId,at:at(21+i),memberId});
  return exportProject(project);
}

test("reviewed top-ups and accepted history persist; changed retained credit prevents another capture",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-net-restart-")),storagePath=join(dir,"orders.json");
  const provider=fixtureProvider(),source=approvedProject();
  const open=()=>createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider.fetchImpl,storagePath});
  try{
    const first=open(),initial=await first.prepare(source);
    for(const row of initial.created){provider.approve(row.orderId);await first.capture(source,row.id);}
    const changed=netChangedProject(source),review=await first.settlement(changed);
    const prepared=await first.prepareSettlement(changed,review.reviewId);
    assert.equal(prepared.created.length,1);assert.equal(prepared.created[0].amount,"20.00");
    const saved=JSON.parse(await readFile(storagePath,"utf8"));
    assert.equal(saved.version,2);assert.equal(saved.fundingPlans.length,1);assert.equal(saved.projectHeads.length,1);
    const restored=open();
    assert.deepEqual(await restored.prepareSettlement(changed,review.reviewId),prepared);
    assert.equal(provider.calls.create,4);
    await assert.rejects(restored.prepare(source),/newer payment plan/);
    provider.approve(prepared.created[0].orderId);
    const prior=provider.orders.get(initial.created[1].orderId).purchase_units[0].payments.captures[0];
    prior.status="REFUNDED";
    await assert.rejects(restored.capture(changed,"ben"),/Earlier payments changed/);
    await assert.rejects(restored.prepareSettlement(changed,review.reviewId),/Earlier payments changed/);
    assert.equal(provider.calls.capture,3);assert.equal(provider.calls.create,4);
    const reconciled=await restored.reconcile(changed);
    assert.equal(reconciled.settlement.paymentPlanCurrent,false);assert.equal(reconciled.allCaptured,false);
    const payer=await restored.payerReview(changed,"ben");
    assert.equal(payer.order.status,"UNKNOWN");
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("failed history reads retain a source-bound earlier return across restart without current settlement authority",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-earlier-return-")),storagePath=join(dir,"orders.json");
  const provider=fixtureProvider(),source=approvedProject();let outage=false,clock=Date.UTC(2026,10,12,1);
  const client=()=>createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",storagePath,now:()=>clock,
    fetchImpl:async(url,options)=>{if(outage&&options.method==="GET")throw Error("unavailable");return provider.fetchImpl(url,options);}});
  try{
    const desk=client(),prepared=await desk.prepare(source);
    const original=provider.orders.get(prepared.created[0].orderId);
    original.status="COMPLETED";original.purchase_units[0].payments={captures:[{id:"RETURNEDCAPTURE01",status:"REFUNDED",amount:structuredClone(original.purchase_units[0].amount)}]};
    const p=importProject(source),next=revision(2);next.items[0].unitMinor=2000;
    const changed=exportProject(amendProject(p,expectedState(p),{eventId:"return-history-change",at:at(12),revision:next}));
    const fresh=await desk.history(changed,"asha");assert.equal(fresh.orders[0].captureStatus,"REFUNDED");
    const saved=await readFile(storagePath,"utf8");
    clock+=60000;await desk.history(changed,"asha");assert.equal(await readFile(storagePath,"utf8"),saved,"unchanged facts do not churn the journal");
    outage=true;
    const restarted=client(),prior=await restarted.history(changed,"asha"),row=prior.orders[0];
    assert.equal(row.status,"UNKNOWN");assert.equal(row.captured,false);assert.equal(row.captureId,null);
    assert.equal(row.previousObservation.refundedMinor,6000);assert.equal(row.previousObservation.heldMinor,0);
    assert.equal(row.previousObservation.orderId,original.id);assert.equal(row.previousObservation.captureId,"RETURNEDCAPTURE01");
    assert.equal(row.previousObservation.checkedAt,"2026-11-12T01:00:00.000Z");
    const net=await restarted.settlement(changed);assert.equal(net.known,false);assert.equal(net.settled,false);
    await assert.rejects(restarted.refundReview(changed,original.id));
    assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,0);
    outage=false;assert.equal((await restarted.history(changed,"asha")).orders[0].previousObservation,undefined);
    const corrupt=JSON.parse(saved);const observed=corrupt.rows.find(r=>r.previousObservation);
    observed.previousObservation.orderId="OTHERORDER001";await writeFile(storagePath,JSON.stringify(corrupt));
    await assert.rejects(client().history(changed,"asha"),/prior payment observation is invalid/);
    assert.equal(provider.calls.create,3);assert.equal(provider.calls.capture,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});
