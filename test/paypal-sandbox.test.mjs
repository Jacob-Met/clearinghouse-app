import test from "node:test";
import assert from "node:assert/strict";
import { createProject, approveProject, expectedState, exportProject } from "../app/core.mjs";
import { creation, at } from "./fixtures.mjs";
import { checkoutPlan, createSandboxCheckout, minorToUsd, CheckoutError } from "../app/paypal-sandbox.mjs";

function approvedProject() {
  let project = createProject(creation());
  for (const [i,id] of ["asha","ben","chen"].entries()) project = approveProject(project, expectedState(project), {eventId:"approve-"+id,at:at(i+3),memberId:id});
  return exportProject(project);
}
test("exact cents and positive member obligations, with no client-provided monetary fields", () => {
  assert.equal(minorToUsd(1), "0.01");
  assert.equal(minorToUsd(9007199254740991), "90071992547409.91");
  const plan = checkoutPlan(approvedProject());
  assert.deepEqual(plan.members.map(m=>m.amountMinor), [6000,10000,6000]);
});
test("refuses unapproved proposal before provider calls", async () => {
  const bare = exportProject(createProject(creation()));
  let calls=0;
  const client=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:async()=>{calls++;throw Error("unexpected")}});
  await assert.rejects(client.prepare(bare),error=>error instanceof CheckoutError && error.status===400);
  assert.equal(calls,0);
});
test("creates one sandbox order per nonzero member; approval links only, never captures", async () => {
  const calls=[];
  const provider=async (url,options)=>{
    calls.push({url,options});
    if(url.endsWith("/token"))return {ok:true,json:async()=>({access_token:"fixture-token",expires_in:3600})};
    const n=calls.filter(c=>c.url.endsWith("/orders")).length;
    return {ok:true,json:async()=>({id:"ORDERABC"+n,links:[{rel:"payer-action",href:"https://www.sandbox.paypal.com/checkoutnow?token=ORDERABC"+n}]})};
  };
  const client=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:provider});
  const first=await client.prepare(approvedProject()),second=await client.prepare(approvedProject());
  assert.equal(first.created.length,3);
  assert.deepEqual(first,second);
  assert.equal(first.total,"220.00");
  assert.equal(calls.length,4);
  const orders=calls.filter(c=>c.url.endsWith("/orders"));
  assert.deepEqual(orders.map(c=>JSON.parse(c.options.body).purchase_units[0].amount.value),["60.00","100.00","60.00"]);
  assert.ok(orders.every(c=>c.options.method==="POST" && !c.url.includes("capture") && c.options.headers["PayPal-Request-Id"].length===36));
  assert.ok(orders.every(c=>JSON.parse(c.options.body).payment_source.paypal.experience_context.user_action==="CONTINUE"));
});
test("refuses foreign redirect links, retaining successfully created partial links",async()=>{
  let count=0;
  const client=createSandboxCheckout({clientId:"fixture",clientSecret:"fixture",fetchImpl:async url=>{
    if(url.endsWith("/token"))return {ok:true,json:async()=>({access_token:"fixture"})};
    count++;
    return {ok:true,json:async()=>({id:"ORDERABC"+count,links:[{rel:"payer-action",href:count===2?"https://phishing.example/pay":"https://www.sandbox.paypal.com/checkoutnow?token=X"}]})};
  }});
  await assert.rejects(client.prepare(approvedProject()),error=>error.status===502&&error.partial.length===1);
});
test("missing sandbox configuration never reaches provider",async()=>{
  const client=createSandboxCheckout({fetchImpl:async()=>{throw Error("provider must not be used")}});
  assert.equal(client.enabled,false);
  await assert.rejects(client.prepare(approvedProject()),error=>error.status===503);
});

test("old created-order links require provider review rather than silent reuse or duplicate issuance", async () => {
  let currentTime = Date.UTC(2026, 10, 9, 18);
  let orderCalls = 0;
  const client = createSandboxCheckout({
    clientId: "fixture", clientSecret: "fixture", now: () => currentTime,
    fetchImpl: async url => {
      if (url.endsWith("/token")) return {ok: true, json: async () => ({access_token: "fixture-token", expires_in: 3600})};
      orderCalls++;
      const id = "ORDERTEST" + orderCalls;
      return {ok: true, json: async () => ({
        id, links: [{rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=" + id}]
      })};
    }
  });
  const source = approvedProject();
  const original = await client.prepare(source);
  assert.equal(orderCalls, 3);
  currentTime += 2 * 60 * 60 * 1000;
  assert.deepEqual(await client.prepare(source), original);
  assert.equal(orderCalls, 3);
  currentTime += 60 * 60 * 1000;
  await assert.rejects(client.prepare(source),
    error => error instanceof CheckoutError && error.status === 409
      && /inspect the order status/.test(error.message));
  assert.equal(orderCalls, 3, "do not return the old links or auto-create another order");
});
