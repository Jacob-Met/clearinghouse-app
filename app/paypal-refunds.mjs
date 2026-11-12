import {readFile,writeFile,mkdir,rename} from "node:fs/promises";
import {dirname} from "node:path";
import {createHash,randomBytes} from "node:crypto";

// One durable local process owns this desk. Provider responses remain the money authority.
export function createRefundDesk({resolve,accessToken,fetchImpl,baseUrl,storagePath,now,ErrorClass,usd}) {
  const records=new Map(),locks=new Map(); let loaded, saving=Promise.resolve();
  const fail=(message,status=409)=>{throw new ErrorClass(message,status);};
  const validId=x=>typeof x==="string"&&/^[A-Za-z0-9-]{8,80}$/.test(x);
  async function restore(){
    if(!loaded)loaded=(async()=>{
      if(!storagePath)return;
      let text;try{text=await readFile(storagePath,"utf8");}catch(e){if(e.code==="ENOENT")return;fail("Refund recovery file is unreadable. No refund will be requested.",503);}
      let doc;try{doc=JSON.parse(text);}catch{fail("Refund recovery file is invalid. Inspect it before requesting money movement.",503);}
      if(doc.version!==1||!Array.isArray(doc.records)||doc.records.length>10000)fail("Unsupported refund recovery file.",503);
      for(const r of doc.records){
        if(!validId(r.requestId)||!validId(r.orderId)||!validId(r.captureId)||typeof r.projectId!=="string"||!Number.isSafeInteger(r.amountMinor)||r.amountMinor<=0||!["REQUESTING","UNKNOWN","PENDING","COMPLETED","FAILED","CANCELLED"].includes(r.status)||records.has(r.requestId))fail("Invalid saved refund request. No refund will be requested.",503);
        records.set(r.requestId,r);
      }
    })();
    await loaded;
  }
  async function persist(){
    if(!storagePath)return;
    const task=saving.then(async()=>{
      await mkdir(dirname(storagePath),{recursive:true,mode:0o700});
      const tmp=storagePath+".tmp-"+randomBytes(8).toString("hex");
      await writeFile(tmp,JSON.stringify({version:1,records:[...records.values()]})+"\n",{mode:0o600,flag:"wx"});
      await rename(tmp,storagePath);
    });saving=task.catch(()=>{});try{await task;}catch{fail("Refund recovery could not be saved. Do not repeat the request; inspect provider status.",503);}
  }
  function accept(r,body){
    if(!validId(body.id)||body.amount?.currency_code!=="USD"||body.amount.value!==usd(r.amountMinor)||!["PENDING","COMPLETED","FAILED","CANCELLED"].includes(body.status)||(r.refundId&&body.id!==r.refundId))fail("Refund response identity or amount does not match. Outcome remains unknown.",502);
    r.refundId=body.id;r.status=body.status;r.checkedAt=new Date(now()).toISOString();r.message=null;
  }
  async function review(project,orderId){
    await restore();
    return reviewResolved(await resolve(project,orderId));
  }
  async function reviewResolved(context){
    await restore();
    const orderId=context.orderId;
    const ops=[...records.values()].filter(r=>r.projectId===context.projectId&&r.orderId===orderId);
    const bearer=await accessToken();
    for(const r of ops){
      if(r.refundId){
        try{
          const res=await fetchImpl(baseUrl+"/v2/payments/refunds/"+encodeURIComponent(r.refundId),{method:"GET",headers:{Authorization:"Bearer "+bearer},signal:AbortSignal.timeout(15000)});
          if(!res.ok)throw Error("unverified");accept(r,await res.json());
        }catch{r.status="UNKNOWN";r.message="Refund status could not be verified. Check again; no new refund will be requested.";}
      }else if(r.status==="REQUESTING"||r.status==="UNKNOWN"){
        const found=context.refunds.find(row=>row.invoice_id===r.requestId);
        if(found){try{accept(r,found);}catch{r.status="UNKNOWN";}}
        else{r.status="UNKNOWN";r.message="The request may have reached PayPal, but no matching refund is verified. Inspect PayPal before any new request.";}
      }
    }
    if(ops.length)await persist();
    const providerTotal=context.refunds.filter(r=>r.status==="COMPLETED").reduce((s,r)=>s+r.amountMinor,0);
    const completed=ops.filter(r=>r.status==="COMPLETED");
    // Combine by provider refund ID; do not count a response and order record twice.
    const known=new Map(context.refunds.filter(r=>r.status==="COMPLETED").map(r=>[r.id,r.amountMinor]));
    for(const r of completed)known.set(r.refundId,r.amountMinor);
    const returned=[...known.values()].reduce((s,n)=>s+n,0);
    const uncertain=ops.some(r=>["REQUESTING","UNKNOWN","PENDING"].includes(r.status))||context.refunds.some(r=>r.status==="PENDING");
    const missing=context.captureStatus==="PARTIALLY_REFUNDED"&&providerTotal===0&&returned===0;
    const remaining=context.captureStatus==="REFUNDED"?0:Math.max(0,context.amountMinor-returned);
    if(!Number.isSafeInteger(returned)||returned>context.amountMinor)fail("Provider refund totals disagree with the original capture.",502);
    return {...context,refundUncertain:uncertain||missing||(returned>0&&context.captureStatus==="COMPLETED"),refundedMinor:context.captureStatus==="REFUNDED"?context.amountMinor:returned,remainingMinor:remaining,
      canRefund:!uncertain&&!missing&&remaining>0&&["COMPLETED","PARTIALLY_REFUNDED"].includes(context.captureStatus),
      message:uncertain?"A refund is pending or unverified. Check its status before requesting another.":missing?"The capture is partially refunded but its exact remaining amount is unavailable. Inspect PayPal.":remaining===0?"The original captured amount has been refunded.":"Review the amount to return. This never credits the current plan.",
      operations:ops.map(r=>({...r}))};
  }
  async function refund(project,orderId,amountMinor,requestId){
    if(!validId(requestId)||!Number.isSafeInteger(amountMinor)||amountMinor<1)fail("Choose a positive exact USD refund amount and a valid request identity.",400);
    if(locks.has(orderId))fail("A refund request for this order is already being handled. Check its status.",409);
    const task=(async()=>{
      await restore();
      const prior=records.get(requestId);
      if(prior){
        const c=await resolve(project,orderId);
        if(prior.orderId!==orderId||prior.projectId!==c.projectId||prior.amountMinor!==amountMinor)fail("This refund request identity belongs to different terms.");
        return review(project,orderId); // Observation only: never replay an unknown money request.
      }
      const before=await review(project,orderId);
      if(!before.canRefund||amountMinor>before.remainingMinor)fail("Refund exceeds the verified available amount or an earlier outcome is unresolved.");
      const r={requestId,projectId:before.projectId,orderId,captureId:before.captureId,amountMinor,status:"REQUESTING",refundId:null,createdAt:new Date(now()).toISOString()};
      records.set(requestId,r);await persist(); // Durable intent precedes the provider effect.
      const bearer=await accessToken();
      try{
        const res=await fetchImpl(baseUrl+"/v2/payments/captures/"+encodeURIComponent(r.captureId)+"/refund",{method:"POST",headers:{Authorization:"Bearer "+bearer,"Content-Type":"application/json","PayPal-Request-Id":createHash("sha256").update(requestId).digest("hex").slice(0,36),Prefer:"return=representation"},body:JSON.stringify({amount:{currency_code:"USD",value:usd(amountMinor)},invoice_id:requestId}),signal:AbortSignal.timeout(15000)});
        if(!res.ok){
          r.status=res.status>=400&&res.status<500?"FAILED":"UNKNOWN";
          r.message="PayPal refund request returned HTTP "+res.status+". "+(r.status==="UNKNOWN"?"Outcome needs verification.":"No successful refund was returned.");
        }else accept(r,await res.json());
      }catch{r.status="UNKNOWN";r.message="Refund response was lost or invalid. Check status; do not submit a replacement request.";}
      await persist();
      return review(project,orderId);
    })();locks.set(orderId,task);
    try{return await task;}finally{locks.delete(orderId);}
  }
  return {review,refund,reviewResolved};
}
