import { groupTabFontCss } from "./group-tab-font.mjs";
import { participantColors } from "./participant-colors.mjs";
import { personalPaymentContextHtml, personalPayerHandoffHtml, personalReturnHtml } from "./personal-payment-context.mjs";
import { evaluateRevision } from "./core.mjs";
import { formatUsdMinor as money, usdInputToMinor } from "./ui-utils.mjs";

const FORMAT = "clearinghouse-participant-response/v4";
const COMBINED_FORMAT = "clearinghouse-participant-response/v5";
const PAYMENT_RECORD_FORMAT = "clearinghouse-personal-payment-record/v1";
const LIMIT_FORMAT = "clearinghouse-participant-response/v3";
const LEGACY_FORMAT = "clearinghouse-participant-response/v2";
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[char]);

function exactFields(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
}

/**
 * A recipient-specific, read-only snapshot of a validated *current* revision.
 * It does not contain other participants' names, budgets or allocations.
 */
export function participantPacket(state, memberId) {
  if (!state?.current || !state?.project || !state?.evaluation) throw new Error("Open a recorded proposal first.");
  const member = state.evaluation.members.find(candidate => candidate.id === memberId);
  if (!member) throw new Error("That participant is not in the current revision.");
  const previous = state.revisions.length > 1 ? state.revisions.at(-2) : null;
  const oldMember = previous ? evaluateRevision(previous).members.find(candidate => candidate.id === memberId) : null;
  const items = state.current.items.map((item, index) => {
    const allocation = state.evaluation.items[index].allocations.find(row => row.memberId === memberId);
    return Object.freeze({ id: item.id, label: item.label, amountMinor: allocation?.minor ?? 0,
      participating: item.weights.some(row => row.memberId === memberId && row.units > 0) });
  });
  const totalFromItems = items.reduce((sum, item) => sum + BigInt(item.amountMinor), 0n);
  if (totalFromItems !== BigInt(member.amountMinor)) throw new Error("The recipient allocation does not reconcile.");
  return Object.freeze({
    format: FORMAT,
    projectId: state.project.projectId,
    title: state.project.title,
    revisionId: state.current.revisionId,
    ordinal: state.current.ordinal,
    proposalNote: state.current.note,
    memberId: member.id,
    memberName: member.name,
    participantColor: participantColors(state).get(member.id),
    amountMinor: member.amountMinor,
    budgetMinor: member.budgetMinor,
    overMinor: member.overMinor,
    priorAmountMinor: oldMember?.amountMinor ?? (previous ? 0 : null),
    feasible: state.evaluation.feasible,
    budgetsKnown: state.evaluation.budgetsKnown,
    items: Object.freeze(items)
  });
}

/** Current people first, followed by former people from their last recorded identity. */
export function recipientMembers(state) {
  const members = new Map(state.evaluation.members.map(member=>[member.id,{...member,removed:false}]));
  for(const revision of [...state.revisions].reverse())
    for(const member of revision.members)
      if(!members.has(member.id))members.set(member.id,{id:member.id,name:member.name,removed:true});
  return [...members.values()];
}

/** A former participant receives their own payment record, never current approval terms. */
export function recipientPacket(state, memberId) {
  const member=recipientMembers(state).find(member=>member.id===memberId);
  if(!member)throw new Error("That person has no recorded history in this group.");
  if(!member.removed)return participantPacket(state,memberId);
  return Object.freeze({
    format:PAYMENT_RECORD_FORMAT,removed:true,projectId:state.project.projectId,title:state.project.title,
    revisionId:state.current.revisionId,ordinal:state.current.ordinal,proposalNote:"",
    memberId:member.id,memberName:member.name,participantColor:participantColors(state).get(member.id),
    amountMinor:0,budgetMinor:null,overMinor:0,priorAmountMinor:null,feasible:false,items:Object.freeze([])
  });
}

export function reviewedTerms(packet, format = packet.format) {
  const items = [FORMAT, COMBINED_FORMAT].includes(format) ? packet.items : packet.items.map(({label, amountMinor}) => ({label, amountMinor}));
  return JSON.stringify({
    title: packet.title, memberName: packet.memberName, proposalNote: packet.proposalNote,
    amountMinor: packet.amountMinor, budgetMinor: packet.budgetMinor,
    overMinor: packet.overMinor, priorAmountMinor: packet.priorAmountMinor,
    feasible: packet.feasible, items,
    ...(packet.budgetsKnown === false ? { budgetsKnown: false } : {})
  });
}

