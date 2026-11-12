import { evaluateRevision } from "./core.mjs";

const esc = value => String(value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const validTime = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const usd = minor => (BigInt(minor) / 100n).toString() + "." + (BigInt(minor) % 100n).toString().padStart(2,"0");

/** Retain only completed USD refunds explicitly linked to this observed capture.
 * The list is evidence of these refunds, never a computed remaining balance. */
function completedRefunds(row, originalMinor) {
  if (row.status === "UNKNOWN" || !["PARTIALLY_REFUNDED", "REFUNDED"].includes(row.captureStatus) ||
      typeof row.captureId !== "string" || !Array.isArray(row.refunds)) return Object.freeze([]);
  const seen = new Set(), refunds = []; let total = 0n;
  for (const refund of row.refunds) {
    if (!refund || typeof refund.id !== "string" || !/^[A-Za-z0-9-]{8,80}$/.test(refund.id) || seen.has(refund.id)) return Object.freeze([]);
    seen.add(refund.id);
    if (refund.status !== "COMPLETED") continue;
    if (refund.amount?.currency_code !== "USD" || typeof refund.amount.value !== "string" || !/^(0|[1-9][0-9]*)[.][0-9]{2}$/.test(refund.amount.value || "")) return Object.freeze([]);
    const minor = BigInt(refund.amount.value.replace(".", ""));
    if (minor <= 0n) return Object.freeze([]);
    total += minor;
    if (total > BigInt(originalMinor)) return Object.freeze([]);
    const links = Array.isArray(refund.links) ? refund.links.filter(link => link?.rel === "up") : [];
    if (links?.length !== 1) return Object.freeze([]);
    let source;
    try { source = new URL(links[0].href); } catch { return Object.freeze([]); }
    if (source.protocol !== "https:" || !["api.sandbox.paypal.com", "api-m.sandbox.paypal.com"].includes(source.hostname) ||
        source.username || source.password || source.port || source.search || source.hash ||
        source.pathname !== "/v2/payments/captures/" + row.captureId) return Object.freeze([]);
    refunds.push(Object.freeze({id:refund.id, amount:refund.amount.value}));
  }
  return Object.freeze(refunds);
}

function previousObservation(row,member,revision,chargeMinor,projectId) {
  const prior=row.previousObservation;
  if(row.status!=="UNKNOWN" || !prior || prior.projectId!==projectId || prior.orderId!==row.orderId || prior.memberId!==member.id ||
    prior.revisionId!==revision.revisionId || prior.ordinal!==revision.ordinal || prior.amountMinor!==chargeMinor ||
    !/^[A-Za-z0-9]{8,36}$/.test(prior.captureId||"") || !validTime(prior.checkedAt) ||
    !Number.isSafeInteger(prior.heldMinor) || prior.heldMinor<0 ||
    !Number.isSafeInteger(prior.refundedMinor) || prior.refundedMinor<0 ||
    prior.heldMinor+prior.refundedMinor!==chargeMinor ||
    !["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(prior.captureStatus))return null;
  if(prior.captureStatus==="COMPLETED"?prior.refundedMinor!==0:
    prior.captureStatus==="REFUNDED"?prior.heldMinor!==0:prior.refundedMinor===0||prior.heldMinor===0)return null;
  return Object.freeze({captureId:prior.captureId,captureStatus:prior.captureStatus,
    heldMinor:prior.heldMinor,refundedMinor:prior.refundedMinor,checkedAt:prior.checkedAt});
}
/** A recipient-only projection. Never copy the provider response wholesale into a private file. */
export function personalPaymentContext(state, memberId, history, settlement=null) {
  if (!state?.revisions?.some(revision=>revision.members.some(m=>m.id===memberId))) throw Error("Participant has no recorded history in this group.");
  if (!history || history.projectId !== state.project.projectId || history.revisionId !== state.current.revisionId ||
      !validTime(history.checkedAt) || !Array.isArray(history.orders)) {
    return Object.freeze({available:false, checkedAt:null, orders:[]});
  }
  const orders = [];
  for (const row of history.orders) {
    if (row.memberId !== memberId) continue;
    const revision = state.revisions.find(r => r.revisionId === row.revisionId && r.ordinal === row.ordinal);
    const member = revision && evaluateRevision(revision).members.find(m => m.id === memberId);
    const chargeMinor=member&&Number.isSafeInteger(row.obligationMinor)&&row.obligationMinor===member.amountMinor&&
      Number.isSafeInteger(row.creditMinor)&&row.creditMinor>=0&&row.creditMinor<=member.amountMinor
      ?member.amountMinor-row.creditMinor:member?.amountMinor;
    if (!member || row.amount !== usd(chargeMinor) || typeof row.orderId !== "string") {
      throw Error("Earlier payment observation does not match this participant's recorded proposal.");
    }
    const previous=previousObservation(row,member,revision,chargeMinor,state.project.projectId);
    orders.push(Object.freeze({
      ordinal:revision.ordinal, amount:row.amount, orderId:row.orderId,
      status:typeof row.status === "string" ? row.status : "UNKNOWN",
      captured:row.captured === true && row.captureStatus === "COMPLETED",
      captureStatus:typeof row.captureStatus === "string" ? row.captureStatus : null,
      captureId:typeof row.captureId === "string" ? row.captureId : null,
      completedRefunds:completedRefunds(row, chargeMinor),
      ...(previous?{previousObservation:previous}:{})
    }));
  }
  let position=null;
  const current=state.evaluation.members.find(row=>row.id===memberId),row=settlement?.member;
  const removed=!current;
  if(settlement?.projectId===state.project.projectId&&settlement.revisionId===state.current.revisionId&&
    validTime(settlement.checkedAt)&&row?.memberId===memberId&&row.obligationMinor===(current?.amountMinor??0)&&
    (!removed||row.current===false)){
    const valid=row.known===true&&["heldMinor","creditMinor","topUpMinor","refundDueMinor"].every(key=>Number.isSafeInteger(row[key])&&row[key]>=0)&&
      row.creditMinor+row.topUpMinor===row.obligationMinor&&row.heldMinor===row.creditMinor+row.refundDueMinor;
    const returned=Number.isSafeInteger(row.knownRefundedMinor)&&row.knownRefundedMinor>=0?row.knownRefundedMinor:0;
    const priorReturns=orders.filter(order=>order.previousObservation?.refundedMinor>0);
    const priorRefunded=priorReturns.reduce((sum,order)=>sum+order.previousObservation.refundedMinor,0);
    position=Object.freeze({known:valid,removed,paymentPlanCurrent:settlement.paymentPlanCurrent===true,
      ...(!valid&&Number.isSafeInteger(priorRefunded)&&priorRefunded>0?{previouslyRefundedMinor:priorRefunded}:{}),
      ...(valid?{heldMinor:row.heldMinor,creditMinor:row.creditMinor,topUpMinor:row.topUpMinor,refundDueMinor:row.refundDueMinor,refundedMinor:returned}:{})});
  }
  return Object.freeze({available:true,checkedAt:history.checkedAt,orders:Object.freeze(orders),...(position?{position}:{})});
}

function outcome(row) {
  if (row.status === "UNKNOWN") return "Status unavailable at this check. Do not assume paid or unpaid.";
  if (row.captureStatus === "PARTIALLY_REFUNDED") return row.completedRefunds?.length
    ? "Partially refunded."
    : "Partially refunded. The remaining amount needs a fresh provider review.";
  if (row.captureStatus === "REFUNDED") return "Refund reported by PayPal.";
  if (row.captureStatus === "PENDING") return "Payment pending. This is not a completed capture.";
  if (row.captured) return "Completed capture observed";
  return "Order " + row.status + (row.captureStatus ? " · payment " + row.captureStatus : " · no completed capture observed");
}

function previousObservationHtml(row) {
  const prior=row.previousObservation;
  if(!prior)return "";
  const checked=new Intl.DateTimeFormat("en-GB",{dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(prior.checkedAt))+" UTC";
  return "<p class='previous-payment-observation'><strong>"+(prior.refundedMinor?"$"+usd(prior.refundedMinor)+" previously confirmed returned.":"$"+usd(prior.heldMinor)+" previously confirmed captured.")+"</strong><br>Earlier check: "+esc(checked)+". Current status is unavailable.</p>";
}

function refundObservationsHtml(row) {
  return (row.completedRefunds || []).map(refund =>
    "<p class='refund-observations'><strong>$" + esc(refund.amount) + " refunded</strong> · completed</p>").join("");
}

export function personalReturnHtml(context) {
  const position=context?.position;
  if(!position?.removed)return "";
  return "<div class='personal-return"+(!position.known?" is-unavailable":"")+"' role='group' aria-label='Your return'><span>"+(!position.known?"Your return":position.refundDueMinor?"Return to you":position.refundedMinor?"Return completed":"No return outstanding")+"</span><strong>"+(!position.known?"Status unavailable":"$"+usd(position.refundDueMinor||position.refundedMinor))+"</strong><p>"+(!position.known?"The current return amount could not be checked.":position.refundDueMinor?"Waiting to be returned.":position.refundedMinor?"PayPal reports this refund completed.":"No captured payment is retained.")+"</p>"+(!position.known&&position.previouslyRefundedMinor?"<small><strong>$"+usd(position.previouslyRefundedMinor)+" previously confirmed returned.</strong> See the earlier check below.</small>":position.known&&position.refundDueMinor&&position.refundedMinor?"<small>$"+usd(position.refundedMinor)+" refunded so far.</small>":"")+"</div>";
}

export function personalPaymentContextHtml(context,{live=false,removed=false,includeReturn=true}={}) {
  const position=context?.position;
  const positionHtml=position?.removed? (includeReturn?personalReturnHtml(context):""):position? "<p class='payment-position'><strong>"+(!position.known||!position.paymentPlanCurrent?"Check the changed payment amounts"
    :"$"+usd(position.creditMinor)+" retained for this plan")+"</strong>"+
    (position.known&&position.paymentPlanCurrent?"<br>"+(position.topUpMinor?"$"+usd(position.topUpMinor)+" remaining to pay.":"No additional payment needed.")+
      (position.refundDueMinor?" The changed plan calls for $"+usd(position.refundDueMinor)+" to be returned.":""):" Ask the organizer to review the current payments.")+"</p>":"";
  const intro = "<section class='payment-context' aria-labelledby='payment-context-title'>"+(removed?positionHtml:"")+"<h2 id='payment-context-title'>Payment history</h2>"+(removed?"":positionHtml);
  const meaning = removed || position ? "" : "<p class='payment-meaning'><strong>Your proposed share is not a calculation of what remains to pay.</strong> No automatic credit, refund or new payment.</p>";
  if (!context?.available) return intro + (removed?"<p>Your return status could not be checked. Ask the organizer for an update.</p>":"<p>Earlier payments could not be checked. Ask the organizer before paying more.</p>") + meaning + "</section>";
  const checked = new Intl.DateTimeFormat("en-GB", {dateStyle:"medium",timeStyle:"short",timeZone:"UTC"}).format(new Date(context.checkedAt)) + " UTC";
  const source = "<p class='fine observation-time'>Checked " + esc(checked) + "." + (live ? "" : "<br>This is a saved copy. Verify current payment status in PayPal.") + "</p>";
  if (!context.orders.length) return "<details class='payment-context is-empty'><summary>No earlier orders in this plan</summary><p>Payments elsewhere are not covered.</p>" + source + meaning + "</details>";
  const rows = context.orders.map(row => "<article class='prior-payment'><p class='fine'>Proposal R" + row.ordinal +
    "</p><p class='prior-amount'>$" + esc(row.amount) + " <span>original order amount</span></p><p class='payment-outcome'><strong>" +
    esc(outcome(row)) + "</strong></p>" + previousObservationHtml(row) + refundObservationsHtml(row) + "</article>").join("");
  const hasRefund = context.orders.some(row => ["PARTIALLY_REFUNDED", "REFUNDED"].includes(row.captureStatus));
  const scope = "<p class='payment-meaning'>" + (removed || position ? "" : "Payments are not deducted from the proposed share.") +
    (hasRefund ? " Refund arrival is not verified." : "") + "</p>";
  const references = context.orders.map(row => "<p>R" + row.ordinal + " · Order " + esc(row.orderId) +
    (row.captureId ? "<br>Capture " + esc(row.captureId) : row.previousObservation?"<br>Earlier capture "+esc(row.previousObservation.captureId):"") +
    (row.completedRefunds || []).map(refund => "<br>Refund " + esc(refund.id)).join("") + "</p>").join("");
  return intro + rows + "<details><summary>Payment references and check time</summary>" +
    references + source + meaning + scope + "</details></section>";
}

/** Project only an exact, recently checked prepared order into the payer's file. */
export function personalPayerHandoff(state, memberId, prepared, order) {
  const member = state?.evaluation?.members.find(m => m.id === memberId);
  if (!member || !state.evaluation.agreementRecorded || !prepared ||
      prepared.projectId !== state.project.projectId || prepared.revisionId !== state.current.revisionId ||
      prepared.ordinal !== state.current.ordinal || !Array.isArray(prepared.created)) return null;
  const entry = prepared.created.find(row => row.id === memberId);
  const credit=entry&&Number.isSafeInteger(entry.creditMinor)&&entry.creditMinor>=0&&entry.obligationMinor===member.amountMinor?entry.creditMinor:0;
  if (!entry || entry.amountMinor+credit !== member.amountMinor || entry.amount !== usd(entry.amountMinor) ||
      !order || order.memberId !== memberId || order.revisionId !== state.current.revisionId ||
      order.orderId !== entry.orderId || order.amount !== entry.amount) return null;
  if (order.captured) return {unavailable:true,reason:"captured"};
  if (order.status === "APPROVED") return {unavailable:true,reason:"approved"};
  if (order.status === "UNKNOWN") return {unavailable:true,reason:"unknown"};
  if (!["CREATED","PAYER_ACTION_REQUIRED"].includes(order.status)) return {unavailable:true,reason:"other",status:order.status};
  if (!validTime(order.reviewBefore) || Date.parse(order.reviewBefore) <= Date.now()) return {unavailable:true,reason:"expired"};
  let url;
  try { url = new URL(entry.approveUrl); } catch { return null; }
  if (url.protocol !== "https:" || !["www.sandbox.paypal.com","sandbox.paypal.com"].includes(url.hostname) ||
      url.username || url.password || url.port) return null;
  return Object.freeze({amount:entry.amount,...(credit?{creditAmount:usd(credit),obligationAmount:usd(member.amountMinor)}:{}),orderId:entry.orderId,url:url.href,ordinal:state.current.ordinal,reviewBefore:order.reviewBefore});
}

export function personalPayerHandoffHtml(handoff,{live=false}={}) {
  if (!handoff) return "";
  if (handoff.unavailable) {
    const titles = {
      approved:"Already approved", captured:"Payment complete", unknown:"Check payment status",
      expired:"Get a fresh payment check", other:"Check payment status"
    };
    const messages = {
      approved:"This order is already approved. The organizer must check whether the payment still needs to be completed. Do not approve another order.",
      captured:"PayPal confirmed this payment. Do not pay this share again; ask the organizer about any changed agreement.",
      unknown:"PayPal status could not be checked. Ask the organizer to check before using another payment link.",
      expired:"This link's review window has ended. Ask the organizer for a fresh check. An old link may still be active.",
      other:"This order is not awaiting your approval. Ask the organizer to review its status before another payment."
    };
    const reason = titles[handoff.reason] ? handoff.reason : "unknown";
    return "<section class='payer-handoff is-" + reason + "' aria-labelledby='payer-title'><h2 id='payer-title'>" + titles[reason] + "</h2><p>" +
      esc(messages[reason]) + (reason === "other" ? " Provider status: " + esc(handoff.status || "UNKNOWN") + "." : "") +
      "</p></section>";
  }
  return "<section class='payer-handoff is-ready' aria-labelledby='payer-title'><h2 id='payer-title'>Approve your payment</h2>" +
    "<p class='payment-confirm'>" + (live ? "This approval is for proposal <strong>R" + esc(handoff.ordinal) + "</strong>." : "Confirm with the organizer that <strong>R" + esc(handoff.ordinal) + "</strong> is still current.") + (handoff.creditAmount?" $"+esc(handoff.creditAmount)+" is already retained toward your $"+esc(handoff.obligationAmount)+" share. This is the additional payment.":" Earlier payments are not deducted from this order.")+"</p>" +
    "<a class='payer-link' data-review-before='" + esc(handoff.reviewBefore) + "' href='" + esc(handoff.url) + "' target='_blank' rel='noopener noreferrer'>Approve $" + esc(handoff.amount) + " on PayPal<span aria-hidden='true'> ↗</span></a>" +
    "<p class='payment-next'>The organizer completes the payment after your PayPal approval.</p>" +
    "<details><summary>Payment details</summary><p>Your review response does not authorize payment. Approval happens separately on PayPal.</p>" +
    (live ? "" : "<p>Old links may remain active after a change. This offline file cannot detect later agreement changes.</p>") + "<p>Order " + esc(handoff.orderId) +
    "</p><p>Review before " + esc(new Date(handoff.reviewBefore).toUTCString()) + ". This is the review window for this approval, not PayPal's link expiry.</p></details></section>";
}
