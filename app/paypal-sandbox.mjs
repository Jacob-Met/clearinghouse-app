import { paymentSettlement, retainedPayment } from "./payment-settlement.mjs";
import { createRefundDesk } from "./paypal-refunds.mjs";
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { DomainError, importProject, replayProject, evaluateRevision } from "./core.mjs";

const API = "https://api-m.sandbox.paypal.com";
// PayPal CREATED orders normally last about three hours. Review links before that boundary.
const LINK_REVIEW_WINDOW_MS = 165 * 60_000;
export class CheckoutError extends Error {
  constructor(message, status = 400, partial = []) { super(message); this.name = "CheckoutError"; this.status = status; this.partial = partial; }
}
export function minorToUsd(minor) {
  if (!(typeof minor === "bigint" ? minor >= 0n : Number.isSafeInteger(minor) && minor >= 0)) throw new CheckoutError("Invalid USD amount");
  const n = BigInt(minor);
  return (n / 100n).toString() + "." + (n % 100n).toString().padStart(2, "0");
}
export function checkoutPlan(text) {
  let state;
  try { state = replayProject(importProject(text)); }
  catch (error) { if (error instanceof DomainError) throw new CheckoutError(error.message, 400); throw error; }
  if (!state.evaluation.feasible || !state.evaluation.agreementRecorded) throw new CheckoutError("Every current member must have a recorded declaration and be within budget before requesting sandbox checkout.");
  const members = state.evaluation.members.map(row => {
    if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor < 0) throw new CheckoutError("Invalid member allocation");
    return { id: row.id, name: row.name, amountMinor: row.amountMinor };
  });
  return { projectId: state.project.projectId, title: state.project.title, revisionId: state.current.revisionId, ordinal: state.current.ordinal, fingerprint: JSON.stringify([state.current, state.project.events.filter(event => event.type === "approved" && event.revisionId === state.current.revisionId).map(event => [event.eventId, event.memberId, event.sequence])]), members };
}
const agreementKey = plan => createHash("sha256").update(JSON.stringify([plan.projectId,plan.revisionId,plan.fingerprint])).digest("hex").slice(0,36);
const eventKeys = project => project.events.map(event=>createHash("sha256").update(JSON.stringify(event)).digest("hex"));
const requestKey = (plan, member) => createHash("sha256").update(JSON.stringify([plan.projectId, plan.revisionId, plan.fingerprint, member.id, member.amountMinor])).digest("hex").slice(0, 36);
const isSandboxLink = value => {
  try { const u = new URL(value); return u.protocol === "https:" && (u.hostname === "www.sandbox.paypal.com" || u.hostname === "sandbox.paypal.com") && !u.username && !u.password; }
  catch { return false; }
};
async function responseJson(response, label) {
  let body;
  try { body = await response.json(); } catch { throw new CheckoutError(label + " returned unreadable JSON", 502); }
  if (!response.ok) throw new CheckoutError(label + " refused the request (HTTP " + response.status + ")", 502);
  return body;
}
// Historical display evidence only. This never supplies current settlement or refund eligibility.
function validPreviousObservation(value,entry) {
  if(!value || typeof value!=="object" || value.orderId!==entry.orderId || value.memberId!==entry.id ||
    typeof value.projectId!=="string" || !value.projectId || typeof value.revisionId!=="string" || !value.revisionId || !Number.isSafeInteger(value.ordinal) || value.ordinal<1 ||
    value.amountMinor!==entry.amountMinor || !/^[A-Za-z0-9]{8,36}$/.test(value.captureId||"") ||
    !["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(value.captureStatus) ||
    !Number.isSafeInteger(value.heldMinor) || value.heldMinor<0 ||
    !Number.isSafeInteger(value.refundedMinor) || value.refundedMinor<0 ||
    value.heldMinor+value.refundedMinor!==entry.amountMinor ||
    typeof value.checkedAt!=="string" || !Number.isFinite(Date.parse(value.checkedAt)))return false;
  return value.captureStatus==="COMPLETED"?value.refundedMinor===0:
    value.captureStatus==="REFUNDED"?value.heldMinor===0:value.refundedMinor>0&&value.heldMinor>0;
}
export function createSandboxCheckout({ clientId, clientSecret, fetchImpl = fetch, baseUrl = API, returnUrl = "http://127.0.0.1:4173/#paypal-return", cancelUrl = "http://127.0.0.1:4173/#paypal-cancel", now = () => Date.now(), storagePath = null } = {}) {
  let token = null, until = 0;
  const completed = new Map();
  const pending = new Map();
  const fundingPlans = new Map(), projectHeads = new Map(), projectLocks = new Map();
  const enabled = Boolean(clientId && clientSecret);
  // Local receipt registry: PayPal remains authoritative for money, this file only
  // remembers each source-bound order and its previous verified observation.
  // Historical observations are display-only, never fresh proof or money authority.
  let restoring = null, saving = Promise.resolve();
  async function restore() {
    if (!storagePath) return;
    if (!restoring) restoring = (async () => {
      let raw;
      try { raw = await readFile(storagePath, "utf8"); }
      catch (error) {
        if (error.code === "ENOENT") return;
        throw new CheckoutError("Saved sandbox order registry cannot be read. Existing orders may remain active in PayPal.", 503);
      }
      let doc;
      try { doc = JSON.parse(raw); }
      catch { throw new CheckoutError("Saved sandbox order registry is invalid. No new orders will be created; inspect the file and PayPal.", 503); }
      if (![1,2].includes(doc?.version) || !Array.isArray(doc.rows) || doc.rows.length > 10000)
        throw new CheckoutError("Saved sandbox order registry has an unsupported format. No new orders will be created.", 503);
      for (const row of doc.rows) {
        const key = row?.key, entry = row?.entry;
        if (typeof key !== "string" || !/^[0-9a-f]{36}$/.test(key) ||
            !Number.isSafeInteger(row?.receivedAt) || row.receivedAt < 0 ||
            !entry || typeof entry !== "object" ||
            typeof entry.id !== "string" || typeof entry.name !== "string" ||
            !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0 ||
            entry.amount !== minorToUsd(entry.amountMinor) ||
            entry.requestId !== key || !/^[A-Za-z0-9]{8,32}$/.test(entry.orderId || "") ||
            !isSandboxLink(entry.approveUrl) || completed.has(key)) {
          throw new CheckoutError("Saved sandbox order registry contains an invalid receipt. New orders are paused to prevent accidental duplication.", 503);
        }
        if(row.previousObservation!==undefined && !validPreviousObservation(row.previousObservation,entry))
          throw new CheckoutError("Saved prior payment observation is invalid. No current payment status is inferred.",503);
        completed.set(key, {entry:Object.freeze(entry),receivedAt:row.receivedAt,
          ...(row.previousObservation?{previousObservation:Object.freeze(row.previousObservation)}:{})});
      }
      if(doc.version===2){
        if(!Array.isArray(doc.fundingPlans)||!Array.isArray(doc.projectHeads))throw new CheckoutError("Payment-plan recovery is invalid.",503);
        for(const head of doc.projectHeads){
          if(typeof head.projectId!=="string"||!Array.isArray(head.events)||head.events.some(x=>!/^[a-f0-9]{64}$/.test(x))||projectHeads.has(head.projectId))
            throw new CheckoutError("Payment-plan source history is invalid.",503);
          projectHeads.set(head.projectId,head.events);
        }
        for(const plan of doc.fundingPlans){
          if(typeof plan.projectId!=="string"||typeof plan.revisionId!=="string"||typeof plan.fingerprint!=="string"||
            typeof plan.reviewId!=="string"||!/^[a-f0-9]{64}$/.test(plan.reviewId)||plan.paymentFingerprint!==plan.fingerprint+":net:"+plan.reviewId||plan.key!==agreementKey(plan)||!Array.isArray(plan.members)||
            !Array.isArray(plan.basis)||fundingPlans.has(plan.key)||!projectHeads.has(plan.projectId)||
            plan.members.some(m=>typeof m.id!=="string"||!Number.isSafeInteger(m.obligationMinor)||m.obligationMinor<0||
              !Number.isSafeInteger(m.creditMinor)||m.creditMinor<0||!Number.isSafeInteger(m.amountMinor)||m.amountMinor<0||
              m.creditMinor+m.amountMinor!==m.obligationMinor))
            throw new CheckoutError("Saved payment-plan amounts are invalid.",503);
          fundingPlans.set(plan.key,plan);
        }
      }
    })();
    return restoring;
  }
  async function persistCompleted() {
    if (!storagePath) return;
    const next = saving.then(async () => {
      const dir = dirname(storagePath);
      const tmp = storagePath + ".tmp-" + process.pid + "-" + randomBytes(6).toString("hex");
      try {
        await mkdir(dir, {recursive:true, mode:0o700});
        const rows = [...completed].map(([key, cached]) => ({
          key, receivedAt: cached.receivedAt, entry: cached.entry,
          ...(cached.previousObservation?{previousObservation:cached.previousObservation}:{})
        }));
        await writeFile(tmp, JSON.stringify(fundingPlans.size||projectHeads.size ? {version:2,rows,fundingPlans:[...fundingPlans.values()],projectHeads:[...projectHeads].map(([projectId,events])=>({projectId,events}))} : {version:1,rows}) + "\n", {encoding:"utf8",flag:"wx",mode:0o600});
        await rename(tmp, storagePath);
      } catch {
        try { await unlink(tmp); } catch {}
        throw new CheckoutError("Sandbox order was or may have been prepared, but its local recovery file could not be saved. Inspect the PayPal account before retrying.", 503);
      }
    });
    saving = next.catch(() => {});
    return next;
  }
  async function accessToken() {
    if (!enabled) throw new CheckoutError("PayPal sandbox credentials are not configured on this server.", 503);
    if (token && now() < until) return token;
    let response;
    try {
      response = await fetchImpl(baseUrl + "/v1/oauth2/token", {
        method: "POST", headers: { Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials", signal: AbortSignal.timeout(15000)
      });
    } catch { throw new CheckoutError("Cannot reach the PayPal sandbox token service.", 502); }
    const result = await responseJson(response, "PayPal sandbox authentication");
    if (typeof result.access_token !== "string" || !result.access_token) throw new CheckoutError("PayPal returned no access token.", 502);
    token = result.access_token;
    until = now() + Math.max(0, Number(result.expires_in || 60) - 30) * 1000;
    return token;
  }
  function paymentTerms(plan,member){
    const funding=fundingPlans.get(agreementKey(plan));
    if(!funding)return {plan,member,funding:null};
    const chosen=funding.members.find(row=>row.id===member.id);
    if(!chosen||chosen.obligationMinor!==member.amountMinor)throw new CheckoutError("Stored payment plan disagrees with this agreement.",503);
    return {plan:{...plan,fingerprint:funding.paymentFingerprint},member:{...member,...chosen},funding};
  }
  function storedOrder(plan,member){
    const terms=paymentTerms(plan,member),key=requestKey(terms.plan,terms.member);
    return {...terms,key,cached:completed.get(key)};
  }
  function assertCurrentSource(projectText){
    const project=importProject(projectText),prior=projectHeads.get(project.projectId),events=eventKeys(project);
    if(prior && (events.length<prior.length||prior.some((value,i)=>events[i]!==value)))
      throw new CheckoutError("A newer payment plan is already accepted for this group. Open its current history before moving money.",409);
    return {project,events};
  }
  async function mutateProject(projectText,operation){
    let project;
    try{project=importProject(projectText);}catch(error){if(error instanceof DomainError)throw new CheckoutError(error.message,400);throw error;}
    const previous=projectLocks.get(project.projectId);
    let release;const gate=new Promise(resolve=>{release=resolve});
    projectLocks.set(project.projectId,gate);
    if(previous)await previous;
    try{await restore();assertCurrentSource(projectText);return await operation();}
    finally{release();if(projectLocks.get(project.projectId)===gate)projectLocks.delete(project.projectId);}
  }
  function fundingBasis(result){
    return result.members.flatMap(member=>member.orders.map(order=>({memberId:member.memberId,orderId:order.orderId,
      captureId:order.captureId,heldMinor:order.heldMinor,refundedMinor:order.refundedMinor})))
      .sort((a,b)=>a.orderId.localeCompare(b.orderId));
  }
  function reviewIdentity(plan,result){
    return createHash("sha256").update(JSON.stringify([agreementKey(plan),result.members.map(row=>[row.memberId,row.obligationMinor,row.known,row.heldMinor]),fundingBasis(result)])).digest("hex");
  }
  async function prepareSettlement(projectText,reviewId){
    return mutateProject(projectText,async()=>{
      const plan=checkoutPlan(projectText),existingFunding=fundingPlans.get(agreementKey(plan));
      if(existingFunding)return prepareInternal(projectText);
      const result=await settlement(projectText);
      if(!result.known||reviewId!==result.reviewId)throw new CheckoutError("Payment facts changed or remain uncertain. Review the current amounts again before creating links.",409);
      if(plan.members.some(member=>completed.has(requestKey(plan,member))))
        throw new CheckoutError("Existing payer links belong to this agreement. Review those orders and record a new plan before changing its payment amounts.",409);
      const basis=fundingBasis(result),key=agreementKey(plan);
      const funding={...plan,key,reviewId,paymentFingerprint:plan.fingerprint+":net:"+reviewId,basis,
        members:result.members.filter(row=>row.current).map(row=>({id:row.memberId,name:row.memberName,
          obligationMinor:row.obligationMinor,creditMinor:row.creditMinor,amountMinor:row.topUpMinor}))};
      fundingPlans.set(key,funding);
      const source=assertCurrentSource(projectText);projectHeads.set(plan.projectId,source.events);
      await persistCompleted();
      return prepareInternal(projectText);
    });
  }
  function fundingMatches(result,funding){
    const wanted=new Set(funding.basis.map(row=>row.orderId));
    const current=fundingBasis(result).filter(row=>wanted.has(row.orderId)),credits=new Map();
    for(const row of current)credits.set(row.memberId,(credits.get(row.memberId)||0)+(row.heldMinor||0));
    return result.known&&current.length===wanted.size&&funding.members.every(member=>
      Math.min(member.obligationMinor,credits.get(member.id)||0)===member.creditMinor);
  }
  async function validateFunding(projectText,funding){
    if(!fundingMatches(await settlement(projectText),funding))
      throw new CheckoutError("Earlier payments changed since this payment plan was reviewed. Check the amounts and record a new agreement before collecting more.",409);
  }
  async function createOne(plan, member) {
    const key = requestKey(plan, member);
    if (completed.has(key)) {
      const cached = completed.get(key);
      if (now() - cached.receivedAt >= LINK_REVIEW_WINDOW_MS) {
        throw new CheckoutError("A previously prepared PayPal payer link is older than the safe review window. Do not reuse it; inspect the order status in PayPal before requesting another order.", 409);
      }
      await persistCompleted(); // Even cached receipts must remain recoverable after a restart.
      return cached.entry;
    }
    if (pending.has(key)) return pending.get(key);
    const promise = (async () => {
      const bearer = await accessToken();
      const request = {
        intent: "CAPTURE",
        purchase_units: [{
          reference_id: key.slice(0, 20),
          custom_id: key,
          description: ("CLEARINGHOUSE R" + plan.ordinal + " / " + member.name).slice(0, 127),
          amount: { currency_code: "USD", value: minorToUsd(member.amountMinor) }
        }],
        payment_source: { paypal: { experience_context: {
          user_action: "CONTINUE", shipping_preference: "NO_SHIPPING", return_url: returnUrl, cancel_url: cancelUrl
        } } }
      };
      let response;
      try {
        response = await fetchImpl(baseUrl + "/v2/checkout/orders", {
          method: "POST", headers: { Authorization: "Bearer " + bearer, "Content-Type": "application/json", "PayPal-Request-Id": key, Prefer: "return=representation" },
          body: JSON.stringify(request), signal: AbortSignal.timeout(15000)
        });
      } catch { throw new CheckoutError("PayPal order request outcome unknown; retry uses the same request ID.", 502); }
      const result = await responseJson(response, "PayPal sandbox order");
      const link = result.links?.find(item => (item.rel === "payer-action" || item.rel === "approve") && isSandboxLink(item.href));
      if (!/^[A-Za-z0-9]{8,32}$/.test(result.id || "") || !link) throw new CheckoutError("PayPal did not supply a valid sandbox payer-approval link.", 502);
      const entry = Object.freeze({ id: member.id, name: member.name, amountMinor: member.amountMinor, ...(member.obligationMinor!==undefined?{obligationMinor:member.obligationMinor,creditMinor:member.creditMinor}:{}), amount: minorToUsd(member.amountMinor), orderId: result.id, approveUrl: link.href, requestId: key });
      completed.set(key, { entry, receivedAt: now() });
      await persistCompleted();
      return entry;
    })();
    pending.set(key, promise);
    try { return await promise; } finally { pending.delete(key); }
  }
  const prepare = projectText => mutateProject(projectText,()=>prepareInternal(projectText));
  async function prepareInternal(projectText) {
    const plan = checkoutPlan(projectText);
    if (!enabled) throw new CheckoutError("PayPal sandbox credentials are not configured on this server.", 503);
    await restore();
    assertCurrentSource(projectText);
    const funding=fundingPlans.get(agreementKey(plan));
    if(!funding && replayProject(importProject(projectText)).current.ordinal>1){
      const result=await settlement(projectText);
      if(!result.known || result.knownHeldMinor>0)
        throw new CheckoutError("Review the changed plan's retained payments before creating payer links.",409);
    }
    if(funding)await validateFunding(projectText,funding);
    if(projectHeads.has(plan.projectId)){
      projectHeads.set(plan.projectId,eventKeys(importProject(projectText)));
      await persistCompleted();
    }
    const created = [], skipped = [];
    for (const original of plan.members) {
      const {plan:paymentPlan,member}=paymentTerms(plan,original);
      if (member.amountMinor === 0) { skipped.push({id: member.id, name: member.name, ...(funding?{obligationMinor:original.amountMinor,creditMinor:member.creditMinor}: {})}); continue; }
      try { created.push(await createOne(paymentPlan, member)); }
      catch (error) { throw new CheckoutError(error instanceof CheckoutError ? error.message : "PayPal checkout failed.", error.status || 502, created); }
    }
    return { projectId: plan.projectId, revisionId: plan.revisionId, ordinal: plan.ordinal, created, skipped, total: minorToUsd(plan.members.reduce((sum, m) => sum + BigInt(m.amountMinor), 0n)) };
  }

  // The order ID never comes from the browser. It must be the ID this process
  // received from PayPal when it prepared the exact member/revision/declaration.
  async function existing(projectText, memberId) {
    await restore();
    const plan = checkoutPlan(projectText);
    const member = plan.members.find(row => row.id === memberId && row.amountMinor > 0);
    if (!member) throw new CheckoutError("No positive current allocation exists for this member.", 400);
    const {plan:paymentPlan,member:paymentMember,key,cached,funding}=storedOrder(plan,member);
    if (!cached) throw new CheckoutError("No matching stored PayPal order exists for this exact agreement. Do not substitute an order ID.", 409);
    return { plan:paymentPlan, member:paymentMember, key, cached, funding };
  }
  async function readOrder(item) {
    const bearer = await accessToken();
    let response;
    try {
      response = await fetchImpl(baseUrl + "/v2/checkout/orders/" + encodeURIComponent(item.cached.entry.orderId), {
        method: "GET", headers: { Authorization: "Bearer " + bearer }, signal: AbortSignal.timeout(15000)
      });
    } catch { throw new CheckoutError("PayPal order status could not be verified. Do not assume payment succeeded or failed.", 502); }
    const order = await responseJson(response, "PayPal sandbox order status");
    const units = order.purchase_units;
    if (order.id !== item.cached.entry.orderId || order.intent !== "CAPTURE" ||
        !Array.isArray(units) || units.length !== 1 ||
        units[0].custom_id !== item.key ||
        units[0].amount?.currency_code !== "USD" ||
        units[0].amount?.value !== minorToUsd(item.member.amountMinor)) {
      throw new CheckoutError("Provider order identity, revision reference, or amount disagrees with the prepared allocation. Capture refused.", 409);
    }
    if (!["CREATED", "SAVED", "PAYER_ACTION_REQUIRED", "APPROVED", "COMPLETED", "VOIDED"].includes(order.status)) {
      throw new CheckoutError("PayPal returned an unrecognized order state. No settlement may be inferred.", 502);
    }
    const captures = units[0].payments?.captures;
    if (captures !== undefined && !Array.isArray(captures)) throw new CheckoutError("PayPal returned an invalid capture record.", 502);
    if (Array.isArray(captures) && captures.some(c => c.amount?.currency_code !== "USD" ||
      c.amount?.value !== minorToUsd(item.member.amountMinor))) {
      throw new CheckoutError("PayPal capture amount does not match the agreed member obligation.", 409);
    }
    const capture = order.status === "COMPLETED" && captures?.length === 1 &&
      captures[0].status === "COMPLETED" && /^[A-Za-z0-9]{8,36}$/.test(captures[0].id || "") ? captures[0] : null;
    const observation = {
      memberId: item.member.id, memberName: item.member.name,
      preparedAt:new Date(item.cached.receivedAt).toISOString(),
      reviewBefore:new Date(item.cached.receivedAt + LINK_REVIEW_WINDOW_MS).toISOString(),
      revisionId: item.plan.revisionId, ordinal: item.plan.ordinal,
      amount: minorToUsd(item.member.amountMinor), orderId: item.cached.entry.orderId,
      ...(item.funding?{obligationMinor:item.member.obligationMinor,creditMinor:item.member.creditMinor}:{}),
      status: order.status, captured: Boolean(capture),
      captureId: captures?.length === 1 && /^[A-Za-z0-9]{8,36}$/.test(captures[0].id || "") ? captures[0].id : null,
      refundsKnown:Array.isArray(units[0].payments?.refunds),
      refunds: (units[0].payments?.refunds || []).map(refund => {
        if (!/^[A-Za-z0-9]{8,80}$/.test(refund.id || "") || refund.amount?.currency_code !== "USD" || !/^\d+\.\d{2}$/.test(refund.amount?.value || "") || !["COMPLETED","PENDING","FAILED","CANCELLED"].includes(refund.status)) throw new CheckoutError("Provider refund details are invalid.",502);
        const amountMinor = Number(refund.amount.value.replace(".",""));
        if (!Number.isSafeInteger(amountMinor) || amountMinor < 1) throw new CheckoutError("Provider refund amount is invalid.",502);
        return {...refund, amountMinor};
      }),
      captureStatus: capture ? "COMPLETED" : captures?.length ? String(captures[0].status || "UNKNOWN") : null
    };
    const money=retainedPayment(observation);
    if(money.known && observation.captureId && ["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(observation.captureStatus)){
      const facts={projectId:item.plan.projectId,orderId:observation.orderId,memberId:observation.memberId,revisionId:observation.revisionId,
        ordinal:observation.ordinal,amountMinor:money.amountMinor,captureId:observation.captureId,
        captureStatus:observation.captureStatus,heldMinor:money.heldMinor,refundedMinor:money.refundedMinor};
      const prior=item.cached.previousObservation;
      if(!prior || Object.entries(facts).some(([key,value])=>prior[key]!==value)){
        item.cached.previousObservation=Object.freeze({...facts,checkedAt:new Date(now()).toISOString()});
        await persistCompleted();
      }
    }
    return observation;
  }
  async function inspect(projectText, memberId) {
    const item=await existing(projectText, memberId),order=await readOrder(item);
    if(item.funding&&!order.captured)await validateFunding(projectText,item.funding);
    return order;
  }
  const capturePending = new Map();
  const capture = (projectText,memberId) => mutateProject(projectText,()=>captureInternal(projectText,memberId));
  async function captureInternal(projectText, memberId) {
    const item = await existing(projectText, memberId);
    if (capturePending.has(item.key)) return capturePending.get(item.key);
    const promise = (async () => {
      const before = await readOrder(item);
      if (before.captured) return before; // PayPal, not local memory, confirms prior settlement.
      if (before.status !== "APPROVED") {
        throw new CheckoutError("This sandbox order is not currently APPROVED for capture. Check payer status first.", 409);
      }
      if (now() - item.cached.receivedAt >= LINK_REVIEW_WINDOW_MS) {
        throw new CheckoutError("The prepared order is older than the safe review window. Inspect it in PayPal before proceeding.", 409);
      }
      if(item.funding)await validateFunding(projectText,item.funding);
      const bearer = await accessToken();
      const captureRequestId = createHash("sha256").update(item.key + ":capture").digest("hex").slice(0, 36);
      let response;
      try {
        response = await fetchImpl(baseUrl + "/v2/checkout/orders/" + encodeURIComponent(before.orderId) + "/capture", {
          method: "POST", headers: { Authorization: "Bearer " + bearer,
            "PayPal-Request-Id": captureRequestId, "Content-Type": "application/json", Prefer: "return=representation" },
          body: "{}", signal: AbortSignal.timeout(15000)
        });
      } catch {
        throw new CheckoutError("Capture response is unknown. Check provider status before trying again; no failure or success is assumed.", 502);
      }
      await responseJson(response, "PayPal sandbox capture");
      const after = await readOrder(item);
      if (!after.captured) throw new CheckoutError("Capture request returned, but a completed matching payment has not been verified. Check provider status.", 502);
      return after;
    })();
    capturePending.set(item.key, promise);
    try { return await promise; } finally { capturePending.delete(item.key); }
  }
  async function currentOrders(projectText) {
    const plan = checkoutPlan(projectText);
    await restore();
    await accessToken(); // Refuse invalid credentials once before querying group members.
    const rows = [];
    // Bound provider concurrency: one current GET per member, never a hidden capture.
    for (let i = 0; i < plan.members.length; i += 4) {
      const batch = await Promise.all(plan.members.slice(i, i + 4).map(async member => {
        const baseline = {
          memberId:member.id, memberName:member.name, amount:minorToUsd(member.amountMinor),
          amountMinor:member.amountMinor, captured:false
        };
        if (member.amountMinor === 0) return {...baseline,status:"NO_OBLIGATION",captureStatus:null};
        const item=storedOrder(plan,member),{key,cached}=item;
        if (!cached) return {...baseline,status:"NOT_PREPARED",captureStatus:null};
        try {
          return {...baseline,...await readOrder(item)};
        } catch (error) {
          return {...baseline,status:"UNKNOWN",captureStatus:null,
            message:error instanceof CheckoutError ? error.message : "Provider status could not be verified."};
        }
      }));
      rows.push(...batch);
    }
    const totalMinor = plan.members.reduce((sum, member) => sum + BigInt(member.amountMinor), 0n);
    const confirmedMinor = rows.reduce((sum, row) => sum + (row.captured ? BigInt(row.amountMinor) : 0n), 0n);
    const uncertainMinor = rows.reduce((sum,row) => sum +
      ((!row.captured && (row.status === "UNKNOWN" || row.status === "COMPLETED" ||
         row.captureStatus === "PENDING" || row.captureStatus === "PARTIALLY_REFUNDED"))
        ? BigInt(row.amountMinor) : 0n), 0n);
    return {
      projectId:plan.projectId, revisionId:plan.revisionId, ordinal:plan.ordinal,
      checkedAt:new Date(now()).toISOString(), members:rows.map(({amountMinor,...row})=>row),
      prepared:{projectId:plan.projectId,revisionId:plan.revisionId,ordinal:plan.ordinal,
        created:plan.members.filter(member=>member.amountMinor>0).map(member=>storedOrder(plan,member).cached?.entry).filter(Boolean),
        total:minorToUsd(totalMinor)},
      total:minorToUsd(totalMinor), confirmed:minorToUsd(confirmedMinor),
      notConfirmed:minorToUsd(totalMinor-confirmedMinor), uncertain:minorToUsd(uncertainMinor),
      allCaptured:confirmedMinor===totalMinor,
      note:"Only COMPLETED PayPal captures matching this exact member obligation count as confirmed. Other amounts are not proof of nonpayment."
    };
  }
  async function reconcile(projectText){
    const result=await currentOrders(projectText),plan=checkoutPlan(projectText);
    if(!fundingPlans.has(agreementKey(plan)))return result;
    const net=await settlement(projectText,result);
    net.paymentPlanCurrent=fundingMatches(net,fundingPlans.get(agreementKey(plan)));
    return {...result,settlement:net,confirmed:minorToUsd(net.members.reduce((sum,row)=>sum+Math.min(row.obligationMinor,row.knownHeldMinor),0)),
      notConfirmed:net.known?minorToUsd(net.topUpMinor):result.notConfirmed,
      allCaptured:net.settled,
      note:"Current obligations are compared with verified retained payments and refunds across this plan's history."};
  }
  async function history(projectText, selectedMemberId = null) {
    let state;
    try { state = replayProject(importProject(projectText)); }
    catch (error) { if (error instanceof DomainError) throw new CheckoutError(error.message,400); throw error; }
    await restore();
    const candidates = new Map(), active = new Set();
    if (state.evaluation.agreementRecorded) {
      const currentPlan = checkoutPlan(projectText);
      for (const member of currentPlan.members) active.add(storedOrder(currentPlan,member).key);
    }
    // Full input was validated above. Reconstruct the same fingerprints used at
    // each eligible approval prefix; never trust registry rows merely by member ID.
    let revision, evaluation, approvals = new Set(), declarations = [];
    for (const event of state.project.events) {
      if (event.type === "created" || event.type === "amended") {
        revision=event.revision; evaluation=evaluateRevision(revision);
        approvals=new Set(); declarations=[];
      } else if (event.type === "approval_withdrawn") {
        approvals.delete(event.memberId);
      } else if (event.type === "approved") {
        approvals.add(event.memberId);
        declarations.push([event.eventId,event.memberId,event.sequence]);
        if (!evaluation.feasible || approvals.size!==revision.members.length) continue;
        const plan={projectId:state.project.projectId,revisionId:revision.revisionId,
          ordinal:revision.ordinal,fingerprint:JSON.stringify([revision,declarations])};
        for (const member of evaluation.members) {
          if (!member.amountMinor || (selectedMemberId !== null && member.id !== selectedMemberId)) continue;
          const item=storedOrder(plan,member),{key,cached}=item;
          if (!cached || active.has(key)) continue;
          if (cached.entry.id!==member.id || cached.entry.amountMinor!==item.member.amountMinor)
            throw new CheckoutError("Stored prior order disagrees with its source-bound allocation.",503);
          if (!candidates.has(key)) candidates.set(key,{...item,agreementSequence:event.sequence});
        }
      }
    }
    const items=[...candidates.values()], orders=[];
    for(let i=0;i<items.length;i+=4) {
      orders.push(...await Promise.all(items.slice(i,i+4).map(async item=>{
        const baseline={memberId:item.member.id,memberName:item.member.name,
          revisionId:item.plan.revisionId,ordinal:item.plan.ordinal,
          amount:minorToUsd(item.member.amountMinor),orderId:item.cached.entry.orderId,
          ...(item.funding?{obligationMinor:item.member.obligationMinor,creditMinor:item.member.creditMinor}:{}),
          agreementSequence:item.agreementSequence,
          preparedAt:new Date(item.cached.receivedAt).toISOString(),
          currentMember:state.current.members.some(member=>member.id===item.member.id),
          captured:false,captureId:null,captureStatus:null};
        try { return {...baseline,...await readOrder(item)}; }
        catch(error) {
          const previous=item.cached.previousObservation;
          const bound=previous && validPreviousObservation(previous,item.cached.entry) &&
            previous.projectId===item.plan.projectId && previous.revisionId===item.plan.revisionId && previous.ordinal===item.plan.ordinal;
          return {...baseline,status:"UNKNOWN",...(bound?{previousObservation:previous}:{}),
            message:error instanceof CheckoutError?error.message:"Prior provider status could not be verified."};
        }
      })));
    }
    return {projectId:state.project.projectId,revisionId:state.current.revisionId,
      ordinal:state.current.ordinal,checkedAt:new Date(now()).toISOString(),orders,
      note:"Earlier prepared orders only. Provider observations do not settle this revision, cancel an order, refund money, or offset a new obligation."};
  }
  // Invitation reads never prepare orders or submit payment operations.
  async function payerReview(projectText, memberId) {
    const state = replayProject(importProject(projectText));
    const currentMember=state.evaluation.members.some(member=>member.id===memberId);
    if (!state.revisions.some(revision=>revision.members.some(member=>member.id===memberId)))
      throw new CheckoutError("Participant has no recorded history in this group.",400);
    if (!enabled) return {};
    const prior = await history(projectText, memberId);
    if (!currentMember) {
      const observations=await resolvedSettlementOrders(state,prior.orders);
      const position=paymentSettlement(state,observations).members.find(row=>row.memberId===memberId);
      return {history:prior,settlement:position?{projectId:state.project.projectId,revisionId:state.current.revisionId,
        checkedAt:new Date(now()).toISOString(),paymentPlanCurrent:null,member:position}:null};
    }
    if (!state.evaluation.agreementRecorded) return {history:prior};
    await restore();
    const plan = checkoutPlan(projectText);
    const member = plan.members.find(row => row.id === memberId);
    const funding=fundingPlans.get(agreementKey(plan));
    let personalSettlement=null;
    if(funding){
      const net=await settlement(projectText);
      personalSettlement={projectId:net.projectId,revisionId:net.revisionId,checkedAt:net.checkedAt,
        paymentPlanCurrent:net.paymentPlanCurrent,member:net.members.find(row=>row.memberId===memberId)};
    }
    if (!member.amountMinor) return {history:prior,settlement:personalSettlement};
    const item=storedOrder(plan,member),{key,cached}=item;
    if (!cached) return {history:prior,settlement:personalSettlement};
    const prepared = {projectId:plan.projectId,revisionId:plan.revisionId,ordinal:plan.ordinal,created:[cached.entry]};
    let order;
    try { order = await readOrder(item); if(item.funding&&!order.captured&&personalSettlement?.paymentPlanCurrent!==true)throw new CheckoutError("Retained payment credit changed.",409); }
    catch { order = {memberId,revisionId:plan.revisionId,orderId:cached.entry.orderId,
      amount:cached.entry.amount,status:"UNKNOWN",captured:false}; }
    return {history:prior,prepared,order,settlement:personalSettlement};
  }
  async function resolvedSettlementOrders(state,observations){
    const orders=[];
    for(let i=0;i<observations.length;i+=4){
      orders.push(...await Promise.all(observations.slice(i,i+4).map(async order=>{
        if(!order.captureId || !["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(order.captureStatus))return order;
        try {
          return await refundDesk.reviewResolved({...order,projectId:state.project.projectId,
            amountMinor:Number(order.amount.replace(".","")),refunds:order.refunds||[]});
        }catch{return {...order,refundUncertain:true};}
      })));
    }
    return orders;
  }
  async function settlement(projectText,currentResult=null) {
    let state;
    try{state=replayProject(importProject(projectText));}catch(error){if(error instanceof DomainError)throw new CheckoutError(error.message,400);throw error;}
    const prior=await history(projectText),observations=[...prior.orders];
    if(state.evaluation.agreementRecorded){
      const current=currentResult||await currentOrders(projectText);
      observations.push(...current.members.filter(row=>row.orderId));
    }
    const orders=await resolvedSettlementOrders(state,observations);
    const result=paymentSettlement(state,orders);
    const funding=state.evaluation.agreementRecorded?fundingPlans.get(agreementKey(checkoutPlan(projectText))):null;
    return {...result,checkedAt:new Date(now()).toISOString(),orders:observations,
      paymentPlanAccepted:Boolean(funding),paymentPlanCurrent:funding?fundingMatches(result,funding):null,
      reviewId:state.evaluation.agreementRecorded&&result.known?reviewIdentity(checkoutPlan(projectText),result):null};
  }
  const refundDesk = createRefundDesk({
    accessToken, fetchImpl, baseUrl, now, storagePath: storagePath ? storagePath + ".refunds" : null,
    ErrorClass: CheckoutError, usd: minorToUsd,
    resolve: async (projectText, orderId) => {
      const result = await history(projectText);
      const order = result.orders.find(row => row.orderId === orderId);
      if (!order || !order.captureId || order.status === "UNKNOWN" || !["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(order.captureStatus))
        throw new CheckoutError("Only a verified earlier capture from this saved plan can be reviewed for refund. Refresh earlier payments first.",409);
      return {...order, projectId: result.projectId, amountMinor: Number(order.amount.replace(".","")), refunds: order.refunds || []};
    }
  });
  return { enabled, prepare, prepareSettlement, inspect, capture, reconcile, history, settlement, payerReview, refundReview: refundDesk.review, refund: (project,orderId,amountMinor,requestId)=>mutateProject(project,()=>refundDesk.refund(project,orderId,amountMinor,requestId)) };
}