export function parseParticipantResponse(state, text) {
  if (typeof text !== "string" || new TextEncoder().encode(text).length > 200_000) throw new Error("The response file is too large or invalid.");
  let response;
  try { response = JSON.parse(text); } catch { throw new Error("The response file is not valid JSON."); }
  if (response?.format === "clearinghouse-participant-response/v1") throw new Error("This older response does not bind the reviewed terms. Export a fresh participant review and ask for a new response.");
  const fields = ["format", "projectId", "revisionId", "ordinal", "memberId", "amountMinor", "answer", "note", "createdAt", "reviewedTerms"];
  if ([FORMAT, COMBINED_FORMAT, LIMIT_FORMAT].includes(response?.format)) fields.push("proposedBudgetMinor");
  if ([FORMAT, COMBINED_FORMAT].includes(response?.format)) fields.push("proposedExcludedItemIds");
  if (!exactFields(response, fields)) {
    throw new Error("The response is not a recognized participant response.");
  }
  if (![FORMAT, COMBINED_FORMAT, LIMIT_FORMAT, LEGACY_FORMAT].includes(response.format)) throw new Error("Unsupported participant response version.");
  if (response.projectId !== state?.project?.projectId || response.revisionId !== state?.current?.revisionId ||
      response.ordinal !== state?.current?.ordinal) {
    throw new Error("This response targets a different or retired proposal. Nothing was recorded.");
  }
  const packet = participantPacket(state, response.memberId);
  if (response.reviewedTerms !== reviewedTerms(packet, response.format)) throw new Error("The reviewed terms differ from this proposal. Export a fresh participant review; nothing was recorded.");
  if (response.amountMinor !== packet.amountMinor) throw new Error("The response's amount differs from the current recorded obligation.");
  if (!["agree", "decline", "propose-limit", "propose-exclusions", "propose-changes"].includes(response.answer)) throw new Error("Choose an explicit response.");
  if ((response.answer === "propose-changes") !== (response.format === COMBINED_FORMAT)) throw new Error("A combined request requires its explicit response version.");
  if (["propose-limit", "propose-changes"].includes(response.answer)) {
    if (![FORMAT, COMBINED_FORMAT, LIMIT_FORMAT].includes(response.format) || !Number.isSafeInteger(response.proposedBudgetMinor) || response.proposedBudgetMinor < 0) throw new Error("The proposed USD limit must be an exact nonnegative amount.");
  } else if ([FORMAT, COMBINED_FORMAT, LIMIT_FORMAT].includes(response.format) && response.proposedBudgetMinor !== null) throw new Error("Only a limit proposal may contain a proposed limit.");
  if (["propose-exclusions", "propose-changes"].includes(response.answer)) {
    const ids = response.proposedExcludedItemIds;
    if (![FORMAT, COMBINED_FORMAT].includes(response.format) || !Array.isArray(ids) || ids.length < 1 ||
        ids.length > packet.items.length || new Set(ids).size !== ids.length ||
        ids.some(id => typeof id !== "string" || !packet.items.some(item => item.id === id && item.participating)))
      throw new Error("Choose distinct items you participate in from this exact review.");
  } else if ([FORMAT, COMBINED_FORMAT].includes(response.format) && response.proposedExcludedItemIds !== null)
    throw new Error("Only an item-exclusion request may contain excluded items.");
  if (typeof response.note !== "string" || response.note.length > 500) throw new Error("The response note is invalid.");
  const timestamp = typeof response.createdAt === "string" ? new Date(response.createdAt) : null;
  if (!timestamp || !Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== response.createdAt) {
    throw new Error("The response timestamp is invalid.");
  }
  if (response.answer === "agree" && !packet.feasible) {
    throw new Error(packet.budgetsKnown === false ? "Spending limits are still unknown. Ask the organizer to confirm them before agreeing." : "This proposal exceeds at least one budget and cannot accept approval declarations.");
  }
  return Object.freeze({ response: Object.freeze(response), packet });
}

/**
 * A self-contained offline recipient page. Inline JavaScript produces a LOCAL
 * download only; no network, remote fonts, storage, payment or identity checks.
 * Treat returned JSON as unauthenticated self-attestation, never a signature.
 */
