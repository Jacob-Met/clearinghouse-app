import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRefundDesk} from "../app/paypal-refunds.mjs";
import {CheckoutError,minorToUsd} from "../app/paypal-sandbox.mjs";
async function fixture(t,mode="COMPLETED"){
 const dir=await mkdtemp(join(tmpdir(),"refund-test-"));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,"refunds.json"), refunds=[],calls=[];let currentMode=mode;
 const make=()=>createRefundDesk({storagePath:path,now:()=>Date.now(),ErrorClass:CheckoutError,usd:minorToUsd,baseUrl:"https://api-m.sandbox.paypal.com",
 accessToken:async()=>"test",resolve:async(project,orderId)=>{
  if(project!=="owned"||orderId!=="ORDER12345")throw new CheckoutError("Wrong source",409);
  return {projectId:"test-project",orderId,captureId:"CAPTURE12345",captureStatus:refunds.length?"PARTIALLY_REFUNDED":"COMPLETED",amountMinor:6043,refunds:refunds.map(r=>({...r,amountMinor:Number(r.amount.value.replace(".",""))}))};
 },
 fetchImpl:async(url,opts)=>{
  calls.push({url,method:opts.method});
  if(opts.method==="POST"){
   const persisted=JSON.parse(await readFile(path,"utf8"));assert.equal(persisted.records.at(-1).status,"REQUESTING");
   const body=JSON.parse(opts.body);
   if(currentMode==="LOST")throw Error("lost");
   const r={id:"REFUND"+String(refunds.length+1).padStart(8,"0"),amount:body.amount,invoice_id:body.invoice_id,status:currentMode};
   refunds.push(r);return {ok:true,json:async()=>r};
  }
  const found=refunds.find(r=>url.endsWith(r.id));return {ok:Boolean(found),json:async()=>found};
 }});
 return {make,calls,refunds,path,setMode:x=>currentMode=x};
}
test("partial refund uses durable intent, exact cents and same-request observation; restart preserves it",async t=>{
 const f=await fixture(t),d=f.make();const a=await d.refund("owned","ORDER12345",2017,"request-00001");
 assert.equal(a.refundedMinor,2017);assert.equal(a.remainingMinor,4026);assert.equal(a.operations[0].status,"COMPLETED");
 await d.refund("owned","ORDER12345",2017,"request-00001");
 await f.make().refund("owned","ORDER12345",2017,"request-00001");
 assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
 await assert.rejects(d.refund("owned","ORDER12345",2018,"request-00001"),/different terms/);
 await assert.rejects(d.refund("owned","ORDER12345",5000,"request-00002"),/exceeds/);
 const b=await d.refund("owned","ORDER12345",4026,"request-00003");
 assert.equal(b.remainingMinor,0);assert.equal(b.canRefund,false);
});
test("lost response remains unknown after restart and never silently retries",async t=>{
 const f=await fixture(t,"LOST");const a=await f.make().refund("owned","ORDER12345",2017,"request-00001");
 assert.equal(a.canRefund,false);assert.equal(a.operations[0].status,"UNKNOWN");
 await f.make().refund("owned","ORDER12345",2017,"request-00001");
 await assert.rejects(f.make().refund("owned","ORDER12345",2017,"request-00002"),/unresolved/);
 assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
});
test("pending refund blocks new requests until a provider GET confirms completion",async t=>{
 const f=await fixture(t,"PENDING"),d=f.make();
 assert.equal((await d.refund("owned","ORDER12345",2017,"request-00001")).canRefund,false);
 await assert.rejects(d.refund("owned","ORDER12345",100,"request-00002"),/unresolved/);
 f.refunds[0].status="COMPLETED";
 const r=await d.review("owned","ORDER12345");assert.equal(r.canRefund,true);assert.equal(r.remainingMinor,4026);
});
test("wrong project/order and concurrent refund do not send duplicate effects",async t=>{
 const f=await fixture(t),d=f.make();
 await assert.rejects(d.refund("foreign","ORDER12345",1,"request-00001"),/Wrong source/);
 const results=await Promise.allSettled([d.refund("owned","ORDER12345",2017,"request-00002"),d.refund("owned","ORDER12345",2017,"request-00003")]);
 assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
 assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
});