function participantStyles(participantColor) {
  return [
    "*{box-sizing:border-box} :root{color-scheme:dark;--bg:#0e0e11;--panel:#18181d;--line:#34343d;--muted:#aeabb8;--ink:#faf9fc;--person:",participantColor,";font-family:'Bricolage Grotesque',ui-rounded,'Arial Rounded MT Bold',system-ui,sans-serif;background:var(--bg);color:var(--ink);font-synthesis:none}",
    "body{margin:0;line-height:1.5}button,input,textarea{font:inherit}button,a,input,summary,textarea{-webkit-tap-highlight-color:transparent}button,a,summary{touch-action:manipulation}",
    ".masthead{max-width:1144px;margin:0 auto;padding:26px 32px 22px;display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line)}.brand{color:var(--ink);font-weight:850;font-size:20px;letter-spacing:-.8px}.brand-mark{display:inline-block;width:17px;height:17px;margin-right:9px;vertical-align:-1px;background:var(--person);border-radius:3px}.sandbox{color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}",
    "main{max-width:1144px;margin:0 auto;padding:46px 32px 48px;display:grid;grid-template-columns:minmax(0,1fr) minmax(330px,.88fr);column-gap:60px;row-gap:0;align-items:start}.plan{min-width:0}.person{display:flex;align-items:center;gap:12px;margin-bottom:24px}.avatar{display:grid;place-items:center;flex-shrink:0;width:46px;height:46px;background:var(--person);color:#111114;border-radius:50%;font-size:18px;font-weight:850}.person-name{font-weight:750;font-size:16px;margin:0}.revision{font-size:12px;color:var(--muted);margin:0}",
    "h1{font-size:clamp(30px,4vw,48px);line-height:1.03;letter-spacing:-1.8px;font-weight:800;margin:0 0 28px;max-width:15ch;overflow-wrap:anywhere}.share-label{font-size:14px;font-weight:650;margin:0 0 1px;color:var(--muted)}.amount{font-size:clamp(60px,6.9vw,92px);font-weight:800;letter-spacing:-5px;line-height:1.12;margin:0;font-variant-numeric:tabular-nums;color:var(--person);overflow-wrap:anywhere}.amount-currency{display:block;font-size:12px;letter-spacing:.02em;color:var(--muted);font-weight:600;line-height:1;margin-top:7px}.limit{font-size:14px;margin:17px 0 20px;color:var(--muted)}.limit.is-over{color:#ffc36a}.limit.is-missing{color:#ffc36a}",
    ".item-heading{display:flex;align-items:center;justify-content:space-between;border-top:4px solid var(--person);padding-top:18px;margin-top:26px}.item-heading h2{font-size:17px;line-height:1.3;font-weight:750;margin:0;letter-spacing:-.3px}.item-count{font-size:12px;color:var(--muted)}table{width:100%;border-collapse:collapse;margin-top:6px}th,td{padding:13px 0;border-bottom:1px solid var(--line);font-size:15px;vertical-align:top}th{text-align:left;font-weight:500;padding-right:18px;overflow-wrap:anywhere}td{text-align:right;font-weight:750;font-variant-numeric:tabular-nums;white-space:nowrap}.proposal-details{margin-top:15px}.proposal-details p{font-size:13px;color:var(--muted)}.reference{overflow-wrap:anywhere}",
    ".decision{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:26px;position:relative}.decision h2{font-size:25px;line-height:1.1;letter-spacing:-.75px;margin:0 0 20px;font-weight:800}.decision h2 span{color:var(--person)}fieldset{border:0;padding:0;margin:0;min-width:0}legend{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}",
    ".choice{display:flex;gap:12px;align-items:center;min-height:58px;padding:14px;border:1px solid #42414b;border-radius:10px;margin:8px 0;cursor:pointer;transition:background .12s,border-color .12s}.choice:first-of-type{margin-top:0}.choice:has(input:checked){border-color:var(--person);background:color-mix(in srgb,var(--person) 11%,var(--panel))}.choice:has(input:disabled){color:#8d8996;cursor:not-allowed}.choice strong{display:block;font-size:15px;font-weight:700}.choice small{display:block;font-size:12px;color:var(--muted);margin-top:2px}.choice input{margin:0;width:19px;height:19px;accent-color:var(--person);flex-shrink:0}",
    "#limit-fields{margin:12px 0 18px;padding:0 4px}#limit-fields label{display:block;font-size:13px;font-weight:600;margin-bottom:7px}input[type=text],textarea{width:100%;font-size:16px;min-height:48px;padding:12px;border:1px solid #57545f;border-radius:9px;background:#111115;color:var(--ink)}input[type=text]{font-variant-numeric:tabular-nums}textarea{min-height:88px;resize:vertical}input::placeholder,textarea::placeholder{color:#918c9c}.note-details{margin-top:14px}.note-details summary{font-weight:550}.note-details[open] summary{margin-bottom:8px}",
    ".exclusion-choice{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:10px;align-items:start;padding:10px 0;min-height:46px;font-size:14px;cursor:pointer}.exclusion-choice input{margin:4px 0 0;width:18px;height:18px;accent-color:var(--person)}.exclusion-choice .fine{font-size:12px;color:var(--muted);grid-column:2}#exclusion-choices{padding:8px 4px 12px}#exclusion-choices summary{font-size:13px}",
    ".submit{display:block;width:100%;min-height:54px;margin:24px 0 0;padding:13px 16px;background:var(--person);color:#111114;border:0;border-radius:11px;font-size:16px;font-weight:800;cursor:pointer;letter-spacing:-.3px}.submit:hover{filter:brightness(1.08)}.submit:disabled{opacity:.6;cursor:wait}.reply-note{font-size:12px;line-height:1.45;color:var(--muted);margin:12px 0 0}#status{font-size:14px;color:var(--person);margin:12px 0 0;overflow-wrap:anywhere}#status:empty{display:none}.caution{border-left:3px solid #ffc36a;padding:10px 0 10px 13px;margin:0 0 18px;font-size:14px;color:#ffcf84}",
    "details summary{cursor:pointer;min-height:36px;padding:6px 0;font-size:13px;color:var(--muted)}summary:hover{color:var(--ink)}.review-details{margin-top:18px}.review-details p{font-size:12px;color:var(--muted)}.fine{font-size:12px;color:var(--muted)}",
    ".personal-return{border:1px solid var(--line);border-left:4px solid var(--person);border-radius:12px;background:var(--panel);padding:18px;margin:0 0 26px}.personal-return>span{display:block;font-size:13px;color:var(--muted)}.personal-return>strong{display:block;font-size:36px;line-height:1.15;letter-spacing:-1px;margin:6px 0;color:var(--person)}.personal-return>p{margin:8px 0 0}.personal-return>small{display:block;color:var(--muted);margin-top:8px}",
    ".payment-context,.payer-handoff{margin-top:28px;border-top:1px solid var(--line);padding-top:20px}.payment-context h2,.payer-handoff h2{font-size:18px;line-height:1.25;margin:0 0 14px;letter-spacing:-.3px}.payment-context p,.payer-handoff p{font-size:14px;overflow-wrap:anywhere}.prior-payment{border-left:3px solid var(--person);padding:0 0 0 14px;margin:18px 0}.prior-payment .prior-amount{font-size:26px;font-weight:800;letter-spacing:-.6px;margin:6px 0}.prior-amount span{display:block;font-size:12px;font-weight:500;letter-spacing:0;color:var(--muted)}.payment-context .payment-meaning{font-size:12px;color:var(--muted)}.payer-link{display:block;padding:14px 18px;background:var(--person);color:#111114;border-radius:10px;font-size:15px;font-weight:800;text-align:center;text-decoration:none}.payer-link:not([href]){background:#303039;color:#c8c3d0}.payment-outcome{margin:6px 0}",
    ":focus-visible{outline:3px solid var(--person);outline-offset:4px}[hidden]{display:none!important}@media(prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important}}",
    "@media(max-width:760px){.masthead{padding:17px 20px}.brand{font-size:18px}.brand-mark{width:14px;height:14px;margin-right:7px}.sandbox{font-size:11px}main{display:block;padding:25px 20px 32px}.person{gap:10px;margin-bottom:17px}.avatar{width:38px;height:38px;font-size:15px}.person-name{font-size:14px}.revision{font-size:11px}h1{font-size:32px;letter-spacing:-1.2px;max-width:19ch;margin-bottom:22px}.amount{font-size:68px;letter-spacing:-3.7px}.share-label{font-size:13px}.amount-currency{display:inline;margin-left:9px;vertical-align:10px;font-size:11px}.limit{margin:9px 0 16px;font-size:13px}.item-heading{padding-top:12px;margin-top:18px}.item-heading h2{font-size:15px}th,td{padding:10px 0;font-size:14px}.proposal-details{margin-top:9px}.decision{position:static;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent;padding:23px 0 0;margin-top:22px}.decision h2{font-size:24px;margin-bottom:16px}.choice{min-height:52px;padding:12px}.submit{margin-top:20px}.payment-context,.payer-handoff{margin-top:20px}}",
    "@media(min-width:761px){.plan .proposal-details{max-width:40ch}.review-details{max-width:40ch}}@media(max-width:350px){.masthead{padding-left:16px;padding-right:16px}main{padding-left:16px;padding-right:16px}.brand{font-size:16px}.sandbox{font-size:10px}.amount{font-size:58px}.choice strong{font-size:14px}}",
    "@media(max-width:760px){.person{margin-bottom:14px}h1{font-size:30px;line-height:1.08;margin-bottom:18px}.amount{font-size:64px;line-height:1.08}.limit{margin-bottom:12px}.decision{margin-top:18px;padding-top:19px}.decision h2{margin-bottom:14px}#response-form fieldset{display:grid;grid-template-columns:1fr 1fr;gap:8px}.choice{margin:0;min-height:64px;padding:11px;gap:9px}.choice strong{font-size:14px;line-height:1.3}.choice input{width:18px;height:18px}#limit-fields,#exclusion-choices,.note-details{grid-column:1/-1}#limit-fields{margin:5px 0 7px}.note-details{margin-top:3px}.submit{margin-top:15px}.proposal-details{margin-top:15px}#exclusion-choices{margin:0}.review-details{margin-top:8px}}",
    "@media(max-width:760px) and (max-height:720px){.masthead{padding-top:10px;padding-bottom:10px}main{padding-top:16px}.person{margin-bottom:8px}h1{font-size:26px;margin-bottom:12px}.amount{font-size:52px;letter-spacing:-2.7px}.limit{margin-top:6px;margin-bottom:8px}.item-heading{padding-top:8px;margin-top:12px}th,td{padding-top:6px;padding-bottom:6px}.decision{margin-top:12px;padding-top:12px}.decision h2{font-size:22px;margin-bottom:10px}.choice{min-height:52px;padding:8px}.submit{min-height:48px;margin-top:10px;padding-top:10px;padding-bottom:10px}}",
    ".sent-reply{border-left:3px solid var(--person);padding:3px 0 3px 14px;margin-bottom:18px}.sent-reply strong{font-size:22px;line-height:1.25}.sent-reply p{margin:6px 0;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere}.sent-reply p:empty{display:none}#response-editor>summary{font-size:14px;padding:12px 0}#response-editor[open]>summary{margin-bottom:10px}",
    ".review-actions{grid-column:2;grid-row:1 / span 2;position:sticky;top:24px;min-width:0}.payment-context{grid-column:1}.payment-context.is-empty{padding-top:8px;margin-top:20px}.payment-context.is-empty summary{font-size:13px}.payer-handoff{border:1px solid var(--line);border-radius:20px;background:var(--panel);padding:25px;margin:0}.payer-handoff h2{font-size:25px;letter-spacing:-.7px;line-height:1.12;margin-bottom:18px}.payer-handoff .payment-confirm{color:var(--muted);line-height:1.5;margin:0 0 20px}.payment-confirm strong{color:var(--ink)}.payer-handoff .payment-next{font-size:12px;color:var(--muted);line-height:1.5;margin:12px 0 8px}.payer-handoff details p{font-size:12px;color:var(--muted)}.payer-link{min-height:54px;padding:15px 12px;font-size:16px;letter-spacing:-.3px}.payer-link span{float:right}.payer-handoff.is-approved,.payer-handoff.is-captured{border-top:4px solid var(--person)}.payer-handoff.is-unknown,.payer-handoff.is-expired,.payer-handoff.is-other{border-top:4px solid #ffc36a}.response-disclosure{margin-top:16px}.response-disclosure>summary{padding:12px 4px;font-size:14px;color:var(--ink)}.response-disclosure .decision{border:0;border-radius:0;background:transparent;padding:16px 0 0}.response-disclosure .decision h2{font-size:22px}.response-disclosure .submit{background:transparent;color:var(--person);border:1px solid var(--person)}",
    "@media(max-width:760px){.review-actions{position:static}.payer-handoff{margin-top:20px;padding:20px;border-radius:16px}.payer-handoff h2{font-size:23px;margin-bottom:14px}.payer-handoff .payment-confirm{font-size:13px;margin-bottom:16px}.payment-context.is-empty{margin-top:12px;padding-top:2px}.response-disclosure{margin-top:9px}.response-disclosure .decision{margin-top:0;padding-top:12px}.response-disclosure>summary{font-size:13px}.payer-handoff details summary{font-size:12px}}",
    ".personal-record{display:block;max-width:760px}.personal-record h1{font-size:clamp(26px,3vw,38px);line-height:1.12;max-width:24ch;margin-bottom:28px}.personal-record .personal-return{border:0;border-radius:0;background:transparent;padding:0;margin:0 0 20px}.personal-record .personal-return>span{font-size:16px;font-weight:600;color:var(--ink)}.personal-record .personal-return>strong{font-size:clamp(56px,7vw,80px);line-height:1.06;letter-spacing:-.045em;margin:6px 0 10px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.personal-record .personal-return.is-unavailable>strong{font-size:clamp(30px,5vw,44px);letter-spacing:-1px}.personal-record .personal-return>p{font-size:16px;margin:0}.personal-record .former-status{font-size:13px;line-height:1.5;letter-spacing:0;color:var(--muted);font-weight:400;margin:18px 0 0}.personal-record .former-status span{white-space:nowrap}.personal-record .payment-context{margin-top:26px;padding-top:24px}.personal-record .review-actions{position:static;margin-top:16px}.personal-record .review-actions .proposal-details{margin:0}@media(max-width:760px){.personal-record h1{font-size:28px;margin-bottom:26px}.personal-record .personal-return>strong{font-size:64px}.personal-record .personal-return.is-unavailable>strong{font-size:36px}.personal-record .payment-context{margin-top:23px;padding-top:20px}}",
  ].join("");
}

export function participantContinuationHtml({ordinal, path}) {
  const available=Number.isSafeInteger(ordinal) && ordinal>0 && /^\/participant\/[A-Za-z0-9_-]{43}\/continue$/.test(path||"");
  return [
    "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<meta name='referrer' content='strict-origin'><meta name='color-scheme' content='dark'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; font-src data:; form-action 'self'; base-uri 'none'\">",
    "<title>The plan has changed — CLEARINGHOUSE</title><style>",groupTabFontCss,participantStyles("#ff786b"),
    ".continuation{display:block;max-width:720px}.continuation h1{max-width:16ch}.continuation p{max-width:48ch}.continuation form{margin-top:28px}.continuation button{min-height:48px;padding:13px 20px;background:#d0fa64;color:#14150f;border:0;border-radius:11px;font-weight:800;cursor:pointer}.continuation button:focus-visible{outline:3px solid #faf9fc;outline-offset:4px}",
    "</style></head><body><header class='masthead'><div class='brand'><span class='brand-mark' aria-hidden='true'></span>clearinghouse</div><span class='sandbox'>PayPal Sandbox</span></header>",
    "<main class='continuation'><h1>The plan has changed.</h1>",
    available ? "<p>A new proposal is ready for you. Review it before sending your next reply.</p><form method='post' action='"+escapeHtml(path)+"'><button id='review-current-proposal' type='submit'>Review proposal R"+ordinal+"</button></form>" :
      "<p>The organizer has not shared the new proposal with you yet. Ask them for an updated invitation.</p>",
    "<p class='fine'>Your earlier reply stays with the proposal you reviewed.</p></main></body></html>"
  ].join("");
}

export function participantUnavailableHtml({ expired = false, temporary = false } = {}) {
  const heading = expired ? "This invitation has expired." : temporary ? "Your invitation could not be opened." : "This invitation isn't available.";
  const next = temporary ? "Try opening your original invitation again in a moment. If it still will not open, ask the person who sent it for a new link." : "Ask the person who sent this link for a new invitation to your current proposal.";
  return [
    "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<meta name='referrer' content='no-referrer'><meta name='color-scheme' content='dark'><meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; style-src 'unsafe-inline'; font-src data:; form-action 'none'; base-uri 'none'\">",
    "<title>Invitation unavailable — CLEARINGHOUSE</title><style>", groupTabFontCss, participantStyles("#ff786b"),
    ".unavailable{display:block;max-width:720px;padding-top:64px}.unavailable h1{max-width:18ch}.unavailable p{max-width:46ch;line-height:1.6}.unavailable .next-step{border-left:3px solid #d0fa64;padding-left:18px;margin-top:28px}.unavailable .next-step h2{font-size:18px;margin:0 0 8px}.unavailable .next-step p{margin:0}.unavailable .fine{margin-top:28px}@media(max-width:760px){.unavailable{padding-top:36px}.unavailable h1{font-size:34px;line-height:1.12}}",
    "</style></head><body><header class='masthead'><div class='brand'><span class='brand-mark' aria-hidden='true'></span>clearinghouse</div><span class='sandbox'>PayPal Sandbox</span></header>",
    "<main class='unavailable'><h1>", heading, "</h1><section class='next-step' aria-labelledby='next-step'><h2 id='next-step'>What to do next</h2><p>", next, "</p></section>",
    "<p class='fine'>Opening this page has not sent a reply or made a payment.</p></main></body></html>"
  ].join("");
}

export function participantReviewHtml(packet, { paymentContext, payerHandoff, shared = false, submitted = false, savedResponse = null, replyConflict = false } = {}) {
  if (!packet || ![FORMAT,PAYMENT_RECORD_FORMAT].includes(packet.format) || !Array.isArray(packet.items)) throw new Error("A valid participant packet is required.");
  const removed=packet.format===PAYMENT_RECORD_FORMAT;
  if(!shared) savedResponse=null;
  if(savedResponse && (savedResponse.projectId!==packet.projectId || savedResponse.revisionId!==packet.revisionId ||
    savedResponse.memberId!==packet.memberId || savedResponse.reviewedTerms!==reviewedTerms(packet,savedResponse.format)))
    throw new Error("The saved reply does not match this personal review.");
  const saved=Boolean(savedResponse);
  const checked=answer=>(savedResponse?.answer===answer || (savedResponse?.answer==="propose-changes" && answer==="propose-limit")) ? " checked" : "";
  const savedLimit=["propose-limit","propose-changes"].includes(savedResponse?.answer) ? (savedResponse.proposedBudgetMinor/100).toFixed(2) : "";
  const savedExclusions=["propose-exclusions","propose-changes"].includes(savedResponse?.answer) ? savedResponse.proposedExcludedItemIds : [];
  const replyKind=response=>["propose-limit","propose-changes"].includes(response?.answer) ? "Proposed limit: "+money(response.proposedBudgetMinor) :
    response?.answer==="propose-exclusions" ? "Requested item changes" : response?.answer==="agree" ? "Agreed to this share" : "Requested a change";
  const replyDetail=response=>["propose-exclusions","propose-changes"].includes(response?.answer) ?
    "Leave out: "+packet.items.filter(item=>response.proposedExcludedItemIds.includes(item.id)).map(item=>item.label).join(", ") : "";

  const source = {
    format: FORMAT, projectId: packet.projectId, revisionId: packet.revisionId,
    ordinal: packet.ordinal, memberId: packet.memberId, amountMinor: packet.amountMinor,
    reviewedTerms: reviewedTerms(packet)
  };
  const data = JSON.stringify(source).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const prior = packet.priorAmountMinor === null ? "First recorded proposal" :
    "Previous proposal: " + money(packet.priorAmountMinor) + " · Change: " +
    (packet.amountMinor >= packet.priorAmountMinor ? "+" : "−") + money(Math.abs(packet.amountMinor - packet.priorAmountMinor));
  const rows = packet.items.map(item => "<tr><th scope='row'>" + escapeHtml(item.label) + "</th><td>" + money(item.amountMinor) + "</td></tr>").join("");
  const exclusionChoices = packet.items.filter(item => item.participating).map(item =>
    "<label class='exclusion-choice'><input type='checkbox' name='exclude-item' value='" + escapeHtml(item.id) + "'" + (savedExclusions.includes(item.id) ? " checked" : "") + "> " +
    escapeHtml(item.label) + " <span class='fine'>— current share " + money(item.amountMinor) + "</span></label>").join("");
  const agreeDisabled = !packet.feasible ? " disabled" : "";
  const issue = packet.feasible
    ? "This proposal is within everyone's recorded budget limits. Each participant still needs to decide independently."
    : packet.budgetsKnown === false ? "At least one spending limit has not been provided. Agreement is disabled until the organizer confirms every limit."
    : "At least one participant exceeds a recorded budget. Agreement is disabled; ask the organizer to revise the plan.";
  const script = [
    usdInputToMinor.toString(),
    "const base=JSON.parse(document.getElementById('packet-data').textContent);",
    "const status=document.getElementById('status');let formVersion=0;",
    ...(shared ? [
      "const ownItems="+JSON.stringify(packet.items.map(item=>({id:item.id,label:item.label}))).replace(/</g,"\\u003c").replace(/>/g,"\\u003e")+";",
      "const displaySavedReply=(response,keepDraft=false)=>{const kind=['propose-limit','propose-changes'].includes(response.answer)?'Proposed limit: $'+(response.proposedBudgetMinor/100).toFixed(2):response.answer==='propose-exclusions'?'Requested item changes':response.answer==='agree'?'Agreed to this share':'Requested a change';document.querySelector('#sent-reply-kind').textContent=kind;document.querySelector('#sent-reply-detail').textContent=['propose-exclusions','propose-changes'].includes(response.answer)?'Leave out: '+ownItems.filter(item=>response.proposedExcludedItemIds.includes(item.id)).map(item=>item.label).join(', '):'';document.querySelector('#sent-reply-note').textContent=response.note;document.querySelector('#sent-reply').hidden=false;const conflict=document.querySelector('#reply-conflict');if(conflict)conflict.hidden=true;document.querySelector('#decision-title').textContent='Your reply';document.querySelector('#response-editor').open=keepDraft;document.querySelector('#response-editor > summary').hidden=false;document.querySelector('#response-editor > summary').textContent=keepDraft?'Your unsent changes':'Change my response';if(!keepDraft)document.querySelector('#sent-reply').focus();};"
    ] : []),
    "document.getElementById('response-form').addEventListener('input',()=>{formVersion++;status.textContent='';const answer=document.querySelector('[name=answer]:checked')?.value;document.getElementById('limit-fields').hidden=answer!=='propose-limit';const exclusions=document.getElementById('exclusion-choices');exclusions.hidden=!['propose-limit','propose-exclusions'].includes(answer);exclusions.querySelector('summary').textContent=answer==='propose-limit'?'Also leave items out (optional)':'Items to leave out';if(answer==='propose-exclusions')exclusions.open=true;});",
    "const payerLink=document.querySelector('.payer-link');",
    "if(payerLink)payerLink.addEventListener('click',event=>{if(Date.now()>=Date.parse(payerLink.dataset.reviewBefore)){event.preventDefault();payerLink.textContent='Review window ended — ask the organizer for a fresh check';payerLink.removeAttribute('href');}});",
    "document.getElementById('response-form').addEventListener('submit',async event=>{",
    "event.preventDefault();",
    "let answer=new FormData(event.currentTarget).get('answer');",
    "if(!['agree','decline','propose-limit','propose-exclusions'].includes(answer)){status.textContent='Choose your response first.';return;}",
    "const proposedBudgetMinor=answer==='propose-limit'?usdInputToMinor(document.getElementById('proposed-limit').value):null;",
    "if(answer==='propose-limit'&&!Number.isSafeInteger(proposedBudgetMinor)){status.textContent='Enter a USD limit of zero or more, with at most two decimal places.';document.getElementById('proposed-limit').focus();return;}",
    "const selectedItems=['propose-limit','propose-exclusions'].includes(answer)?[...document.querySelectorAll('[name=exclude-item]:checked')].map(input=>input.value):[];const proposedExcludedItemIds=selectedItems.length?selectedItems:null;",
    "if(answer==='propose-exclusions'&&!proposedExcludedItemIds?.length){status.textContent='Select at least one item you want to leave out of your share.';return;}",
    "if(answer==='propose-limit'&&proposedExcludedItemIds?.length)answer='propose-changes';const sentVersion=formVersion;const response={...base,format:answer==='propose-changes'?'clearinghouse-participant-response/v5':base.format,answer,proposedBudgetMinor,proposedExcludedItemIds,note:document.getElementById('note').value,createdAt:new Date().toISOString()};",
    ...(shared ? [
      "const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;status.textContent='Sending…';",
      "try{const result=await fetch('/api/participation/reply',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+location.pathname.split('/').pop()},body:JSON.stringify({response:JSON.stringify(response)})});const body=await result.json();if(!result.ok)throw new Error(body.message||'Could not send your response.');const keepDraft=formVersion!==sentVersion;status.textContent=keepDraft?'Your earlier reply was sent. Your newer edits are not sent.':'Response sent for R'+body.ordinal+'.';button.textContent='Update my response';displaySavedReply(response,keepDraft);}catch(error){status.textContent=error.message;}finally{button.disabled=false;}return;"
    ] : []),
    "const blob=new Blob([JSON.stringify(response,null,2)],{type:'application/json'});",
    "const url=URL.createObjectURL(blob);const link=document.createElement('a');",
    "link.href=url;link.download='clearinghouse-response-'+base.projectId+'-r'+base.ordinal+'-'+base.memberId+'.json';",
    "link.click();status.textContent='Response download requested. Locate the actual file and return it to the organizer.';",
    "setTimeout(()=>URL.revokeObjectURL(url),1000);",
    "});"
  ].join("");

  const participantColor = /^#[0-9a-f]{6}$/i.test(packet.participantColor || "") ? packet.participantColor : "#ff786b";
  const initials = packet.memberName.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join("").toLocaleUpperCase();
  const balanceLabel = packet.budgetMinor === null ? "Limit: Not provided · Budget check unresolved" :
    packet.overMinor ? "Over your limit by " + money(packet.overMinor) : "Within your " + money(packet.budgetMinor) + " limit";
  const personalReturn = removed ? personalReturnHtml(paymentContext) : "";
  const paymentHistory = removed || paymentContext || (!shared && payerHandoff) ? personalPaymentContextHtml(paymentContext,{live:shared,removed,includeReturn:!personalReturn}) : "";
  const paymentAction = removed ? "" : personalPayerHandoffHtml(payerHandoff,{live:shared});
  const itemSummary = packet.items.length + (packet.items.length === 1 ? " item" : " items");
  const notes = "<details class='proposal-details'><summary>Proposal details</summary><p>" +
    escapeHtml(packet.proposalNote || "No organizer note provided.") + "</p><p>" + escapeHtml(prior) +
    "</p><p class='reference'>Project " + escapeHtml(packet.projectId) + " · Revision " + escapeHtml(packet.revisionId) + "</p></details>";
  const responseState = submitted ? "Your response was received." : "";
  const decision = removed ? "<details class='proposal-details'><summary>Record details</summary><p>Current group revision R"+packet.ordinal+"</p></details>" : [
    paymentAction?"<details class='response-disclosure'><summary>Review or change your response</summary>":"",
    "<section class='decision' aria-labelledby='decision-title'><h2 id='decision-title'>",saved?"Your reply":submitted?"Your response is sent.":"Does this work <span>for you?</span>","</h2>",
    packet.feasible?"":"<p class='caution'>"+escapeHtml(issue)+"</p>",
    shared&&replyConflict?"<p id='reply-conflict' class='caution'>Your earlier replies disagree. Send your current answer so the organizer knows which to use.</p>":"",
    shared?"<div id='sent-reply' class='sent-reply' tabindex='-1'"+(saved?"":" hidden")+"><p class='fine'>Sent for R"+packet.ordinal+"</p><strong id='sent-reply-kind'>"+(saved?escapeHtml(replyKind(savedResponse)):"")+"</strong><p id='sent-reply-detail'>"+(saved?escapeHtml(replyDetail(savedResponse)):"")+"</p><p id='sent-reply-note'>"+escapeHtml(savedResponse?.note||"")+"</p></div><details id='response-editor'"+(saved?"":" open")+"><summary"+(saved?"":" hidden")+">Change my response</summary>":"",
    "<form id='response-form'><fieldset><legend>Your response to this exact revision</legend>",
    "<label class='choice'><input type='radio' name='answer' value='agree'",agreeDisabled,checked("agree"),"><strong>Agree to this share</strong></label>",
    "<label class='choice'><input type='radio' name='answer' value='decline'"+checked("decline")+"><strong>Request a change</strong></label>",
    "<label class='choice'><input type='radio' name='answer' value='propose-limit'"+checked("propose-limit")+"><strong>Propose a spending limit</strong></label>",
    "<label class='choice'><input type='radio' name='answer' value='propose-exclusions'"+checked("propose-exclusions")+"><strong>Leave items out</strong></label>",
    "<div id='limit-fields'"+(['propose-limit','propose-changes'].includes(savedResponse?.answer)?'':' hidden')+"><label for='proposed-limit'>Your limit in USD</label><input id='proposed-limit' type='text' inputmode='decimal' autocomplete='off' placeholder='55.00' value='"+escapeHtml(savedLimit)+"'></div>",
    "<details id='exclusion-choices'"+(['propose-exclusions','propose-changes'].includes(savedResponse?.answer)?' open':savedResponse?.answer==='propose-limit'?'':' hidden')+"><summary>"+(["propose-limit","propose-changes"].includes(savedResponse?.answer)?"Also leave items out (optional)":"Items to leave out")+"</summary>",exclusionChoices || "<p class='fine'>You do not currently participate in any items.</p>","</details>",
    "<details class='note-details'"+(savedResponse?.note?' open':'')+"><summary>Add a note</summary><label for='note' class='fine'>Anything the organizer should know?</label><textarea id='note' maxlength='500' aria-label='Optional note' placeholder='Tell the group what would work.'>"+escapeHtml(savedResponse?.note||'')+"</textarea></details></fieldset>",
    "<button class='submit' type='submit'>",shared?(submitted?"Update my response":"Send my response"):"Download my response","</button>",
    "<p id='status' role='status' aria-live='polite'>",responseState,"</p></form>",shared?"</details>":"",
    shared?"":"<p class='reply-note'>Send your downloaded response to the organizer.</p>",
    shared?"":"<details class='review-details'><summary>About this response</summary><p>This local file does not authenticate your identity. Your response is not a signature and does not authorize payment.</p></details>",
    notes,
    "</section>",paymentAction?"</details>":""
  ].join("");
  return [
    "<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>",
    "<meta name='color-scheme' content='dark'>",
    "<meta http-equiv='Content-Security-Policy' content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; connect-src " + (shared ? "'self'" : "'none'") + "; img-src 'none'; form-action 'none'; base-uri 'none'\">",
    "<title>", escapeHtml(packet.title), " — ", escapeHtml(packet.memberName), "</title>",
    "<style>",groupTabFontCss,
    participantStyles(participantColor),
    "</style></head><body><header class='masthead'><div class='brand'><span class='brand-mark' aria-hidden='true'></span>clearinghouse</div><span class='sandbox'>PayPal Sandbox</span></header>",
    "<main",removed?" class='personal-record'":"","><section class='plan' aria-labelledby='plan-title'><div class='person'><span class='avatar' aria-hidden='true'>",escapeHtml(initials),"</span><div><p class='person-name'>",escapeHtml(packet.memberName),"</p><p class='revision'>Proposal R",packet.ordinal,"</p></div></div>",
    "<h1 id='plan-title'>",escapeHtml(packet.title),"</h1>",removed?personalReturn+"<p class='former-status'>You are no longer in this plan. <span>No current share.</span></p>":"<p class='share-label'>Your proposed share</p><p class='amount'>"+money(packet.amountMinor)+"<span class='amount-currency'>USD</span></p>",
    removed?"":"<p class='limit"+(packet.budgetMinor===null?" is-missing":packet.overMinor?" is-over":"")+"'>"+escapeHtml(balanceLabel)+"</p>",
    removed?"":"<div class='item-heading'><h2>Your part of the plan</h2><span class='item-count'>"+itemSummary+"</span></div><table aria-label='Your item shares'><tbody>"+rows+"</tbody></table>",
    "</section>",paymentHistory,
    "<aside class='review-actions'>",paymentAction,
    decision,"</aside></main>",removed?"":"<script id='packet-data' type='application/json'>"+data+"</script><script>"+script+"</script>","</body></html>"
  ].join("");

}

/** Validate a reply against the recorded revision before copying one draft field. */
export function participantLimitForDraft(state, text, draft) {
  const parsed = parseParticipantResponse(state, text);
  if (parsed.response.answer !== "propose-limit") throw new Error("This reply does not propose a spending limit.");
  const matches = draft?.members?.filter(member => member.id === parsed.response.memberId);
  if (!matches || matches.length !== 1) throw new Error("The responding participant is no longer in this draft. Nothing was copied.");
  return Object.freeze({
    memberId: parsed.response.memberId,
    memberName: parsed.packet.memberName,
    budgetMinor: parsed.response.proposedBudgetMinor,
    note: parsed.response.note,
    createdAt: parsed.response.createdAt,
    revisionId: parsed.response.revisionId
  });
}

/** Review a source-bound item exclusion against the current editable proposal.
 * Returns exact consequences without mutating either history or draft. */
export function participantExclusionsForDraft(state, text, draft) {
  const {response, packet} = parseParticipantResponse(state, text);
  if (!["propose-exclusions","propose-changes"].includes(response.answer)) throw new Error("This reply does not request item exclusions.");
  if (draft?.members?.filter(member => member.id === response.memberId).length !== 1)
    throw new Error("The responding participant is no longer in this draft. Nothing was copied.");
  const changes = response.proposedExcludedItemIds.map(itemId => {
    const matches = draft.items?.filter(item => item.id === itemId);
    if (matches?.length !== 1) throw new Error("A requested item is no longer in this draft. Nothing was copied.");
    const item = matches[0];
    const own = item.weights.filter(weight => weight.memberId === response.memberId);
    if (own.length !== 1) throw new Error("The participant's item share is unavailable. Nothing was copied.");
    const remaining = item.weights.filter(weight => weight.memberId !== response.memberId)
      .reduce((sum, weight) => sum + weight.units, 0);
    if (!Number.isSafeInteger(remaining) || remaining < 1)
      throw new Error("Excluding " + packet.memberName + " from “" + item.label +
        "” would leave no participant for that item. Choose who participates or remove the item explicitly first. Nothing was copied.");
    return Object.freeze({itemId, label:item.label, previousUnits:own[0].units, units:0});
  });
  const before = evaluateRevision(draft);
  const candidate = structuredClone(draft);
  if(response.answer==="propose-changes")candidate.members.find(member=>member.id===response.memberId).budgetMinor=response.proposedBudgetMinor;
  for (const change of changes)
    candidate.items.find(item => item.id === change.itemId).weights
      .find(weight => weight.memberId === response.memberId).units = 0;
  const after = evaluateRevision(candidate);
  return Object.freeze({memberId:response.memberId, memberName:packet.memberName,
    note:response.note, createdAt:response.createdAt, revisionId:response.revisionId,
    changes:Object.freeze(changes), before, after,
    ...(response.answer==="propose-changes"?{proposedBudgetMinor:response.proposedBudgetMinor}:{})});
}
