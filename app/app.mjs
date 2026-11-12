import { participantColors } from "./participant-colors.mjs";
import { ScenarioComparison, compareScenarios } from "./scenario-comparison.mjs";
import { personalPaymentContext, personalPayerHandoff } from "./personal-payment-context.mjs";
import { constants, allocateItem, evaluateRevision, replayProject } from "./core.mjs";
import { WorkspaceController } from "./controller.mjs";
import { BrowserWorkspaceStore, exportPortableWorkspace, parsePortableWorkspace } from "./workspace-recovery.mjs";
import { formatUsdMinor as money, updateWeightLabelText, usdInputToMinor, minorToUsdInput } from "./ui-utils.mjs";
import { changeBriefAgainstRevision, changeBriefHtml } from "./change-brief.mjs";
import { proposeBudgetRescue } from "./budget-rescue.mjs";
import { recipientPacket, recipientMembers, participantReviewHtml, parseParticipantResponse, participantLimitForDraft, participantExclusionsForDraft } from "./participant-review.mjs";
import { validateSuggestion } from "./ai-negotiation.mjs";
import { matchesPreparedSandboxOrder, summarizeSandboxChecks, checksFromGroupReconciliation } from "./sandbox-settlement.mjs";

const controller = new WorkspaceController();
const scenarios = new ScenarioComparison();
let mobileScenarioId = null;
let aiConfigured = false;
async function checkAiConfiguration() {
  const button = document.querySelector("#ask-ai");
  const status = document.querySelector("#ai-availability");
  button.disabled = true;
  status.textContent = "Checking optional AI configuration…";
  try {
    const response = await fetch("/api/ai/status",{cache:"no-store"});
    if (!response.ok) throw new Error("Status unavailable");
    const info = await response.json();
    aiConfigured = info.configured === true;
    button.disabled = !aiConfigured || (!$("#change-panel").hidden && currentDraft?.members.some(member => member.budgetMinor === null));
    status.textContent = aiConfigured
      ? "Ready"
      : "AI is unavailable. You can still use the split above.";
  } catch {
    aiConfigured = false;
    button.disabled = true;
    status.textContent = "AI is unavailable. You can still use the split above.";
  }
}

const $ = selector => document.querySelector(selector);
const now = () => new Date().toISOString();
const limitLabel = value => value === null ? "Not provided" : money(value);
let serial = 0;
let creatingPlan = false;
let activeDraftId = 0;
let currentDraft = null;
let recoveryStore = null;
let recoveryEnabled = false;
let restoringRecovery = false;
let recoveryError = "";
let recoveryResume = null;
let draftReturnRevision = null;
let checkoutRequest = null;
let checkoutPreparing = false;
let netReview=null,netReviewKey=null;
let settlementLoading = false;
let settlementKey = null;
let settlementResult = null;
let checkoutDiscoveryKey = null;
let checkoutSession = null;
let sandboxEvidenceKey = null;
let sandboxChecks = new Map();
let sandboxCheckAttempted = false;
let paymentHistorySession = null;
let paymentHistoryKey = null;
let paymentHistoryRequest = 0;
let paymentHistory = { phase: "idle", orders: [], checkedAt: null };
const observedPaymentOrders = new Map();
let comparisonWorkspaceSession = null;
let comparisonFromOrdinal = null;
let comparisonExplicit = false;
const newId = prefix => `${prefix}-${Date.now().toString(36)}-${(++serial).toString(36)}`;
const el = (name, text, className) => { const node = document.createElement(name); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
const announce = message => { $("#live-status").textContent = ""; requestAnimationFrame(() => { $("#live-status").textContent = message; }); };

function setCreationMode(active) {
  creatingPlan = active;
  $("#workspace").dataset.mode = active ? "create" : "recorded";
  $("#app-shell").dataset.view = active ? "create" : (controller.project ? "workspace" : "welcome");
  $("#draft-name-field").hidden = !active;
  $("#draft-project-name").required = active;
  $("#change-note-field").hidden = active;
  $("#change-note").required = !active;
  $("#draft-context").hidden = active;
  $("#draft-heading").textContent = active ? "Build your group plan" : "Review a change";
  $("#preview-title").textContent = active ? "Everyone’s share" : "Review this split";
  $("#save-draft").textContent = active ? "Save group plan" : "Create next revision";
  $("#save-draft").disabled = false;
}
function draftContext() {
  return JSON.stringify({ activeDraftId, creatingPlan, generation: controller.generation, session: controller.session });
}
function startNewPlan(title = "") {
  if (!$("#change-panel").hidden && !window.confirm("Discard the unfinished draft and start a new group plan?")) return;
  controller.touchDraft();
  activeDraftId += 1;
  draftReturnRevision = null;
  setCreationMode(true);
  const members = [1, 2].map(() => ({ id: newId("member"), name: "", budgetMinor: null }));
  const draft = {
    ordinal: 1, revisionId: newId("revision"), createdAt: now(), note: "Initial group plan", policy: constants.POLICY,
    members,
    items: [{ id: newId("item"), label: "", unitMinor: Number.NaN, quantity: 1,
      weights: members.map(member => ({ memberId: member.id, units: 1 })) }]
  };
  $("#welcome").hidden = true;
  $("#workspace").hidden = false;
  $("#change-panel").hidden = false;
  $("#change-panel").dataset.token = JSON.stringify({ generation: controller.generation, session: controller.session });
  $("#draft-project-name").value = title.trim();
  $("#change-note").value = "Initial group plan";
  hideError(); renderDraft(draft);
  $("#draft-project-name").oninput = () => { controller.touchDraft(); preview(draft); };
  (title.trim() ? $("#member-editors").firstChild.children[0].children[0] : $("#draft-project-name")).focus();
  $("#change-panel").scrollIntoView({ block: "start" });
  announce("New group draft opened. Add your people and purchases. Limits can be supplied later; nothing has been recorded.");
}

function sampleRevision() {
  return {
    ordinal: 1, revisionId: newId("revision"), createdAt: now(), note: "Receiving example: tickets and shared coach", policy: constants.POLICY,
    members: [
      { id: "asha", name: "Asha", budgetMinor: 9000 },
      { id: "ben", name: "Ben", budgetMinor: 11000 },
      { id: "chen", name: "Chen", budgetMinor: 8000 }
    ],
    items: [
      { id: "tickets", label: "Event tickets", unitMinor: 4000, quantity: 4, weights: [{ memberId: "asha", units: 1 }, { memberId: "ben", units: 2 }, { memberId: "chen", units: 1 }] },
      { id: "coach", label: "Shared coach", unitMinor: 6000, quantity: 1, weights: [{ memberId: "asha", units: 1 }, { memberId: "ben", units: 1 }, { memberId: "chen", units: 1 }] }
    ]
  };
}

function createExample() {
  controller.replaceWithNew({ projectId: newId("project"), title: "Event group purchase", eventId: newId("event"), at: now(), revision: sampleRevision() });
  activeDraftId += 1; setCreationMode(false);
  $("#welcome").hidden = true; $("#workspace").hidden = false; $("#change-panel").hidden = true;
  render(); announce("Ticket example created. Revision 1 is ready to review.");
}

function render() {
  const sharedList=$("#hosted-plans");if(sharedList)sharedList.hidden=true;
  syncSharedPlan();
  clearResponsePreview();
  const state = controller.state;
  if (!state) return;
  const { current, evaluation } = state;
  $("#plan-title").textContent = state.project.title;
  $("#revision-label").textContent = "R" + current.ordinal;
  $("#revision-label").title = current.revisionId;
  $("#total-label").textContent = money(evaluation.totalMinor);
  $("#approval-label").textContent = `${state.approvals.length} of ${current.members.length}`;
  $("#agreement-status").textContent = evaluation.agreementRecorded
    ? "Everyone has agreed to their share."
    : !evaluation.feasible
      ? evaluation.members.filter(member => member.budgetStatus === "unknown" || member.overMinor > 0)
        .map(member => member.budgetStatus === "unknown"
          ? `${member.name}: limit not provided`
          : `${member.name}: ${money(member.overMinor)} over limit`).join(" · ")
      : `R${current.ordinal} · ${current.members.length - state.approvals.length} agreement${current.members.length-state.approvals.length===1?"":"s"} still to record`;
  $("#agreement-status").className = `agreement ${evaluation.agreementRecorded ? "ok" : evaluation.feasible ? "" : "bad"}`;
  renderRecipientOptions(state);
  renderSplit(state.evaluation, $("#group-split"));
  renderSharedReplies(state);
  renderMembers(state);
  renderItems(state);
  renderHistory(state);
  renderLatestChange(state);
  renderCheckout(state);
  renderScenarios();
  syncPaymentHistory(state);
  persistWorkspace();
}

function renderRecipientOptions(state) {
  const selector = $("#recipient-select");
  const previous = selector.value;
  selector.replaceChildren();
  const recipients=recipientMembers(state);
  for (const member of recipients) {
    const option = el("option", member.name + (member.removed ? " — earlier payments" : " — " + money(member.amountMinor)));
    option.value = member.id;
    selector.append(option);
  }
  selector.value = recipients.some(member => member.id === previous)
    ? previous : recipients[0]?.id ?? "";
}

const sharedOwners = new Map();
let sharedSync = Promise.resolve();
let sharedPublished = null;
function sharedOwner(projectId) {
  if(sharedOwners.has(projectId)) return sharedOwners.get(projectId);
  try { const token=sessionStorage.getItem("clearinghouse-owner:"+projectId); if(token)sharedOwners.set(projectId,token);return token; } catch { return null; }
}
async function sharedRequest(action,body,token) {
  const response=await fetch("/api/participation/"+action,{method:"POST",headers:{"Content-Type":"application/json",...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
  if ([502,503,504].includes(response.status)) {
    const error = new Error("The shared group service is unavailable.");
    error.sharedUnavailable = true;
    throw error;
  }
  const result=await response.json();if(!response.ok)throw new Error(result.message||"Could not update the shared plan.");return result;
}
async function openHostedPlan(id) {
  const importToken=controller.beginImport();
  $("#hosted-plans-status").hidden=false;$("#hosted-plans-status").textContent="Opening shared group…";
  try {
    const result=await sharedRequest("open",{id});
    const parsed=controller.parseImport(result.project);
    const confirmed=!hasWork() || window.confirm("Open this shared group? Unfinished edits in this tab will be replaced. Saved browser copies are kept.");
    if(!confirmed){$("#hosted-plans-status").textContent="Current work was kept.";return;}
    const outcome=controller.adoptImport(importToken,parsed,true);
    if(!outcome.adopted)return;
    // Keep any saved unfinished copy untouched; this is a separate hosted opening.
    recoveryStore?.release();recoveryEnabled=false;recoveryError="";
    activeDraftId+=1;currentDraft=null;draftReturnRevision=null;setCreationMode(false);
    sharedOwners.set(parsed.projectId,result.ownerToken);
    try{sessionStorage.setItem("clearinghouse-owner:"+parsed.projectId,result.ownerToken);}catch{}
    sharedPublished=result.project;
    clearSelectedInvitation();
    $("#welcome").hidden=true;$("#workspace").hidden=false;$("#change-panel").hidden=true;
    $("#hosted-plans").hidden=true;render();$("#plan-title").focus();
    announce("Shared group opened. Its recorded history and responses are retained.");
  }catch(error){$("#hosted-plans-status").textContent=error.message;}
}
let hostedPlans=[];
let hostedPlansView="active",hostedPlansRequest=0,hostedPlanChanging=null;
function renderHostedPlans() {
  const query=$("#find-hosted-plan").value.trim().toLocaleLowerCase();
  const words=query.split(/\s+/).filter(Boolean);
  const visible=hostedPlans.filter(plan=>(plan.archived===true)===(hostedPlansView==="archived"));
  const matches=visible.filter(plan=>{
    const text=[plan.title,...plan.members].join(" ").toLocaleLowerCase();
    return words.every(word=>text.includes(word));
  });
  const list=$("#hosted-plans-list");list.replaceChildren();
  for(const plan of matches){
    const row=el("li"),open=el("button");row.className="hosted-plan-row";open.className="hosted-plan-open";open.type="button";open.dataset.hostedPlan=plan.id;open.disabled=hostedPlanChanging!==null;
    const words=el("span");words.append(el("strong",plan.title),el("span","R"+plan.ordinal+" · "+plan.members.join(", "),"fine"));
    const amount=el("span",undefined,"hosted-plan-money");amount.append(el("strong",money(plan.totalMinor),"hosted-plan-amount"),el("span","Group total","fine"));
    open.append(words,amount);
    const archive=el("button",hostedPlanChanging===plan.id ? (plan.archived?"Restoring…":"Archiving…") : plan.archived?"Restore":"Archive","hosted-plan-archive");
    archive.type="button";archive.dataset.archivePlan=plan.id;archive.disabled=hostedPlanChanging!==null;
    archive.setAttribute("aria-label",(plan.archived?"Restore ":"Archive ")+plan.title);
    archive.addEventListener("click",()=>{void changeHostedPlanArchive(plan)});
    open.addEventListener("click",()=>{void openHostedPlan(plan.id)});row.append(open,archive);list.append(row);
  }
  $("#hosted-plan-views").hidden=hostedPlans.length===0;
  for(const view of ["active","archived"]){
    const button=$("#show-"+view+"-groups");
    button.setAttribute("aria-pressed",String(hostedPlansView===view));
    button.textContent=(view==="active"?"Active":"Archived")+" ("+hostedPlans.filter(plan=>(plan.archived===true)===(view==="archived")).length+")";
  }
  $("#hosted-plans-find").hidden=hostedPlans.length===0;
  $("#clear-hosted-plan-search").disabled=!$("#find-hosted-plan").value;
  const count=$("#hosted-plans-count");
  count.hidden=hostedPlans.length===0;
  count.textContent=query ? matches.length
    ? matches.length+" of "+visible.length+" "+hostedPlansView+" groups"
    : "No groups match. Try another name or clear your search."
    : visible.length ? visible.length+" "+hostedPlansView+" "+(visible.length===1?"group":"groups") : hostedPlansView==="archived" ? "No archived groups." : "No active groups. Open Archived to restore one.";
}
async function changeHostedPlanArchive(plan) {
  if(hostedPlanChanging!==null)return;
  const archived=!plan.archived;
  if(archived && !window.confirm("Archive "+plan.title+"? It will leave your active list. Its history and invitations stay available; payments are not cancelled."))return;
  ++hostedPlansRequest;hostedPlanChanging=plan.id;
  $("#refresh-hosted-plans").disabled=true;renderHostedPlans();
  const status=$("#hosted-plans-status");status.hidden=false;status.textContent=archived?"Archiving group…":"Restoring group…";
  try {
    const result=await sharedRequest("archive",{id:plan.id,archived});
    if(result.id!==plan.id || result.archived!==archived)throw new Error("The group list update could not be confirmed. Refresh before trying again.");
    hostedPlans=hostedPlans.map(item=>item.id===plan.id?{...item,archived}:item);
    status.textContent=plan.title+(archived?" was archived. Find it in Archived.":" is back in Active.");
  } catch(error) {status.textContent=error.message;}
  finally {
    hostedPlanChanging=null;$("#refresh-hosted-plans").disabled=false;renderHostedPlans();
    if(!$("#hosted-plans").hidden)$("#show-"+hostedPlansView+"-groups").focus({preventScroll:true});
  }
}
async function loadHostedPlans() {
  const panel=$("#hosted-plans"),button=$("#refresh-hosted-plans");
  panel.hidden=false;if(hostedPlanChanging!==null)return;const request=++hostedPlansRequest;button.disabled=true;
  $("#hosted-plans-status").hidden=false;$("#hosted-plans-status").textContent="Loading your shared groups…";
  try{
    const result=await sharedRequest("plans",{});
    if(request!==hostedPlansRequest)return;
    hostedPlans=result.plans;renderHostedPlans();
    document.body.dataset.hasSharedPlans=String(result.plans.length>0);
    $("#welcome-title").textContent=result.plans.length ? "Start another group" : "What are you buying together?";
    $("#hosted-plans-status").textContent=result.plans.length ? "" : "No shared groups yet. Invite someone from a plan to keep it here.";
    $("#hosted-plans-status").hidden=result.plans.length>0;
  }catch(error){if(request===hostedPlansRequest)$("#hosted-plans-status").textContent=error.message;}
  finally{if(request===hostedPlansRequest)button.disabled=false;}
}
function initializeHostedPlans(){
  if(document.body?.dataset?.hostedOrganizer!=="true")return;
  const button=el("button","Shared groups");button.id="open-hosted-plans";button.type="button";
  button.addEventListener("click",()=>{void loadHostedPlans();$("#hosted-plans").scrollIntoView({block:"start"});$("#hosted-plans-heading").focus();});
  $(".masthead").append(button);
  $("#refresh-hosted-plans").addEventListener("click",()=>{void loadHostedPlans()});
  for(const view of ["active","archived"])$("#show-"+view+"-groups").addEventListener("click",()=>{
    hostedPlansView=view;renderHostedPlans();
  });
  $("#find-hosted-plan").addEventListener("input",renderHostedPlans);
  $("#clear-hosted-plan-search").addEventListener("click",()=>{
    $("#find-hosted-plan").value="";renderHostedPlans();$("#find-hosted-plan").focus();
  });
  void loadHostedPlans();
}
function syncSharedPlan() {
  const state=controller.state;
  if(!state)return Promise.resolve();
  const projectId=state.project.projectId, token=sharedOwner(projectId), text=controller.exportText();
  if(!token || sharedPublished===text)return Promise.resolve();
  $("#shared-invitation").hidden=true;
  sharedSync=sharedSync.catch(()=>{}).then(async()=>{
    if(sharedPublished===text)return;
    await sharedRequest("publish",{project:text},token);
    sharedPublished=text;
  }).catch(error=>{$("#shared-status").textContent=error.message;throw error;});
  sharedSync.catch(()=>{});
  return sharedSync;
}
function clearSelectedInvitation() {
  $("#shared-invitation").hidden = true;
  $("#invitation-url").value = "";
  $("#invitation-copy-status").textContent = "";
  $("#shared-invitation").dataset.copyContext = "";
  $("#invitation-open").removeAttribute("href");
  $("#shared-status").textContent = "";
  clearOfflineDownload();
  $("#invitation-offline").hidden = true;
  $("#invitation-offline").dataset.context = "";
  $("#download-review").hidden = false;
  $("#share-review").textContent = "Create private invitation";
}
let offlineReviewUrl=null;
function clearOfflineDownload() {
  if(offlineReviewUrl)URL.revokeObjectURL(offlineReviewUrl);
  offlineReviewUrl=null;
  $("#offline-review").removeAttribute("href");
  $("#offline-review").removeAttribute("download");
}
$("#offline-review").addEventListener("click",event=>{
  const context=$("#invitation-offline").dataset.context,state=controller.state;
  if(!state || $("#invitation-offline").hidden || !offlineReviewUrl ||
      context!==JSON.stringify([controller.session,state.project.projectId,state.current.revisionId,$("#recipient-select").value])){
    event.preventDefault();
    clearSelectedInvitation();
    $("#shared-status").textContent="The proposal or person changed. Choose a participant and prepare a fresh review.";
    return;
  }
  $("#shared-status").textContent="Personal R"+state.current.ordinal+" review download requested. Send the HTML file only to "+$("#recipient-select").selectedOptions[0].textContent.split(" — ")[0]+". Open their returned response here.";
});
$("#copy-invitation").addEventListener("click", async () => {
  const host = $("#shared-invitation"), input = $("#invitation-url"), button = $("#copy-invitation");
  if (host.hidden || !input.value) return;
  const url = input.value, context = host.dataset.copyContext;
  const current = () => !host.hidden && input.value === url && host.dataset.copyContext === context;
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(url);
    if (current()) $("#invitation-copy-status").textContent = context + " copied. Send this link to that participant.";
  } catch {
    if (current()) {
      input.focus(); input.select();
      $("#invitation-copy-status").textContent = "Link selected. Copy it, then send it to that participant.";
    }
  } finally { button.disabled = false; }
});
$("#recipient-select").addEventListener("change", clearSelectedInvitation);
$("#share-review").addEventListener("click",async()=>{
  const button=$("#share-review"), state=controller.state;
  if(!state)return;
  const projectId=state.project.projectId, text=controller.exportText(), memberId=$("#recipient-select").value;
  button.disabled=true;
  $("#shared-invitation").hidden=true;
  $("#invitation-offline").hidden=true;
  $("#download-review").hidden=false;
  clearOfflineDownload();
  $("#shared-status").textContent="Creating invitation…";
  try {
    await syncSharedPlan();
    let token=sharedOwner(projectId);
    if(!token){
      token=(await sharedRequest("create",{project:text})).ownerToken;
      sharedOwners.set(projectId,token);
      try{sessionStorage.setItem("clearinghouse-owner:"+projectId,token);}catch{}
      persistWorkspace();
    }
    const result=await sharedRequest("publish",{project:text,memberId},token);
    if(controller.exportText()!==text)throw new Error("The plan changed. Create an invitation for the new revision.");
    if ($("#recipient-select").value !== memberId) return;
    sharedPublished=text;
    const url=new URL(result.path,location.origin).href;
    $("#invitation-url").value=url;$("#invitation-open").href=url;$("#shared-invitation").hidden=false;
    $("#shared-invitation").dataset.copyContext = "R" + result.ordinal + " invitation for " + result.memberName;
    $("#copy-invitation").setAttribute("aria-label", "Copy R" + result.ordinal + " invitation for " + result.memberName);
    $("#invitation-copy-status").textContent = "";
    $("#shared-status").textContent="Private review for "+result.memberName+" · R"+result.ordinal;
    renderSharedReplies(controller.state);
  }catch(error){
    const offline = error instanceof TypeError || error.sharedUnavailable === true;
    if (offline && controller.state && controller.exportText()===text && $("#recipient-select").value===memberId) {
      const panel=$("#invitation-offline");
      try {
        const latest=controller.state,packet=recipientPacket(latest,memberId),key=paymentContextKey(latest);
        const observation=paymentHistory.phase==="ready" && paymentHistoryKey===key
          ? {projectId,revisionId:latest.current.revisionId,checkedAt:paymentHistory.checkedAt,orders:paymentHistory.orders}
          : null;
        const context=personalPaymentContext(latest,memberId,observation);
        const payerHandoff=checkoutRequest?.key===projectId+":"+latest.current.revisionId+":"+latest.sequence &&
          checkoutRequest.prepared?.created?.some(row=>row.id===memberId)?{unavailable:true}:null;
        // Prepare a real download link from this exact recorded revision; it
        // needs no shared host, model, provider request or implicit approval.
        const file=personalReviewFile(packet,context,payerHandoff);
        offlineReviewUrl=file.url;
        $("#offline-review").href=file.url;
        $("#offline-review").download=file.name;
        $("#offline-review").textContent="Download "+packet.memberName+"'s review";
        $("#offline-review").setAttribute("aria-label","Download R"+packet.ordinal+" personal review for "+packet.memberName+". This does not send a response or payment.");
        panel.dataset.context=JSON.stringify([controller.session,projectId,latest.current.revisionId,memberId]);
        panel.hidden=false;
        $("#download-review").hidden=true;
        $("#shared-status").textContent="The shared invitation could not be created for this proposal.";
        $("#offline-review").focus({preventScroll:true});
      } catch(fallbackError) {
        clearOfflineDownload();
        $("#shared-status").textContent=fallbackError.message;
      }
    } else $("#shared-status").textContent=error.message;
  }
  finally{
    button.disabled=false;
    button.textContent=$("#invitation-offline").hidden?"Create private invitation":"Retry private link";
  }
});
let sharedReplyObservation={key:null,items:[],conflicts:[],checkedAt:null,phase:"idle"};
let sharedReplyAutoKey=null,sharedReplyRequest=0,selectedSharedReply=null;
let sharedReplyTimer=null;
function scheduleSharedResponses(delay=3000) {
  clearTimeout(sharedReplyTimer);
  const key=replyContext(),state=controller.state;
  if(document.visibilityState==="hidden" || !state || !sharedOwner(state.project.projectId))return;
  sharedReplyTimer=setTimeout(()=>{
    if(replyContext()===key && document.visibilityState!=="hidden")void refreshSharedResponses(true);
  },delay);
}
document.addEventListener("visibilitychange",()=>{
  clearTimeout(sharedReplyTimer);
  if(document.visibilityState!=="hidden")scheduleSharedResponses(0);
});
window.addEventListener("pagehide",()=>clearTimeout(sharedReplyTimer));
function replyContext(state=controller.state) {
  return state ? JSON.stringify([controller.session,state.project.projectId,state.current.revisionId]) : null;
}
function renderSharedReplies(state) {
  const key=replyContext(state),panel=$("#group-replies"),owned=Boolean(sharedOwner(state.project.projectId));
  panel.hidden=!owned;
  if(sharedReplyObservation.key!==key)sharedReplyObservation={key,items:[],conflicts:[],checkedAt:null,phase:"idle"};
  const observation=sharedReplyObservation,host=$("#shared-responses");
  host.replaceChildren();
  $("#refresh-responses").disabled=observation.phase==="loading";
  if(!owned)return;
  for(const item of observation.items){
    const row=el("button",item.parsed.packet.memberName+" · "+({"agree":"Agrees","decline":"Needs changes","propose-limit":"Proposes a limit","propose-exclusions":"Requests item changes","propose-changes":"Proposes limit and item changes"}[item.parsed.response.answer]));
    row.type="button";row.addEventListener("click",()=>openResponseFile({text:async()=>item.text},true));host.append(row);
  }
  for(const conflict of observation.conflicts)host.append(el("p",conflict.memberName+" · Needs a fresh response","caution"));
  const count=observation.items.length,total=state.current.members.length;
  const known=observation.checkedAt ? count+" of "+total+" replied to R"+state.current.ordinal : "Replies have not been checked.";
  const needs=observation.conflicts.length ? " · "+observation.conflicts.length+" need a fresh response" : "";
  const pending=observation.phase==="loading" ? " · Checking…" : "";
  const failed=observation.phase==="error" ? (observation.checkedAt ? " · Could not refresh. These are the last checked replies." : " Could not check replies. Try again.") : "";
  $("#group-reply-status").textContent=known+needs+pending+failed;
  if(sharedReplyAutoKey!==key){
    sharedReplyAutoKey=key;
    queueMicrotask(()=>{if(replyContext()===key)void refreshSharedResponses();});
  }
}
async function refreshSharedResponses(background=false) {
  clearTimeout(sharedReplyTimer);
  const state=controller.state;if(!state)return;
  const token=sharedOwner(state.project.projectId),text=controller.exportText(),key=replyContext(state);
  if(!token){$("#shared-status").textContent="Create an invitation first.";return;}
  if(background && (sharedReplyObservation.phase==="loading" || sharedPublished!==text)){
    scheduleSharedResponses();return;
  }
  const request=++sharedReplyRequest;
  let changed=false;
  if(sharedReplyObservation.key!==key)sharedReplyObservation={key,items:[],conflicts:[],checkedAt:null,phase:"idle"};
  if(!background){sharedReplyObservation.phase="loading";renderSharedReplies(state);}
  try{
    if(!background)await syncSharedPlan();
    const result=await sharedRequest("responses",{},token);
    if(replyContext()!==key || request!==sharedReplyRequest)return;
    if(controller.exportText()!==text)throw new Error("The plan changed. Check its responses again.");
    if(result.ordinal!==state.current.ordinal)throw new Error("The shared plan changed. Open its current group before using these replies.");
    const items=result.responses.map(item=>({...item,parsed:parseParticipantResponse(controller.state,item.text)}));
    changed=JSON.stringify([items.map(item=>item.text),result.conflicts||[]])!==JSON.stringify([sharedReplyObservation.items.map(item=>item.text),sharedReplyObservation.conflicts]) || sharedReplyObservation.phase!=="ready";
    sharedReplyObservation={key,items,conflicts:result.conflicts||[],checkedAt:now(),phase:"ready"};
    if(selectedSharedReply?.key===key && !items.some(item=>item.parsed.response.memberId===selectedSharedReply.memberId && item.text===selectedSharedReply.text)){
      const memberId=selectedSharedReply.memberId,name=selectedSharedReply.name;
      clearResponsePreview();
      const preview=$("#response-preview");preview.hidden=false;
      preview.append(el("p",name+"'s reply changed. Read the current answer before using it.","caution"));
      const latest=items.find(item=>item.parsed.response.memberId===memberId);
      if(latest){
        const read=el("button","Read current reply");read.type="button";read.id="read-current-reply";
        read.addEventListener("click",()=>{
          if(replyContext()!==key)return;
          const current=sharedReplyObservation.items.find(item=>item.parsed.response.memberId===memberId);
          if(current)void openResponseFile({text:async()=>current.text},true);
        });
        preview.append(read);
      } else preview.append(el("p","A current answer is not available. Ask for a fresh reply.","fine"));
    }
    $("#shared-status").textContent=(result.responses.length?result.responses.length+" response"+(result.responses.length===1?"":"s")+" to R"+result.ordinal:"Waiting for responses to R"+result.ordinal)+
      ((result.conflicts||[]).length?" · Earlier replies conflict; ask for a fresh response.":"");
  }catch(error){
    if(replyContext()!==key || request!==sharedReplyRequest)return;
    changed=sharedReplyObservation.phase!=="error";
    sharedReplyObservation.phase="error";$("#shared-status").textContent=error.message;
  }finally{
    if(replyContext()===key && request===sharedReplyRequest){
      if(!background || changed)renderSharedReplies(controller.state);
      scheduleSharedResponses(sharedReplyObservation.phase==="error"?15000:3000);
    }
  }
}
$("#refresh-responses").addEventListener("click",()=>{void refreshSharedResponses()});

function personalReviewFile(packet,paymentContext,payerHandoff) {
  const blob=new Blob([participantReviewHtml(packet,{paymentContext,payerHandoff})],{type:"text/html;charset=utf-8"});
  return {url:URL.createObjectURL(blob),
    name:"clearinghouse-"+packet.projectId+"-r"+packet.ordinal+"-"+packet.memberId+"-review.html"};
}
function savePersonalReview(packet,paymentContext,payerHandoff) {
  const file=personalReviewFile(packet,paymentContext,payerHandoff);
  const link=document.createElement("a");
  link.href=file.url;
  link.download=file.name;
  try {link.click();announce("Private review download requested for "+packet.memberName+". Share it only with the intended participant.");}
  finally {setTimeout(()=>URL.revokeObjectURL(file.url),1000);}
}

async function downloadParticipantReview() {
  const button = $("#download-review");
  if (button.disabled) return;
  const initial = controller.state;
  if (!initial) return;
  const memberId = $("#recipient-select").value;
  const key = paymentContextKey(initial), session = controller.session;
  const originalLabel = button.textContent;
  button.disabled = true; button.textContent = "Checking earlier payments…";
  try {
    await refreshPaymentHistory(initial);
    if (controller.session !== session || !controller.state || paymentContextKey(controller.state) !== key) {
      throw new Error("The plan changed while preparing this review. Download a fresh review for the current proposal.");
    }
    const packet = recipientPacket(controller.state, memberId);
    const observation = paymentHistory.phase === "ready" && paymentHistoryKey === key
      ? {projectId:initial.project.projectId, revisionId:initial.current.revisionId, checkedAt:paymentHistory.checkedAt, orders:paymentHistory.orders}
      : null;
    let personalPosition=null;
    if(packet.removed||netReview?.paymentPlanAccepted){
      try{
        const response=await fetch("/api/paypal-sandbox/settlement",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:controller.exportText()})});
        const result=await response.json(),net=result.settlement;
        if(!controller.state||paymentContextKey(controller.state)!==key)throw Error("The plan changed. Download its current review.");
        if(response.ok&&result.ok)personalPosition={projectId:net.projectId,revisionId:net.revisionId,checkedAt:net.checkedAt,
          paymentPlanCurrent:net.paymentPlanCurrent,member:net.members.find(row=>row.memberId===memberId)};
      }catch(error){if(!controller.state||paymentContextKey(controller.state)!==key)throw error;}
    }
    const paymentContext = personalPaymentContext(controller.state, memberId, observation,personalPosition);
    let payerHandoff;
    if (!packet.removed && checkoutRequest?.key === initial.project.projectId + ":" + initial.current.revisionId + ":" + initial.sequence && checkoutRequest.prepared?.created?.some(row=>row.id===memberId)) {
      payerHandoff = {unavailable:true};
      try {
        const response = await fetch("/api/paypal-sandbox/status", {
          method:"POST",headers:{"Content-Type":"application/json"},
          body:JSON.stringify({project:controller.exportText(),memberId})
        });
        const result = await response.json();
        if (controller.session !== session || !controller.state || paymentContextKey(controller.state) !== key) {
          throw new Error("The plan changed while checking the payer link. Download a fresh review.");
        }
        if (response.ok && result.ok) payerHandoff = personalPayerHandoff(controller.state,memberId,checkoutRequest?.prepared,result.order) || {unavailable:true};
      } catch (error) {
        if (controller.session !== session || !controller.state || paymentContextKey(controller.state) !== key) throw error;
      }
    }
    savePersonalReview(packet,paymentContext,payerHandoff);
  } catch (error) { window.alert(error.message); announce(error.message); }
  finally { button.disabled = false; button.textContent = originalLabel; }
}


function personColor(id) { return participantColors({revisions:controller.state?.revisions ?? [], current:currentDraft ?? controller.state?.current}).get(id) ?? "#ff786e"; }
function renderSplit(evaluation, host) {
  if (!host) return;
  host.replaceChildren();
  const bar = el("div", undefined, "split-bar");
  bar.setAttribute("aria-hidden", "true");
  const people = el("div", undefined, "split-people");
  for (const member of evaluation.members) {
    const color = personColor(member.id);
    const segment = el("div", undefined, "split-segment");
    if (segment.style) { segment.style.setProperty("--person",color); segment.style.flexGrow = member.amountMinor; }
    segment.title = member.name + " " + money(member.amountMinor);
    bar.append(segment);
    const chip = el(host.id === "group-split" ? "button" : "div", undefined, "person-chip");
    if (host.id === "group-split") {
      chip.type = "button";
      chip.setAttribute("aria-label", "Review " + member.name + ", " + money(member.amountMinor));
      chip.addEventListener("click", () => {
        if ($("#recipient-select").value !== member.id) {
          $("#recipient-select").value = member.id;
          clearSelectedInvitation();
        }
        const details = document.querySelector(".people-details");
        if (details) details.open = true;
        const row = document.querySelector('[data-member-row="' + CSS.escape(member.id) + '"]');
        if (row) {
          row.dataset.expanded = "true";
          expandedMemberDetails.add(member.id);
          row.querySelector(".member-disclosure")?.setAttribute("aria-expanded", "true");
          row.scrollIntoView({block:"center"});
          row.querySelector("[data-member-action]")?.focus();
        }
      });
    }
    if (chip.style) chip.style.setProperty("--person",color);
    const avatar = el("span", member.name.slice(0,1).toUpperCase(), "person-avatar");
    avatar.setAttribute("aria-hidden", "true");
    if (member.approved) { const checked = el("span", "✓", "person-state"); checked.setAttribute("aria-label", "Approval recorded"); avatar.append(checked); }
    const label = el("span", member.name, "person-label");
    label.append(el("strong", money(member.amountMinor)));
    chip.append(avatar, label);
    people.append(chip);
  }
  host.append(bar, people);
}

const expandedMemberDetails = new Set();
let memberDetailsContext = null;
function renderMembers(state) {
  const colors = participantColors(state);
  const body = $("#member-results");
  const context = `${controller.session}:${state.current.revisionId}`;
  if (memberDetailsContext !== context) { expandedMemberDetails.clear(); memberDetailsContext = context; }
  body.replaceChildren();
  const actionToken = controller.captureAction();
  for (const member of state.evaluation.members) {
    const row = document.createElement("tr");
    row.dataset.memberRow = member.id;
    row.dataset.participantColor = colors.get(member.id);
    if (row.style) { row.style.setProperty("--person", colors.get(member.id)); row.style.setProperty("--participant-color", colors.get(member.id)); }
    row.dataset.expanded = String(expandedMemberDetails.has(member.id));
    const name = el("th"); name.scope = "row";
    name.append(el("span", member.name, "member-name-desktop"));
    const disclosure = el("button", member.name, "member-disclosure");
    if (member.approved) disclosure.append(el("small", "Declared", "member-declared"));
    disclosure.type = "button";
    disclosure.setAttribute("aria-expanded", row.dataset.expanded);
    disclosure.setAttribute("aria-controls", `declaration-${member.id} declaration-action-${member.id}`);
    disclosure.setAttribute("aria-label", `Review declaration for ${member.name}`);
    disclosure.addEventListener("click", () => {
      row.dataset.expanded = String(row.dataset.expanded !== "true");
      disclosure.setAttribute("aria-expanded", row.dataset.expanded);
      if (row.dataset.expanded === "true") expandedMemberDetails.add(member.id);
      else expandedMemberDetails.delete(member.id);
    });
    name.append(disclosure); row.append(name);
    row.append(el("td", money(member.amountMinor)));
    row.append(el("td", limitLabel(member.budgetMinor)));
    const budget = el("td", member.budgetStatus === "unknown" ? "Needs a stated limit" : member.overMinor ? `Over by ${money(member.overMinor)}` : "Within limit", member.budgetStatus === "unknown" ? "pending" : member.overMinor ? "bad" : "ok");
    row.append(budget);
    const declaration = el("td", member.approved ? `Recorded for R${state.current.ordinal}` : "Not recorded");
    declaration.id = `declaration-${member.id}`;
    row.append(declaration);
    const action = document.createElement("td");
    action.id = `declaration-action-${member.id}`;
    const button = el("button", member.approved ? "Withdraw recorded approval" : "Record declared approval");
    button.type = "button";
    button.dataset.memberAction = member.id;
    button.disabled = !member.approved && !state.evaluation.feasible;
    button.setAttribute("aria-label", `${button.textContent} attributed to ${member.name} for revision ${state.current.ordinal}, amount ${money(member.amountMinor)}`);
    button.addEventListener("click", () => {
      try {
        const event = { eventId: newId("event"), at: now(), memberId: member.id };
        if (member.approved) controller.withdraw(actionToken, event); else controller.approve(actionToken, event);
        render(); document.querySelector(`[data-member-action="${CSS.escape(member.id)}"]`)?.focus(); announce(`${member.approved ? "Withdrawal" : "Approval declaration"} recorded for ${member.name}.`);
      } catch (error) { announce(error.message); window.alert(error.message); }
    });
    action.append(button); row.append(action); body.append(row);
  }
}

function renderItems(state) {
  const host = $("#item-explanations"); host.replaceChildren();
  for (const result of state.evaluation.items) {
    const item = state.current.items.find(candidate => candidate.id === result.itemId);
    const block = el("section"); block.className = "editor-card";
    block.append(el("h3", `${item.label}: ${item.quantity} × ${money(item.unitMinor)} = ${money(result.totalMinor)}`));
    const list = el("ul");
    for (const allocation of result.allocations) {
      const member = state.current.members.find(candidate => candidate.id === allocation.memberId);
      const weight = item.weights.find(candidate => candidate.memberId === allocation.memberId).units;
      list.append(el("li", `${member.name}: ${money(allocation.minor)} (weight ${weight})`));
    }
    block.append(list); host.append(block);
  }
}

function renderHistory(state) {
  const list = $("#history-list"); list.replaceChildren();
  for (const event of state.project.events) {
    let summary;
    if (event.type === "created") summary = `Created R${event.revision.ordinal}: ${event.revision.note}`;
    else if (event.type === "amended") summary = `Created R${event.revision.ordinal}; every earlier approval became historical: ${event.revision.note}`;
    else {
      const verb = event.type === "approved" ? "Recorded declared approval" : "Withdrew recorded approval";
      summary = `${verb} for ${event.memberId} on ${event.revisionId}`;
    }

    const person = state.current.members.find(member => member.id === event.memberId);
    if (person) summary = event.type === "approved" ? person.name + " · approval recorded" : person.name + " · approval withdrawn";
    const entry = el("li", undefined, "timeline-entry");
    if (entry.style) entry.style.setProperty("--person",person ? personColor(person.id) : "#a8a8b4");
    const time = el("time", new Date(event.at).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}));
    time.dateTime = event.at;
    entry.append(el("span", person ? person.name.slice(0,1) : "↗", "timeline-avatar"), el("strong", summary), time);

    if ((event.type === "created" || event.type === "amended") && event.revision.ordinal < state.current.ordinal) {
      const reuse = el("button", `Draft from R${event.revision.ordinal}`);
      reuse.type = "button";
      reuse.dataset.reuseRevision = String(event.revision.ordinal);
      reuse.setAttribute("aria-label", `Reuse recorded revision ${event.revision.ordinal} inputs in a new draft; history and approvals stay unchanged until you create the revision`);
      reuse.addEventListener("click", () => startDraft(event.revision));
      entry.append(el("span", " "), reuse);
    }
    list.append(entry);
  }
}

function renderLatestChange(state) {
  if (comparisonWorkspaceSession !== controller.session) {
    comparisonWorkspaceSession = controller.session;
    comparisonFromOrdinal = null;
    comparisonExplicit = false;
  }
  const panel = $("#latest-change-panel");
  const selector = $("#compare-from-revision");
  const earlier = state.revisions.slice(0, -1);
  panel.hidden = earlier.length === 0;
  selector.replaceChildren();
  if (!earlier.length) {
    $("#latest-change-members").replaceChildren();
    $("#latest-change-items").replaceChildren();
    return;
  }
  if (!comparisonExplicit || !earlier.some(revision => revision.ordinal === comparisonFromOrdinal))
    comparisonFromOrdinal = earlier.at(-1).ordinal;
  for (const revision of earlier) {
    const option = el("option", `R${revision.ordinal} · ${revision.note}`);
    option.value = String(revision.ordinal);
    selector.append(option);
  }
  selector.value = String(comparisonFromOrdinal);
  const brief = changeBriefAgainstRevision(state, comparisonFromOrdinal);
  $("#latest-change-heading").textContent = `R${brief.before.ordinal} → R${brief.after.ordinal}: ${brief.after.note}`;
  $("#latest-change-summary").textContent =
    `Previous total ${money(brief.before.totalMinor)} → current ${money(brief.after.totalMinor)} (${brief.deltaMinor > 0 ? "+" : ""}${money(brief.deltaMinor)}). ${brief.retiredActiveDeclarations} declaration(s) recorded on R${brief.before.ordinal} are historical, not transferred to R${brief.after.ordinal}. ${brief.currentDeclarations} of ${brief.requiredDeclarations} new declarations recorded. ${brief.feasible ? "Within declared budgets." : brief.budgetsKnown === false ? "Spending limits still need confirmation." : "Blocked by declared budgets."}`;
  const memberList = $("#latest-change-members"); memberList.replaceChildren();
  for (const member of brief.members) {
    const li = el("li", `${member.name} (${member.transition}): ${money(member.previousMinor)} → ${money(member.currentMinor)} (${member.deltaMinor > 0 ? "+" : ""}${money(member.deltaMinor)}); ${member.currentStatus}${member.limitChanged ? "; budget limit changed" : ""}${member.renamed ? `; formerly ${member.previousName}` : ""}`);
    memberList.append(li);
  }
  const itemList = $("#latest-change-items"); itemList.replaceChildren();
  for (const item of brief.items) itemList.append(el("li", `${item.label}: ${item.status}; ${money(item.previousMinor)} → ${money(item.currentMinor)}; ${item.differences.join(", ") || "no item-input change"}`));
}

function inputField(labelText, value, options = {}) {
  const label = el("label", labelText);
  const input = document.createElement("input");
  input.value = value; Object.assign(input, options); label.append(input);
  return { label, input };
}

function startDraft(fromRevision = null) {
  const state = controller.state;
  if (!state) return;
  const origin = fromRevision ? state.revisions.find(revision =>
    revision.ordinal === fromRevision.ordinal &&
    revision.revisionId === fromRevision.revisionId &&
    JSON.stringify(revision) === JSON.stringify(fromRevision)) : null;
  if (fromRevision && (!origin || origin.ordinal >= state.current.ordinal)) {
    announce("That previous revision is not in this workspace. Nothing was changed.");
    return;
  }
  if (!$("#change-panel").hidden) {
    if (!window.confirm("Discard the current unsaved draft and start again from the recorded proposal?")) {
      $("#change-panel input")?.focus();
      announce("Current draft kept.");
      return;
    }
  }
  const token = controller.captureAction();
  controller.touchDraft();
  activeDraftId += 1; setCreationMode(false);
  draftReturnRevision = origin?.ordinal ?? null;
  const draft = structuredClone(origin ?? state.current);
  $("#change-panel").hidden = false;
  $("#draft-base").textContent = origin
    ? `current R${state.current.ordinal}; reusing R${origin.ordinal} inputs (fresh declarations required)`
    : `R${state.current.ordinal}`;
  $("#change-panel").dataset.token = JSON.stringify(token);
  $("#change-note").value = origin ? `Revisiting R${origin.ordinal} inputs` : "Updated group plan";
  renderDraft(draft);
  $("#change-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#change-note").focus();
}

function renderScenarios(draft = null) {
  const section = $("#scenario-comparison");
  const controls = $("#scenario-pin-controls");
  controls.hidden = !draft || creatingPlan;
  if (!controller.state) { section.hidden = true; return; }
  const token = controller.captureAction();
  const entries = scenarios.list(token);
  controls.open = entries.length === 0;
  section.hidden = creatingPlan || (!draft && !entries.length);
  const host = $("#scenario-table");
  host.replaceChildren();
  $("#pin-scenario").onclick = () => {
    try {
      const base = JSON.parse($("#change-panel").dataset.token);
      if (JSON.stringify(base) !== JSON.stringify(controller.captureAction()))
        throw new Error("The recorded agreement changed while you edited. Reopen a draft before keeping this option.");
      mobileScenarioId = scenarios.pin($("#scenario-name").value, draft, token);
      $("#scenario-name").value = "";
      renderScenarios(draft);
      persistWorkspace();
      announce("Option kept for comparison. No revision, approval or payment was created.");
      $("#scenario-heading").focus({preventScroll:true});
      section.scrollIntoView({block:"start"});
    } catch (error) { showError(error.message); }
  };
  if (!entries.length) {
    host.append(el("p", "Keep a draft here, change the purchase or its split, then keep another to compare."));
    return;
  }
  const comparison = compareScenarios(controller.state.current, entries);
  const picker = el("label", "Option", "scenario-picker");
  const select = el("select"); select.setAttribute("aria-label", "Option to compare");
  if (!entries.some(entry => entry.id === mobileScenarioId)) mobileScenarioId = entries.at(-1).id;
  for (const entry of entries) { const option = el("option", entry.name); option.value = entry.id; select.append(option); }
  select.value = mobileScenarioId;
  select.addEventListener("change", () => { mobileScenarioId = Number(select.value); renderScenarios(draft); $("#scenario-table select").focus(); });
  picker.append(select); host.append(picker);
  const table = el("table");
  table.style.setProperty("--scenario-width", (entries.length + 2) * 180 + "px");
  const caption = el("caption", "USD · change from recorded R" + controller.state.current.ordinal);
  const head = el("thead"); const heading = el("tr");
  heading.append(el("th", "Person / purchase"), el("th", "Recorded R" + controller.state.current.ordinal));
  for (const entry of entries) {
    const th = el("th", entry.name); th.scope = "col";
    if (entry.stale) th.append(el("span", "Agreement changed — reference only", "scenario-warning"));
    const edit = el("button", "Edit this option"); edit.type = "button"; edit.disabled = entry.stale;
    edit.dataset.scenarioEdit = entry.id;
    edit.addEventListener("click", () => {
      try {
        const next = scenarios.copy(entry.id, controller.captureAction());
        if (!$("#change-panel").hidden && !window.confirm("Replace the current unsaved draft with this kept option?")) return;
        activeDraftId += 1; setCreationMode(false); controller.touchDraft();
        $("#change-panel").hidden = false;
        $("#change-panel").dataset.token = JSON.stringify(controller.captureAction());
        $("#draft-base").textContent = "R" + controller.state.current.ordinal;
        $("#change-note").value = entry.name;
        draftReturnRevision = null;
        renderDraft(next);
        $("#change-panel").scrollIntoView({block:"start"});
        $("#change-note").focus();
        announce("Option copied into the editable draft. Review and create a revision separately.");
      } catch (error) { showError(error.message); }
    });
    const remove = el("button", "Remove"); remove.type = "button"; remove.dataset.scenarioRemove = entry.id;
    remove.setAttribute("aria-label", "Remove option " + entry.name);
    remove.addEventListener("click", () => { scenarios.remove(entry.id); renderScenarios(draft); persistWorkspace(); announce("Option removed."); });
    const actions = el("details", undefined, "scenario-option-actions");
    actions.dataset.scenarioActions = entry.id;
    actions.append(el("summary", "Actions"), edit, remove);
    th.append(actions); heading.append(th);
  }
  head.append(heading);
  const body = el("tbody");
  const total = el("tr"); const totalLabel = el("th", "Total"); totalLabel.scope = "row"; total.append(totalLabel);
  for (const value of comparison.totals) total.append(el("td", money(value)));
  body.append(total);
  const colors = participantColors({revisions:[...controller.state.revisions, controller.state.current, ...entries.map(entry=>entry.revision)]});
  for (const person of comparison.people) {
    const row = el("tr"); row.dataset.scenarioPerson = person.id;
    if(row.style)row.style.setProperty("--person", colors.get(person.id));
    const label = el("th", person.name); label.scope = "row"; row.append(label);
    person.values.forEach((value, index) => {
      const cell = el("td", value.present ? money(value.amountMinor) : "Not included");
      if (index) cell.append(el("span", (value.deltaMinor >= 0 ? "+" : "") + money(value.deltaMinor) + " vs recorded", "scenario-detail"));
      if (value.present && value.name !== person.name) cell.append(el("span", "Named " + value.name, "scenario-detail"));
      if (value.overMinor) cell.append(el("strong", "Over limit by " + money(value.overMinor), "scenario-warning"));
      else if (value.present) cell.append(el("span", value.budgetMinor === null ? "Limit not provided" : "Limit " + money(value.budgetMinor), "scenario-detail"));
      row.append(cell);
    }); body.append(row);
  }
  const purchases = el("tr"); purchases.append(el("th", "Items"));
  for (const revision of [controller.state.current, ...entries.map(entry => entry.revision)]) {
    const cell = el("td");
    for (const item of revision.items) cell.append(el("div", item.label + " × " + item.quantity + " · " + money(item.unitMinor * item.quantity), "scenario-detail"));
    purchases.append(cell);
  }
  body.append(purchases); table.append(caption, head, body);
  const selectedColumn = entries.findIndex(entry => entry.id === mobileScenarioId) + 2;
  for (const row of [heading, ...body.children]) [...row.children].forEach((cell,index) => {
    if (index > 1 && index !== selectedColumn) cell.classList.add("scenario-other");
  });
  host.append(table);
}

function showCopiedDraft() {
  const status = $("#draft-copy-status");
  status.textContent = "Split updated in your draft. Review the amounts below.";
  status.hidden = false;
  $("#preview-title").focus({preventScroll:true});
  $("#change-preview").scrollIntoView({block:"start"});
  announce("Split updated in your draft. Review the amounts before creating the next revision.");
}

let draftAmountChecks = [];
function addDraftAmountFeedback(field, host, label, { unknown = () => false, empty = "" } = {}) {
  const note = el("p", "", "amount-input-error bad");
  note.id = "amount-error-" + field.input.dataset.recoveryKey;
  note.hidden = true;
  field.input.setAttribute("aria-describedby", note.id);
  host.append(note);
  draftAmountChecks.push(() => {
    const value = field.input.value.trim();
    const minor = usdInputToMinor(value);
    const message = unknown() ? "" : !value ? empty
      : Number.isSafeInteger(minor) && minor >= 0 ? ""
      : "Enter a valid dollar amount with no more than two decimal places.";
    note.textContent = message;
    note.hidden = !message;
    field.input.setAttribute("aria-invalid", message ? "true" : "false");
    return message ? label() + ": " + message : "";
  });
}

function renderDraft(draft) {
  const sharedList=$("#hosted-plans");if(sharedList)sharedList.hidden=true;
  currentDraft = draft;
  draftAmountChecks = [];
  renderScenarios(draft);
  const memberHost = $("#member-editors"); const itemHost = $("#item-editors");
  const weightCaptions = new Map(draft.members.map(member => [member.id, []]));
  memberHost.replaceChildren(); itemHost.replaceChildren();
  for (const member of draft.members) {
    const card = el("div"); card.className = "editor-card editor-grid"; card.dataset.memberId = member.id;
    if (card.style) card.style.setProperty("--person", personColor(member.id));
    const name = inputField("Display name", member.name, { maxLength: 200, required: true });
    const budget = inputField("Limit (USD)", minorToUsdInput(member.budgetMinor), { inputMode: "decimal", required: member.budgetMinor !== null, placeholder: "60.00" });
    const unknownLabel = el("label", undefined, "budget-unknown");
    const unknown = el("input");
    unknown.type = "checkbox"; unknown.checked = member.budgetMinor === null;
    unknown.dataset.recoveryKey = "member:" + member.id + ":unknown";
    unknown.setAttribute("aria-label", "Spending limit not provided for " + (member.name || "this person"));
    unknownLabel.append(unknown, el("span", "Limit not provided"));
    budget.input.placeholder = unknown.checked ? "Add limit" : "60.00";
    unknown.addEventListener("change", () => {
      budget.input.required = !unknown.checked;
      budget.input.placeholder = unknown.checked ? "Add limit" : "60.00";
      if (unknown.checked) budget.input.value = "";
      member.budgetMinor = unknown.checked ? null : usdInputToMinor(budget.input.value);
      controller.touchDraft(); preview(draft);
      if (!unknown.checked) budget.input.focus();
    });
    name.input.dataset.recoveryKey = "member:" + member.id + ":name";
    budget.input.dataset.recoveryKey = "member:" + member.id + ":budget";
    card.append(name.label, budget.label);
    const identity = el("span", "", "editor-space"); card.append(identity);
    const remove = el("button", creatingPlan ? "Remove" : "Remove from next proposal", "danger"); remove.type = "button";
    remove.setAttribute("aria-label", "Remove " + (member.name || "this person") + (creatingPlan ? " from this draft" : " from the next proposal"));
    remove.addEventListener("click", () => {
      if (draft.members.length === 1) return showError("At least one participant is required in this release.");
      const index = draft.members.findIndex(candidate => candidate.id === member.id);
      draft.members = draft.members.filter(candidate => candidate.id !== member.id);
      for (const item of draft.items) item.weights = item.weights.filter(weight => weight.memberId !== member.id);
      controller.touchDraft();
      renderDraft(draft);
      const next = draft.members[Math.min(index, draft.members.length - 1)];
      document.querySelector(`[data-member-id="${CSS.escape(next.id)}"] input`)?.focus();
    });
    card.append(remove, unknownLabel);
    addDraftAmountFeedback(budget, card, () => (member.name || "This person") + "’s spending limit", { unknown: () => unknown.checked, empty: "Enter a limit, or choose Limit not provided." });
    name.input.addEventListener("input", () => {
      member.name = name.input.value;
      unknown.setAttribute("aria-label", "Spending limit not provided for " + (member.name || "this person"));
      remove.setAttribute("aria-label", "Remove " + (member.name || "this person") + (creatingPlan ? " from this draft" : " from the next proposal"));
      updateWeightLabelText(weightCaptions.get(member.id), member.name);
      controller.touchDraft();
      preview(draft);
    });
    budget.input.addEventListener("input", () => {
      unknown.checked = false; budget.input.required = true; budget.input.placeholder = "60.00";
      member.budgetMinor = usdInputToMinor(budget.input.value);
      controller.touchDraft(); preview(draft);
    });
    memberHost.append(card);
  }
  for (const item of draft.items) {
    const card = el("div"); card.className = "editor-card"; card.dataset.itemId = item.id;
    const grid = el("div"); grid.className = "editor-grid";
    const label = inputField("Item", item.label, { maxLength: 200, required: true });
    const unit = inputField("Unit price (USD)", minorToUsdInput(item.unitMinor), { inputMode: "decimal", required: true, placeholder: "27.50" });
    const quantity = inputField("Quantity", item.quantity, { type: "number", min: "1", step: "1", required: true });
    label.input.dataset.recoveryKey = "item:" + item.id + ":label";
    unit.input.dataset.recoveryKey = "item:" + item.id + ":unit";
    quantity.input.dataset.recoveryKey = "item:" + item.id + ":quantity";
    const remove = el("button", "Remove item", "danger"); remove.type = "button";
    grid.append(label.label, unit.label, quantity.label, remove); card.append(grid);
    const weights = el("div"); weights.className = "weight-grid";
    for (const member of draft.members) {
      let weight = item.weights.find(candidate => candidate.memberId === member.id);
      if (!weight) { weight = { memberId: member.id, units: 0 }; item.weights.push(weight); }
      const field = inputField(`${member.name} shares`, weight.units, { type: "number", min: "0", step: "1", required: true });
      field.label.className = "person-weight";
      if (field.label.style) field.label.style.setProperty("--person", personColor(member.id));
      field.input.dataset.recoveryKey = "item:" + item.id + ":weight:" + member.id;
      weightCaptions.get(member.id).push(field.label.firstChild);
      field.input.addEventListener("input", () => { weight.units = strictNumber(field.input.value); controller.touchDraft(); preview(draft); });
      const amount = el("span", "", "item-share-amount");
      amount.dataset.shareAmount = member.id;
      field.label.append(amount);
      weights.append(field.label);
    }
    if (creatingPlan) {
      const amounts = el("ul", undefined, "creation-share-amounts");
      for (const member of draft.members) {
        const row = el("li"); row.dataset.creationShare = member.id;
        row.style?.setProperty("--person", personColor(member.id));
        row.append(el("span", member.name || "Person", "creation-share-name"));
        const amount = el("strong"); amount.dataset.shareAmount = member.id;
        row.append(amount); amounts.append(row);
      }
      const choices = el("details", undefined, "creation-sharing");
      const summary = el("summary"); summary.dataset.sharingSummary = "";
      choices.open = !item.weights.every(weight => Number.isSafeInteger(weight.units) && weight.units > 0 && weight.units === item.weights[0].units);
      choices.append(summary, el("p", "Use 1 share each for an equal split, 2 for twice as much, or 0 when someone is not included.", "fine"), weights);
      card.append(amounts, choices);
    } else card.append(weights);
    const allocationStatus = el("p", "", "item-allocation-status fine");
    allocationStatus.dataset.itemAllocationStatus = "";
    card.append(allocationStatus);
    addDraftAmountFeedback(unit, card, () => (item.label || "This purchase") + " unit price");
    label.input.addEventListener("input", () => { item.label = label.input.value; controller.touchDraft(); preview(draft); });
    unit.input.addEventListener("input", () => { item.unitMinor = usdInputToMinor(unit.input.value); controller.touchDraft(); preview(draft); });
    quantity.input.addEventListener("input", () => { item.quantity = strictNumber(quantity.input.value); controller.touchDraft(); preview(draft); });
    remove.addEventListener("click", () => {
      if (draft.items.length === 1) return showError("At least one item is required in this release.");
      const index = draft.items.findIndex(candidate => candidate.id === item.id);
      draft.items = draft.items.filter(candidate => candidate.id !== item.id); renderDraft(draft);
      controller.touchDraft();
      const next = draft.items[Math.min(index, draft.items.length - 1)];
      document.querySelector(`[data-item-id="${CSS.escape(next.id)}"] input`)?.focus();
    });
    itemHost.append(card);
  }
  $("#add-member").onclick = () => {
    if (draft.members.length >= constants.LIMITS.members) return showError("Participant limit reached.");
    const id = newId("member"); draft.members.push({ id, name: creatingPlan ? "" : "New participant", budgetMinor: null });
    for (const item of draft.items) item.weights.push({ memberId: id, units: creatingPlan ? 1 : 0 });
    controller.touchDraft();
    renderDraft(draft);
    document.querySelector(`[data-member-id="${CSS.escape(id)}"] input`)?.focus();
  };
  $("#add-item").onclick = () => {
    if (draft.items.length >= constants.LIMITS.items) return showError("Item limit reached.");
    const id = newId("item");
    draft.items.push({ id, label: creatingPlan ? "" : "New item", unitMinor: creatingPlan ? Number.NaN : 0, quantity: 1, weights: draft.members.map(member => ({ memberId: member.id, units: 1 })) });
    controller.touchDraft();
    renderDraft(draft);
    document.querySelector(`[data-item-id="${CSS.escape(id)}"] input`)?.focus();
  };
  $("#change-form").onsubmit = event => {
    event.preventDefault();
    try {
      const token = JSON.parse($("#change-panel").dataset.token);
      const firstPlan = creatingPlan;
      const revision = { ...draft, ordinal: firstPlan ? 1 : token.ordinal + 1, revisionId: newId("revision"), createdAt: now(), note: $("#change-note").value, policy: constants.POLICY };
      if (firstPlan) {
        if (token.generation !== controller.generation || token.session !== controller.session)
          throw new Error("The open plan changed while you were drafting. Your new draft has been kept.");
        evaluateRevision(revision);
        const title = $("#draft-project-name").value.trim();
        if (!title) throw new Error("Give your group plan a name.");
        if (controller.project && !window.confirm("Replace the open plan with this new group? Export the current plan first if you need to keep its history.")) return;
        controller.replaceWithNew({ projectId: newId("project"), title, eventId: newId("event"), at: now(), revision });
      } else {
        controller.amend(token, { eventId: newId("event"), at: now(), revision });
      }
      activeDraftId += 1; draftReturnRevision = null; setCreationMode(false);
      $("#change-panel").hidden = true; hideError(); render();
      (firstPlan ? $("#plan-title") : $("#begin-change")).focus();
      announce(firstPlan ? "Your group plan is recorded as revision 1. Everyone can now review their own share."
        : `Revision ${revision.ordinal} created. All earlier approvals are historical.`);
    } catch (error) { if (error.code === "stale_session") showDraftConflict(error.message, draft); else showError(error.message); }
  };
  $("#find-budget-option").onclick = () => {
    const host = $("#budget-option"); host.replaceChildren();
    try {
      const result = proposeBudgetRescue(draft);
      if (result.status === "unknown-limits") {
        host.append(el("p", "Add everyone’s spending limit to find a split."));
        return;
      }
      if (result.status === "already-feasible") {
        host.append(el("p", "Everyone is already within their spending limit."));
        return;
      }
      if (result.status === "unfunded") {
        host.append(el("p", `The purchases cost ${money(result.shortfallMinor)} more than everyone’s combined limits. Reduce a purchase or agree on higher limits.`, "bad"));
        return;
      }
      const people = new Map(draft.members.map(member => [member.id, member.name]));
      const things = new Map(draft.items.map(item => [item.id, item.label]));
      if (result.status === "participation-blocked") {
        host.append(el("p", `No within-budget split preserves the current exclusions. These purchases need ${money(result.requiredMinor)}, but the people included in them have only ${money(result.availableMinor)} in combined limits: a ${money(result.shortfallMinor)} gap.`, "bad"));
        host.append(el("p", "Affected purchases: " + result.itemIds.map(id => things.get(id)).join(", ") + ". Included people: " + result.memberIds.map(id => people.get(id)).join(", ") + "."));
        host.append(el("p", "Reduce these purchases or discuss the limits and participation with the group. A zero share stays excluded; no excluded person has been added.", "fine"));
        return;
      }
      host.append(el("h4", "Everyone fits their limit"), el("p", `Same purchases and prices. ${money(result.movedMinor)} moves between shares.`, "fine"));
      const amounts = el("section");
      amounts.className = "candidate-amounts";
      amounts.setAttribute("aria-label", "Proposed shares within spending limits");
      const summary = el("ul", undefined, "allocation-preview");
      const beforeAmounts = new Map(result.before.members.map(member => [member.id, member.amountMinor]));
      for (const member of result.after.members) {
        const delta = member.amountMinor - beforeAmounts.get(member.id);
        const row = el("li");
        if (row.style) row.style.setProperty("--person", personColor(member.id));
        row.append(el("span", member.name), el("strong", money(member.amountMinor)));
        row.append(el("small", `Draft ${money(beforeAmounts.get(member.id))} · ${delta < 0 ? "−" : "+"}${money(Math.abs(delta))} · Within ${limitLabel(member.budgetMinor)} limit`, "fine"));
        summary.append(row);
      }
      amounts.append(summary); host.append(amounts);
      const changes = el("details", undefined, "local-split-changes");
      changes.append(el("summary", "How the purchases are shared"));
      const list = el("ol");
      for (const transfer of result.transfers.slice(0, 20)) {
        list.append(el("li", `${money(transfer.minor)} of ${things.get(transfer.itemId)}: ${people.get(transfer.fromMemberId)} → ${people.get(transfer.toMemberId)}`));
      }
      if (result.transfers.length > 20) list.append(el("li", `${result.transfers.length - 20} additional reallocations; inspect the full editable split after copying.`));
      changes.append(list); host.append(changes);
      const copy = el("button", "Use this split in my draft", "primary");
      copy.type = "button";
      const snapshot = JSON.stringify(draft);
      const context = draftContext();
      copy.addEventListener("click", () => {
        if ($("#change-panel").hidden || draftContext() !== context || JSON.stringify(draft) !== snapshot) {
          showError("This suggested split is stale. The draft or recorded plan changed; request a new alternative.");
          return;
        }
        draft.items = result.revision.items.map(item => ({ ...item, weights: item.weights.map(weight => ({ ...weight })) }));
        controller.touchDraft();
        renderDraft(draft);
        showCopiedDraft();
      });
      host.append(copy);
      host.scrollIntoView({block:"start"});
    } catch (error) {
      host.append(el("p", `No valid budget alternative could be calculated: ${error.message}`, "bad"));
    }
  };
  const renderAiProposal = (host,data,snapshot,base,adjusted=false) => {
      const checked = validateSuggestion(draft, {
        itemWeights: data.candidate.items.map(item => ({ itemId: item.id, weights: item.weights })),
        explanation: data.explanation
      });
      if(adjusted)host.append(el("h4","Your adjusted split"));
      const caption = el("p", checked.explanation || "Review the proposed amounts before copying them.");
      host.append(caption);
      const totals = el("table", undefined, "counteroffer-table");
      totals.append(el("caption", "Everyone’s proposed share"));
      const head = el("tr"); ["Person", "Now", "Proposed"].forEach(label => head.append(el("th", label)));
      totals.append(head);
      for (const row of checked.changes) {
        const line = el("tr"), proposed = el("td");
        proposed.append(el("strong", money(row.afterMinor)),
          el("small", (row.deltaMinor > 0 ? "+" : "") + money(row.deltaMinor)));
        line.append(el("th", row.name), el("td", money(row.beforeMinor)), proposed);
        line.firstChild.scope = "row"; totals.append(line);
      }
      host.append(totals);
      const before = evaluateRevision(draft), after = evaluateRevision(checked.candidate);
      const purchases = el("details", undefined, "counteroffer-purchases");
      purchases.append(el("summary", "Changes by purchase"));
      for (let index = 0; index < draft.items.length; index++) {
        const original = before.items[index].allocations, revised = after.items[index].allocations;
        if (original.every(row => row.minor === revised.find(value => value.memberId === row.memberId).minor)) continue;
        const table = el("table", undefined, "counteroffer-table");
        table.append(el("caption", draft.items[index].label));
        const headings = el("tr"); ["Person", "Now", "Proposed"].forEach(label => headings.append(el("th", label)));
        table.append(headings);
        for (const row of original) {
          const line = el("tr"), member = draft.members.find(value => value.id === row.memberId);
          line.append(el("th", member.name), el("td", money(row.minor)),
            el("td", money(revised.find(value => value.memberId === row.memberId).minor)));
          line.firstChild.scope = "row"; table.append(line);
        }
        purchases.append(table);
      }
      host.append(purchases);
      const apply = el("button", adjusted ? "Copy adjusted split into my draft" : "Copy AI split into my editable draft");
      apply.type = "button";
      apply.addEventListener("click", () => {
        if ($("#change-panel").hidden || JSON.stringify(draft) !== snapshot ||
            draftContext() !== base) {
          host.replaceChildren(el("p", "This suggestion is stale. Re-run it against the current draft.", "bad"));
          return;
        }
        draft.items = checked.candidate.items.map(item => ({
          ...item, weights: item.weights.map(weight => ({ ...weight }))
        }));
        controller.touchDraft();
        renderDraft(draft);
        showCopiedDraft();
      });
      host.append(apply);
  };

  const renderAiReview = (host, data, snapshot, base, manual = false) => {
    const labels={balanced_extra:"Equal extra costs",balanced_total:"Equal final totals",minimum_change:"Smallest changes",clarify:"Fairness needs a choice"};
    const reading=manual ? {method:"clarify",fixedItems:[],fixedPeople:[]} : data.modelInterpretation;
    const original=el("p", manual ? "No model reading was received." : "Model reading: "+labels[reading.method]+
      (reading.fixedItems.length || reading.fixedPeople.length ? ". Unchanged: "+[
        ...reading.fixedItems.map(id=>draft.items.find(item=>item.id===id)?.label),
        ...reading.fixedPeople.map(id=>draft.members.find(member=>member.id===id)?.name)
      ].filter(Boolean).join(", ")+".":"; no protected allocations."), "model-reading");
    if(!manual)host.append(original);
    if(data.error)host.append(el("p",(manual ? "Original request: " : "Original model result: ")+data.error,"bad model-error"));
    if(data.direct)host.dataset.sharingSource=snapshot;
    const editor=el("fieldset",undefined,"interpretation-editor");
    editor.append(el("legend",manual ? "Choose a split" : "Review this reading"));
    const methodLabel=el("label","Sharing rule"), select=el("select");
    select.id=data.direct ? "split-method" : "interpretation-method";
    const prompt=el("option","Choose a rule");prompt.value="";select.append(prompt);
    for(const key of ["balanced_extra","balanced_total","minimum_change"]){
      const option=el("option",labels[key]);option.value=key;select.append(option);
    }
    select.value=reading.method==="clarify"?"":reading.method;methodLabel.append(select);editor.append(methodLabel);
    const choices=(title,rows,selected,attribute)=>{
      const group=el("div",undefined,"interpretation-choices");group.append(el("strong",title));
      for(const row of rows){
        const label=el("label",undefined,"interpretation-choice"),input=el("input");
        input.type="checkbox";input.checked=selected.includes(row.id);input.setAttribute(attribute,row.id);
        label.append(input,document.createTextNode(row.label || row.name));group.append(label);
      }
      editor.append(group);
    };
    choices("Keep purchases unchanged",draft.items,reading.fixedItems,"data-interpretation-item");
    choices("Keep people unchanged",draft.members,reading.fixedPeople,"data-interpretation-person");
    const calculate=el("button",manual ? "Calculate this split" : "Calculate this reading");calculate.id=data.direct ? "calculate-split" : "recalculate-ai";calculate.type="button";calculate.disabled=!select.value;
    const feedback=el("p",undefined,"fine");feedback.setAttribute("role","status");
    editor.append(calculate,feedback);host.append(editor);
    const proposal=el("div",undefined,"counteroffer-proposal");host.append(proposal);
    let readingVersion=0, calculating=false;
    const readingChanged=()=>{
      readingVersion++;
      proposal.replaceChildren();
      feedback.textContent="Choices changed. Calculate this reading to see the new split.";
      calculate.disabled=calculating || !select.value;
      if(data.direct)persistWorkspace();
    };
    select.onchange=readingChanged;
    editor.querySelectorAll("input[type=checkbox]").forEach(input=>input.onchange=readingChanged);
    calculate.onclick=async()=>{
      if($("#change-panel").hidden || JSON.stringify(draft)!==snapshot || draftContext()!==base){
        feedback.textContent="The draft changed. Ask again using the current draft.";return;
      }
      const calculationVersion=readingVersion;calculating=true;
      calculate.disabled=true;feedback.textContent="Calculating exact amounts…";proposal.replaceChildren();
      const preference={method:select.value,
        fixedItems:[...editor.querySelectorAll("[data-interpretation-item]:checked")].map(input=>input.getAttribute("data-interpretation-item")),
        fixedPeople:[...editor.querySelectorAll("[data-interpretation-person]:checked")].map(input=>input.getAttribute("data-interpretation-person"))};
      try{
        const response=await fetch("/api/ai/calculate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({revision:draft,preference})});
        const adjusted=await response.json();
        if(!response.ok)throw Error(adjusted.error || "This reading cannot fit the limits.");
        if($("#change-panel").hidden || JSON.stringify(draft)!==snapshot || draftContext()!==base)throw Error("The draft changed. Ask again using the current draft.");
        if(readingVersion!==calculationVersion)throw Error("Choices changed. Calculate this reading to see the new split.");
        feedback.textContent="Calculated from your choices.";
        renderAiProposal(proposal,adjusted,snapshot,base,true);
        proposal.setAttribute("tabindex","-1");proposal.focus({preventScroll:true});proposal.scrollIntoView({block:"start"});
      }catch(error){feedback.textContent=error.message;}finally{calculating=false;calculate.disabled=!select.value;}
    };
    if(data.candidate)renderAiProposal(proposal,data,snapshot,base,false);
  };
  $("#choose-split").onclick = () => {
    const host=$("#manual-split");host.replaceChildren();
    try{
      evaluateRevision(draft);
      renderAiReview(host,{direct:true},JSON.stringify(draft),draftContext(),true);
      persistWorkspace();
      $("#split-method").focus({preventScroll:true});
      host.scrollIntoView({block:"start"});
    }catch(error){host.append(el("p",error.message,"bad"));}
  };
  $("#ask-ai").onclick = async () => {
    $("#manual-split").replaceChildren();
    persistWorkspace();
    if (!aiConfigured) return;
    const host = $("#ai-result"); host.replaceChildren();
    const goal = $("#ai-goal").value.trim();
    if (!goal) { host.append(el("p", "Describe the change you want to explore.", "bad")); $("#ai-goal").focus(); return; }
    const snapshot = JSON.stringify(draft);
    const base = draftContext();
    const button = $("#ask-ai");
    const showRequest = () => {
      const request = el("div", undefined, "ai-request-context");
      request.append(el("strong", "Your request"), el("p", goal));
      host.prepend(request);
    };
    button.disabled = true;
    $("#ai-availability").textContent = "Working…";
    showRequest();
    const waiting = el("p", "Interpreting your request…", "ai-waiting");
    host.append(waiting);
    host.setAttribute("aria-busy", "true");
    $(".ai-negotiation").scrollIntoView({block:"start"});
    const requestedAt = Date.now();
    const waitingTimer = setInterval(() => {
      waiting.textContent = "Interpreting your request… " + Math.floor((Date.now() - requestedAt) / 1000) + " s";
    }, 1000);
    let requestStarted=false;
    try {
      // Reject malformed drafts BEFORE sending participant information to a model.
      evaluateRevision(draft);
      requestStarted=true;
      const reply = await fetch("/api/ai/suggest", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal, revision: draft })
      });
      const data = await reply.json();
      host.replaceChildren();
      if (reply.status === 503) {
        aiConfigured = false;
        $("#ai-availability").textContent = "AI is unavailable. You can still use the split above.";
      }
      if (!reply.ok && !data.modelInterpretation) throw new Error(data.error || "The model request failed.");
      if ($("#change-panel").hidden || JSON.stringify(draft) !== snapshot ||
          draftContext() !== base) {
        throw new Error("The draft changed while the model was working. Re-run the suggestion.");
      }
      renderAiReview(host,data,snapshot,base);
      showRequest();
      host.scrollIntoView({block:"start"});
    } catch (error) {
      const message=error.message || "AI suggestion failed.";
      host.replaceChildren(el("p", message, "bad model-error"));
      showRequest();
      if(requestStarted && !$("#change-panel").hidden && JSON.stringify(draft)===snapshot && draftContext()===base){
        const choose=el("button","Choose the split myself");choose.type="button";choose.id="choose-reading";
        choose.onclick=()=>{
          if($("#change-panel").hidden || JSON.stringify(draft)!==snapshot || draftContext()!==base){
            host.replaceChildren(el("p","The draft changed. Reopen its current split choices.","bad"));return;
          }
          host.replaceChildren();renderAiReview(host,{error:message},snapshot,base,true);showRequest();
          $("#interpretation-method").focus();
        };
        host.append(choose);
      }
    } finally { clearInterval(waitingTimer); host.removeAttribute("aria-busy"); button.disabled = !aiConfigured; if (aiConfigured) $("#ai-availability").textContent = "Ready"; }
  };
  preview(draft);
}

function strictNumber(value) { return /^\d+$/.test(value) ? Number(value) : Number.NaN; }
function previewItemAmounts(draft) {
  for (const item of draft.items) {
    const card = document.querySelector(`[data-item-id="${CSS.escape(item.id)}"]`);
    if (!card) continue;
    const status = card.querySelector("[data-item-allocation-status]");
    const outputs = [...card.querySelectorAll("[data-share-amount]")];
    const sharingSummary = card.querySelector("[data-sharing-summary]");
    if (sharingSummary) {
      const equal = item.weights.every(weight => Number.isSafeInteger(weight.units) && weight.units > 0 && weight.units === item.weights[0].units);
      sharingSummary.textContent = equal ? "Split equally · adjust shares" : "Custom split · adjust shares";
      for (const row of card.querySelectorAll("[data-creation-share]")) {
        row.querySelector(".creation-share-name").textContent = draft.members.find(member => member.id === row.dataset.creationShare)?.name || "Person";
      }
    }
    const validPrice = Number.isSafeInteger(item.unitMinor) && item.unitMinor >= 0;
    const validQuantity = Number.isSafeInteger(item.quantity) && item.quantity >= 1;
    const validWeights = item.weights.every(w => Number.isSafeInteger(w.units) && w.units >= 0);
    const totalWeight = item.weights.reduce((sum, w) => sum + w.units, 0);
    let message = "";
    if (!validPrice || !validQuantity) message = "Enter a valid price and whole quantity to see this purchase's split.";
    else if (!validWeights || !Number.isSafeInteger(totalWeight)) message = "Use whole, non-negative shares to see this purchase's split.";
    else if (totalWeight === 0) message = "Include at least one person in this purchase.";
    else if (!Number.isSafeInteger(item.unitMinor * item.quantity)) message = "This purchase total is too large to calculate exactly.";
    if (message) {
      for (const output of outputs) output.textContent = "Not calculated";
      status.textContent = message;
      status.className = "item-allocation-status bad";
      continue;
    }
    const allocations = new Map(allocateItem(item).map(row => [row.memberId, row.minor]));
    const weights = new Map(item.weights.map(row => [row.memberId, row.units]));
    for (const output of outputs) {
      const id = output.dataset.shareAmount;
      output.textContent = weights.get(id) === 0 ? money(0) + " · Not included" : money(allocations.get(id));
    }
    status.className = "item-allocation-status fine";
    status.textContent = "Purchase total " + money(item.unitMinor * item.quantity) + " · Split to the cent.";
  }
}

function preview(draft) {
  const amountProblems = draftAmountChecks.map(check => check()).filter(Boolean);
  for (const card of document.querySelectorAll("#member-editors [data-limit-impact]")) card.remove();
  $("#draft-copy-status").hidden = true;
  previewItemAmounts(draft);
  $("#budget-option").replaceChildren();
  $("#manual-split").replaceChildren();
  $("#ai-result").replaceChildren();
  persistWorkspace();
  try {
    const evaluation = evaluateRevision(draft);
    renderSplit(evaluation, $("#draft-split"));
    if (!creatingPlan) for (const member of evaluation.members) {
      if (!member.overMinor) continue;
      const card = document.querySelector('[data-member-id="' + CSS.escape(member.id) + '"]');
      if (!card) continue;
      const impact = el("div", undefined, "limit-impact");
      impact.dataset.limitImpact = "";
      impact.append(el("p", money(member.amountMinor) + " proposed · " + money(member.overMinor) + " above this limit", "bad"));
      if (evaluation.budgetsKnown) {
        const choose = el("button", "Review a split within limits");
        choose.type = "button";
        choose.addEventListener("click", () => {
          $(".draft-alternatives").open = true;
          $("#choose-split").click();
        });
        impact.append(choose);
      } else impact.append(el("p", "Confirm the remaining limits before calculating another split.", "fine"));
      card.append(impact);
    }
    $("#ask-ai").disabled = !aiConfigured || !evaluation.budgetsKnown;
    $("#choose-split").disabled = !evaluation.budgetsKnown;
    $("#save-draft").disabled = creatingPlan && !$("#draft-project-name").value.trim();
    if (creatingPlan) {
      const host = $("#preview-body");
      const total = el("p", money(evaluation.totalMinor), "draft-total");
      const list = el("ul", undefined, "allocation-preview");
      for (const member of evaluation.members) {
        const row = el("li");
        row.append(el("span", member.name), el("strong", money(member.amountMinor)));
        row.append(el("small", member.budgetStatus === "unknown" ? "Limit not provided; approval needs review" : member.overMinor ? `Over limit by ${money(member.overMinor)}`
          : `Within ${limitLabel(member.budgetMinor)} limit`, member.overMinor ? "bad" : "fine"));
        list.append(row);
      }
      host.replaceChildren(total, list);
      if (!evaluation.feasible) host.append(el("p", !evaluation.budgetsKnown
        ? "You can record these proposed shares while limits are missing. Approval stays unavailable until every limit is confirmed and the plan fits."
        : "This plan exceeds a spending limit. You can record it to discuss, but approval stays unavailable until a later plan fits.", !evaluation.budgetsKnown ? "pending" : "bad"));
      $("#save-draft").disabled = !$("#draft-project-name").value.trim();
      hideError(); return;
    }
    const current = controller.state.evaluation;
    const nextById = new Map(evaluation.members.map(member => [member.id, member]));
    const oldById = new Map(current.members.map(member => [member.id, member]));
    const orderedIds = [...draft.members.map(member => member.id), ...current.members.filter(member => !nextById.has(member.id)).map(member => member.id)];
    const rows = orderedIds.map(id => {
      const member = nextById.get(id); const oldMember = oldById.get(id);
      const amount = member?.amountMinor ?? 0; const old = oldMember?.amountMinor ?? 0; const delta = amount - old;
      const name = member?.name ?? oldMember.name;
      return `${name}: ${money(amount)} (${delta >= 0 ? "+" : ""}${money(delta)})${member?.overMinor ? `; over limit by ${money(member.overMinor)}` : member ? "" : "; removed from next proposal"}`;
    });
    $("#preview-body").replaceChildren(el("p", `Draft total ${money(evaluation.totalMinor)}; current total ${money(current.totalMinor)}. `), Object.assign(el("ul"), { }));
    const list = $("#preview-body").lastChild; for (const row of rows) list.append(el("li", row));
    hideError();
  } catch (error) {
    $("#draft-split")?.replaceChildren();
    $("#save-draft").disabled = true;
    $("#ask-ai").disabled = true;
    $("#choose-split").disabled = true;
    if (creatingPlan) {
      const missing = draft.members.some(member => !member.name.trim() || (member.budgetMinor !== null && !Number.isSafeInteger(member.budgetMinor))) ||
        draft.items.some(item => !item.label.trim() || !Number.isSafeInteger(item.unitMinor));
      $("#preview-body").replaceChildren(el("p", amountProblems[0] || (missing
        ? "Add each person’s name, then a purchase and its price. You can add spending limits when people provide them."
        : `Check the purchase quantities and shares: ${error.message}`), amountProblems.length ? "bad" : missing ? "draft-empty" : "bad"));
    } else $("#preview-body").replaceChildren(el("p", `Draft is not valid yet: ${error.message}`, "bad"));
  }
}
function showError(message) { const node = $("#error-summary"); node.textContent = message; node.hidden = false; node.focus(); announce(message); }
function showDraftConflict(message) {
  showError(`${message} The draft was preserved.`);
  const prior = JSON.parse($("#change-panel").dataset.token); const current = controller.captureAction();
  if (prior.session === current.session && prior.projectId === current.projectId && prior.revisionId === current.revisionId && prior.revisionFingerprint === current.revisionFingerprint) {
    const rebind = el("button", "Review current proposal and rebind this draft"); rebind.type = "button";
    rebind.addEventListener("click", () => { $("#change-panel").dataset.token = JSON.stringify(current); hideError(); $("#change-note").focus(); announce("Draft rebound to the unchanged current proposal. Review it, then submit again."); });
    $("#error-summary").append(document.createElement("br"), rebind);
  }
}
function hideError() { $("#error-summary").hidden = true; $("#error-summary").textContent = ""; }

function clearResponsePreview() {
  selectedSharedReply=null;
  const responsePreview = $("#response-preview");
  if (!responsePreview) return;
  responsePreview.hidden = true;
  responsePreview.replaceChildren();
}

async function openResponseFile(file, shared = false) {
  if (!file) return;
  const responsePreview = $("#response-preview");
  const token = controller.captureAction();
  clearResponsePreview();
  try {
    const text = await file.text();
    const current = controller.captureAction();
    if (current.generation !== token.generation || current.session !== token.session ||
        current.revisionFingerprint !== token.revisionFingerprint) {
      throw new Error("The proposal changed while this response was being read. Nothing was recorded.");
    }
    const { response, packet } = parseParticipantResponse(controller.state, text);
    if(shared)selectedSharedReply={key:replyContext(),memberId:response.memberId,name:packet.memberName,text};
    const member = controller.state.evaluation.members.find(candidate => candidate.id === response.memberId);
    $("#recipient-select").value = response.memberId;
    responsePreview.hidden = false;
    responsePreview.append(
      el("h3", packet.memberName + " — " + (response.answer === "agree" ? "Agrees" : response.answer === "propose-changes" ? "Proposes a limit and item changes" : response.answer === "propose-limit" ? "Proposes a spending limit" : response.answer === "propose-exclusions" ? "Requests item exclusions" : "Declines")),
      el("p", "R" + packet.ordinal + " · Proposed share " + money(packet.amountMinor))
    );
    if (response.note) responsePreview.append(el("p", response.note, "recipient-note"));
    const responseDetails = el("details");
    responseDetails.append(
      el("summary", shared ? "Invitation response details" : "Imported response details"),
      el("p", shared ? "Received through this person's private invitation." : "This file matches the proposal; its author is not verified.", "fine"),
      el("p", "Self-reported response time: " + response.createdAt, "fine")
    );
    responsePreview.append(responseDetails);
    if (response.answer === "propose-limit") {
      responsePreview.append(
        el("p", "Proposed spending limit: " + money(response.proposedBudgetMinor) + " USD", "response-limit"),
        el("p", "This reply requests a change. Copy it into your draft, then record a new revision for everyone to agree.", "fine")
      );
      const copy = el("button", "Use this limit in the draft");
      copy.id = "copy-response-limit";
      copy.type = "button";
      copy.addEventListener("click", () => {
        try {
          const current = controller.captureAction();
          if (current.generation !== token.generation || current.session !== token.session ||
              current.revisionFingerprint !== token.revisionFingerprint)
            throw new Error("That reply is stale. Reopen a response to the current proposal.");
          if ($("#change-panel").hidden) startDraft();
          if ($("#change-panel").hidden || !currentDraft) return;
          const draftToken = JSON.parse($("#change-panel").dataset.token);
          if (draftToken.generation !== current.generation || draftToken.session !== current.session ||
              draftToken.revisionFingerprint !== current.revisionFingerprint)
            throw new Error("This draft needs review against the current proposal before copying a reply.");
          const limit = participantLimitForDraft(controller.state, text, currentDraft);
          const memberDraft = currentDraft.members.find(row => row.id === limit.memberId);
          const card = document.querySelector('[data-member-id="' + CSS.escape(limit.memberId) + '"]');
          const input = card?.querySelector('[data-recovery-key$=":budget"]');
          const unknown = card?.querySelector('[data-recovery-key$=":unknown"]');
          if (!input || !unknown) throw new Error("The participant editor is unavailable. Nothing was copied.");
          memberDraft.budgetMinor = limit.budgetMinor;
          input.value = minorToUsdInput(limit.budgetMinor); input.disabled = false; input.required = true; input.placeholder = "60.00";
          unknown.checked = false;
          controller.touchDraft(); preview(currentDraft);
          copy.textContent = "Limit copied — review the editable proposal";
          input.focus();
          announce("Copied " + limit.memberName + "'s proposed " + money(limit.budgetMinor) + " limit into the draft only. Other edits were kept. Record a new proposal when ready; this reply is not approval.");
        } catch (error) { window.alert(error.message); announce(error.message); }
      });
      responsePreview.append(copy);
    } else if (["propose-exclusions","propose-changes"].includes(response.answer)) {
      const combined=response.answer==="propose-changes";
      if(combined)responsePreview.append(el("p","Proposed spending limit: "+money(response.proposedBudgetMinor)+" USD","response-limit"));
      const requested = el("ul");
      for (const itemId of response.proposedExcludedItemIds) {
        const item = packet.items.find(candidate => candidate.id === itemId);
        requested.append(el("li", item.label + " — current recorded share " + money(item.amountMinor)));
      }
      responsePreview.append(el("p", "Requested items to leave out of " + packet.memberName + "'s share:"), requested,
        el("p", "Other people's proposed amounts may increase. Review the exact draft consequences before copying. This request is not approval, cancellation, or a refund.", "fine"));
      const review = el("button", combined ? "Review limit and item changes" : "Review exclusions in editable proposal"); review.type = "button"; review.id = "review-exclusions";
      const impact = el("div"); const feedback = el("p", "", "fine"); feedback.setAttribute("role", "status");
      const assertCurrent = () => {
        const current = controller.captureAction();
        if (current.generation !== token.generation || current.session !== token.session ||
            current.revisionFingerprint !== token.revisionFingerprint)
          throw new Error("That reply is stale. Reopen a response to the current proposal.");
        const draftToken = JSON.parse($("#change-panel").dataset.token);
        if (draftToken.generation !== current.generation || draftToken.session !== current.session ||
            draftToken.revisionFingerprint !== current.revisionFingerprint)
          throw new Error("Review the draft against the current proposal before copying this request.");
      };
      review.addEventListener("click", () => {
        impact.replaceChildren(); feedback.textContent = "";
        try {
          const current = controller.captureAction();
          if (current.generation !== token.generation || current.session !== token.session ||
              current.revisionFingerprint !== token.revisionFingerprint)
            throw new Error("That reply is stale. Reopen a response to the current proposal.");
          if ($("#change-panel").hidden) startDraft();
          if ($("#change-panel").hidden || !currentDraft) return;
          assertCurrent();
          const result = participantExclusionsForDraft(controller.state, text, currentDraft);
          const draftSnapshot = () => JSON.stringify({
            draft: currentDraft, note: $("#change-note").value,
            fields: [...document.querySelectorAll("#change-panel [data-recovery-key]")]
              .map(input => [input.dataset.recoveryKey, input.value, input.checked])
          });
          const reviewedDraft = draftSnapshot();
          const amounts = el("ul");
          for (const after of result.after.members) {
            const before = result.before.members.find(member => member.id === after.id);
            const limit = after.budgetMinor === null ? "limit not provided — unresolved"
              : "limit " + money(after.budgetMinor) + (after.overMinor > 0
                ? " — " + money(after.overMinor) + " over limit" : " — within limit");
            amounts.append(el("li", after.name + ": " + money(before.amountMinor) + " → " + money(after.amountMinor) + " · " + limit,
              after.budgetMinor === null || after.overMinor > 0 ? "bad" : ""));
          }
          impact.append(el("h4", "If copied into this draft"), amounts,
            el("p", "Purchase total stays " + money(result.after.totalMinor) + ". Everyone must review the next recorded revision.", "fine"));
          if (!result.after.budgetsKnown)
            impact.append(el("p", "Some limits are still unknown. Approval will remain unavailable.", "bad"));
          else if (!result.after.feasible)
            impact.append(el("p", "This alternative exceeds a stated limit. Resolve it before requesting declarations.", "bad"));
          const copy = el("button", combined ? "Copy limit and exclusions into draft" : "Copy exclusions into draft"); copy.type = "button"; copy.id = "copy-exclusions";
          copy.addEventListener("click", () => {
            try {
              assertCurrent();
              if (draftSnapshot() !== reviewedDraft)
                throw new Error("The draft changed after this comparison. Review exclusions again before copying.");
              const fresh = participantExclusionsForDraft(controller.state, text, currentDraft);
              const edits = fresh.changes.map(change => {
                const key = "item:" + change.itemId + ":weight:" + fresh.memberId;
                const input = document.querySelector('[data-recovery-key="' + CSS.escape(key) + '"]');
                const weight = currentDraft.items.find(item => item.id === change.itemId).weights
                  .find(weight => weight.memberId === fresh.memberId);
                if (!input || !weight) throw new Error("An item share editor is unavailable. Nothing was copied.");
                return {input, weight};
              });
              let budgetEdit=null;
              if(combined) {
                const memberDraft=currentDraft.members.find(row=>row.id===fresh.memberId);
                const card=document.querySelector('[data-member-id="'+CSS.escape(fresh.memberId)+'"]');
                const input=card?.querySelector('[data-recovery-key$=":budget"]');
                const unknown=card?.querySelector('[data-recovery-key$=":unknown"]');
                if(!memberDraft || !input || !unknown)throw new Error("The participant limit editor is unavailable. Nothing was copied.");
                budgetEdit={memberDraft,input,unknown};
              }
              for (const {input, weight} of edits) { input.value = "0"; weight.units = 0; }
              if(budgetEdit) {
                budgetEdit.memberDraft.budgetMinor=fresh.proposedBudgetMinor;
                budgetEdit.input.value=minorToUsdInput(fresh.proposedBudgetMinor);
                budgetEdit.input.disabled=false;budgetEdit.input.required=true;budgetEdit.input.placeholder="60.00";
                budgetEdit.unknown.checked=false;
              }
              controller.touchDraft(); preview(currentDraft);
              copy.disabled = true; copy.textContent = combined ? "Limit and exclusions copied into draft" : "Exclusions copied into draft";
              feedback.textContent = "Only " + fresh.memberName + (combined ? "'s proposed limit and selected item shares changed." : "'s selected item shares changed.") + " Other edits were kept. Review and record a new revision; this reply records no approval.";
              edits[0]?.input.focus(); announce(feedback.textContent);
            } catch (error) { feedback.textContent = error.message; announce(error.message); }
          });
          impact.append(copy);
        } catch (error) { feedback.textContent = error.message; announce(error.message); }
      });
      responsePreview.append(review, impact, feedback);
    } else if (response.answer === "agree" && !member.approved) {
      const record = el("button", "After verifying identity, record local declaration");
      record.type = "button";
      record.addEventListener("click", () => {
        try {
          const current = controller.captureAction();
          if (current.generation !== token.generation || current.session !== token.session ||
              current.revisionFingerprint !== token.revisionFingerprint) {
            throw new Error("That response is stale. Reopen the current participant response.");
          }
          if (!window.confirm("Have you independently confirmed this response came from " +
              packet.memberName + "? The file alone does not authenticate them. Record a local declaration?")) return;
          controller.approve(token, { eventId: newId("event"), at: now(), memberId: response.memberId });
          render(); announce("Local declaration recorded for " + packet.memberName + ". This does not authenticate the responder or authorize a payment.");
        } catch (error) { window.alert(error.message); announce(error.message); }
      });
      responsePreview.append(record);
    } else if (response.answer === "decline" && member.approved) {
      const withdraw = el("button", "After verifying identity, withdraw local declaration");
      withdraw.type = "button";
      withdraw.addEventListener("click", () => {
        try {
          const current = controller.captureAction();
          if (current.generation !== token.generation || current.session !== token.session ||
              current.revisionFingerprint !== token.revisionFingerprint) throw new Error("That response is stale. Reopen it.");
          if (!window.confirm("Have you independently confirmed the decline came from " +
              packet.memberName + "? Withdraw the current local declaration?")) return;
          controller.withdraw(token, { eventId: newId("event"), at: now(), memberId: response.memberId });
          render(); announce("Local declaration withdrawn for " + packet.memberName + ". No money was moved.");
        } catch (error) { window.alert(error.message); announce(error.message); }
      });
      responsePreview.append(withdraw);
    } else {
      responsePreview.append(el("p", response.answer === "decline"
        ? packet.memberName + " has not agreed to this proposal. Discuss a change before recording agreement."
        : "A local declaration is already recorded for this participant. Nothing was changed.", "fine"));
    }
    responsePreview.setAttribute("tabindex", "-1");
    responsePreview.focus({ preventScroll: true });
    responsePreview.scrollIntoView({ behavior: "instant", block: "center" });
    announce("Participant response matches the current revision. Verify its source before recording anything.");
  } catch (error) {
    responsePreview.hidden = false;
    responsePreview.replaceChildren(el("p", "Response refused: " + error.message, "bad"));
    announce("Participant response was refused. No declaration was recorded.");
  } finally { $("#response-input").value = ""; }
}

async function openFile(file) {
  if (!file) return;
  const token = controller.beginImport();
  try {
    const text = await file.text();
    if (JSON.parse(text)?.format === "clearinghouse-portable-workspace") {
      const snapshot = parsePortableWorkspace(text);
      validateRecoverableDraft(snapshot.draft);
      const parsed = snapshot.project ? controller.parseImport(snapshot.project) : null;
      const confirmed = !hasWork() || window.confirm("Replace the open workspace with this saved work? Current unfinished edits will be replaced.");
      controller.assertImportCurrent(token);
      if (!confirmed) { announce("Import cancelled. Current work was not changed."); return; }
      restoringRecovery = true;
      try {
        recoveryStore?.release(); recoveryEnabled=false; recoveryError="";
        restoreWorkspaceContent(snapshot, parsed);
      } finally { restoringRecovery=false; }
      recoveryControls();
      $("#recovery-status").textContent="Opened saved work · unfinished edits remain unrecorded. Hosted access and payment status need a fresh check.";
      announce("Saved work opened. No new revision, agreement or payment was created.");
      (snapshot.draft ? $("#draft-project-name") : $("#plan-title")).focus();
      return;
    }
    const parsed = controller.parseImport(text);
    const confirmed = (!controller.project && !creatingPlan) || window.confirm("Replace the current local workspace with this validated project? Unsaved draft fields will be discarded.");
    const outcome = controller.adoptImport(token, parsed, confirmed);
    if (!outcome.adopted) { announce("Import cancelled. Current work was not changed."); return; }
    activeDraftId += 1; setCreationMode(false);
    $("#welcome").hidden = true; $("#workspace").hidden = false; $("#change-panel").hidden = true; render();
    $("#plan-title").focus();
    announce("Project reopened. History and current status were recomputed from source events.");
  } catch (error) { window.alert(`The project was not opened. Current work is unchanged. ${error.message}`); announce("Import refused. Current work is unchanged."); }
  finally { $("#file-input").value = ""; }
}



function paymentContextKey(state, revisionId = state.current.revisionId, sequence = state.sequence) {
  return JSON.stringify([controller.session, state.project.projectId, revisionId, sequence]);
}

function rememberPaymentOrders(state, orders, checkedAt) {
  for (const order of orders) {
    if (!order.orderId || order.status === "UNKNOWN") continue;
    observedPaymentOrders.set(order.orderId, {
      ...order, checkedAt,
      contextKey: paymentContextKey(state, order.revisionId, order.agreementSequence ?? state.sequence)
    });
  }
}

function priorSessionObservations(state) {
  const currentKey = paymentContextKey(state);
  return [...observedPaymentOrders.values()]
    .filter(order => order.contextKey !== currentKey)
    .map(order => ({...order, observationOnly: true}));
}

function priorPaymentStatus(order) {
  if (order.status === "UNKNOWN") return "Current status unavailable";
  if (order.captured) return "Capture verified";
  if (order.captureStatus === "PARTIALLY_REFUNDED") return "Partially refunded · remaining amount needs review";
  if (order.captureStatus === "REFUNDED") return "Refunded · provider status";
  if (order.captureStatus === "PENDING") return "Capture pending";
  if (order.captureStatus === "DECLINED" || order.captureStatus === "DENIED" || order.captureStatus === "FAILED")
    return "Capture " + order.captureStatus.toLowerCase();
  if (order.status === "APPROVED") return "Payer approved · capture not verified";
  if (order.status === "VOIDED") return "Order voided";
  if (order.status === "CREATED" || order.status === "SAVED" || order.status === "PAYER_ACTION_REQUIRED")
    return "Awaiting payer approval";
  return "No completed capture verified";
}

function renderRefundReview(order, state, host, suggestedMinor=null) {
  const key = paymentContextKey(state), source = controller.exportText();
  host.replaceChildren(el("p", "Checking the original capture and refund status…"));
  const stillCurrent = () => controller.state && paymentContextKey(controller.state) === key;
  async function request(path,extra={}) {
    const response=await fetch("/api/paypal-sandbox/"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:source,orderId:order.orderId,...extra})});
    const result=await response.json();
    if(!response.ok||!result.ok)throw new Error(result.message||"Refund status unavailable.");
    return result.review;
  }
  function show(review) {
    if(!stillCurrent())return;
    const verdict = host.closest("[data-prior-order]")?.querySelector(".prior-payment-verdict");
    if (verdict) verdict.textContent = review.operations.some(op => ["REQUESTING","UNKNOWN","PENDING"].includes(op.status))
      ? "Refund pending or unverified · check details below"
      : review.refundedMinor > 0
        ? money(review.refundedMinor) + " refunded · " + money(review.remainingMinor) + " available to refund"
        : priorPaymentStatus(review);
    host.replaceChildren(el("h4","Return money to "+order.memberName));
    host.append(el("p", "R"+order.ordinal+" payment · "+money(review.amountMinor)));
    const list=el("ul",undefined,"allocation-preview");
    for(const [label,minor] of [["Verified refunded",review.refundedMinor],["Available to refund",review.remainingMinor]]) {
      const row=el("li");row.append(el("span",label),el("strong",money(minor)));list.append(row);
    }
    host.append(list);
    if (!review.canRefund) host.append(el("p",review.message,review.remainingMinor === 0 ? "ok" : "pending"));
    const history = el("details",undefined,"refund-history");
    history.append(el("summary","Refund history ("+review.operations.length+")"));
    for(const op of review.operations){
      const detail=el("p",money(op.amountMinor)+" · "+op.status+(op.refundId?" · Refund "+op.refundId:""),"refund-record");
      if(op.message)detail.append(el("small",op.message));history.append(detail);
    }
    const check=el("button","Check refund status");check.type="button";
    check.onclick=async()=>{check.disabled=true;try{show(await request("refund-review"));}catch(e){host.append(el("p",e.message,"bad"));check.disabled=false;}};
    history.append(check);
    host.append(history);
    if(!review.canRefund) { history.open=true; return; }
    const form=el("form",undefined,"refund-form");
    const amount=inputField("Amount to return (USD)",minorToUsdInput(Number.isSafeInteger(suggestedMinor)?Math.min(suggestedMinor,review.remainingMinor):review.remainingMinor),{inputMode:"decimal",required:true});
    const submit=el("button","Review refund","primary");submit.type="submit";
    form.append(amount.label,submit);
    const confirmation=el("div");
    form.onsubmit=event=>{
      event.preventDefault();confirmation.replaceChildren();
      const minor=usdInputToMinor(amount.input.value);
      if(!Number.isSafeInteger(minor)||minor<=0||minor>review.remainingMinor){confirmation.append(el("p","Enter an amount above zero and no more than "+money(review.remainingMinor)+".","bad"));return;}
      confirmation.append(el("p","Return "+money(minor)+" to "+order.memberName+" from the R"+order.ordinal+" payment?"));
      const confirm=el("button","Request "+money(minor)+" refund","primary");confirm.type="button";
      const requestId=crypto.randomUUID();
      confirm.onclick=async()=>{
        if(!stillCurrent()){confirmation.replaceChildren(el("p","The open plan changed. Refresh earlier payments before proceeding.","bad"));return;}
        confirm.disabled=true;submit.disabled=true;amount.input.disabled=true;check.disabled=true;
        confirmation.append(el("p","Requesting the refund. Keep this status until the outcome is checked."));
        try{show(await request("refund",{amountMinor:minor,requestId}));if(netReview)netReview.stale=true;renderSandboxSettlement(controller.state);}
        catch(e){confirmation.append(el("p",e.message+" Check refund status before another request.","bad"));history.open=true;check.disabled=false;}
      };
      confirmation.append(confirm);
    };
    amount.input.addEventListener("input",()=>confirmation.replaceChildren());
    host.append(form,confirmation);
  }
  void request("refund-review").then(show).catch(error=>{if(stillCurrent())host.replaceChildren(el("p",error.message,"bad"));});
}

function renderPriorPaymentRow(order, state) {
  const current = state.evaluation.members.find(member => member.id === order.memberId);
  const row = el("li", undefined, "prior-payment-row");
  row.dataset.priorOrder = order.orderId;
  const person = el("div", undefined, "prior-payment-person");
  person.append(el("strong", order.memberName), el("small",
    "R" + order.ordinal + (order.revisionId === state.current.revisionId ? " · earlier approval record" : " · earlier plan")));
  const previous = el("div", undefined, "prior-payment-amount");
  previous.append(el("span", "Earlier order"), el("strong", "$" + order.amount));
  const verdict = el("p", (order.observationOnly ? "Last observed: " : "") + priorPaymentStatus(order), "prior-payment-verdict");
  previous.append(verdict);
  const next = el("div", undefined, "prior-payment-current");
  next.append(el("span", current ? "Current R" + state.current.ordinal + " share" : "Current plan"),
    el("strong", current ? money(current.amountMinor) : "No share"),
    el("small", current
      ? (current.name !== order.memberName ? "Now listed as " + current.name : "Earlier payment")
      : "Participant removed; earlier payment retained for reference"));
  row.append(person, previous, next);
  if (order.status === "UNKNOWN") {
    const observed = observedPaymentOrders.get(order.orderId);
    const note = observed
      ? "Last checked " + new Date(observed.checkedAt).toLocaleString() + ": " + priorPaymentStatus(observed).toLowerCase() +
        " for the original $" + observed.amount + " order. This is an earlier observation."
      : "The original order is known, but its payment outcome could not be checked.";
    row.append(el("p", note, "prior-payment-uncertain"));
  }
  const details = el("details", undefined, "prior-payment-references");
  details.append(el("summary", "Order and payment references"));
  details.append(el("p", "Order " + order.orderId));
  if (order.captureId) details.append(el("p", "Capture " + order.captureId));
  const checkedAt = order.checkedAt || paymentHistory.checkedAt;
  if (checkedAt) details.append(el("p", "Checked " + new Date(checkedAt).toLocaleString()));
  if (order.agreementSequence) details.append(el("p", "Original approval record: event " + order.agreementSequence));
  row.append(details);
  if (!order.observationOnly && order.captureId && ["COMPLETED","PARTIALLY_REFUNDED","REFUNDED"].includes(order.captureStatus)) {
    const refundHost=el("div",undefined,"refund-review");
    const review=el("button","Review refund");review.type="button";
    review.onclick=()=>renderRefundReview(order,state,refundHost);
    row.append(review,refundHost);
  }
  return row;
}

function renderPaymentHistory(state) {
  const panel = $("#payment-history-panel");
  const hasPriorContext = state.current.ordinal > 1 ||
    state.project.events.some(event => event.type === "approval_withdrawn");
  panel.hidden = !hasPriorContext;
  if (!hasPriorContext) return;
  // Confirmed-empty history follows the people. Unchecked, failed or existing
  // payment context stays ahead of obligations before any new payer action.
  const obligations = $(".people-details");
  if (obligations?.parentElement) {
    const empty = paymentHistory.phase === "ready" && paymentHistory.orders.length === 0;
    obligations.parentElement.insertBefore(panel, empty ? obligations.nextSibling : obligations);
  }
  $("#refresh-payment-history").disabled = paymentHistory.phase === "loading";
  const status = $("#payment-history-status");
  const important = [], other = [];
  for (const order of paymentHistory.orders) {
    const needsAttention = order.captured || order.status === "UNKNOWN" || order.status === "APPROVED" ||
      ["PENDING", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.captureStatus);
    (needsAttention ? important : other).push(order);
  }
  const sort = (a, b) => b.ordinal - a.ordinal || a.memberName.localeCompare(b.memberName);
  const rows = $("#payment-history-rows");
  rows.replaceChildren(...important.sort(sort).map(order => renderPriorPaymentRow(order, state)));
  const others = $("#other-payment-orders");
  others.hidden = other.length === 0;
  $("#other-payment-orders-label").textContent = other.length + " other earlier order" + (other.length === 1 ? "" : "s") + " without a verified completed capture";
  $("#other-payment-order-rows").replaceChildren(...other.sort(sort).map(order => renderPriorPaymentRow(order, state)));
  if (paymentHistory.phase === "loading") {
    status.textContent = important.length
      ? "Refreshing earlier payments. The observations below were checked previously."
      : "Checking earlier PayPal orders for this saved plan…";
  } else if (paymentHistory.phase === "error") {
    status.textContent = "Earlier payment status could not be refreshed. Any previous observations below may be out of date. Try again before requesting more.";
  } else if (!paymentHistory.orders.length) {
    status.textContent = "No earlier PayPal orders were found in this saved plan's history.";
  } else {
    status.textContent = "Earlier orders stay here. Changed payments checks what is still retained against each current share; any return needs your confirmation.";
  }
}

async function refreshPaymentHistory(state = controller.state) {
  if (!state) return;
  const key = paymentContextKey(state);
  const request = ++paymentHistoryRequest;
  paymentHistoryKey = key;
  paymentHistory = {phase: "loading", orders: priorSessionObservations(state), checkedAt: null};
  renderPaymentHistory(state);
  try {
    const response = await fetch("/api/paypal-sandbox/history", {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({project: controller.exportText()})
    });
    const result = await response.json();
    const live = controller.state;
    if (request !== paymentHistoryRequest || !live || paymentContextKey(live) !== key) return;
    if (!response.ok || !result.ok || result.history.projectId !== live.project.projectId ||
        result.history.revisionId !== live.current.revisionId) throw new Error("History unavailable");
    paymentHistory = {phase: "ready", orders: result.history.orders, checkedAt: result.history.checkedAt};
    rememberPaymentOrders(live, result.history.orders, result.history.checkedAt);
    renderPaymentHistory(live);
  } catch {
    const live = controller.state;
    if (request !== paymentHistoryRequest || !live || paymentContextKey(live) !== key) return;
    paymentHistory = {...paymentHistory, phase: "error"};
    renderPaymentHistory(live);
  }
}

function syncPaymentHistory(state) {
  if (paymentHistorySession !== controller.session) {
    paymentHistorySession = controller.session;
    paymentHistoryKey = null;
    paymentHistoryRequest++;
    observedPaymentOrders.clear();
    paymentHistory = {phase: "idle", orders: [], checkedAt: null};
  }
  const hasPriorContext = state.current.ordinal > 1 ||
    state.project.events.some(event => event.type === "approval_withdrawn");
  if (hasPriorContext && paymentHistoryKey !== paymentContextKey(state)) {
    // One read follows a deliberate recorded change or reopened plan; no polling.
    void refreshPaymentHistory(state);
  } else {
    renderPaymentHistory(state);
  }
}

$("#refresh-payment-history").addEventListener("click", () => { void refreshPaymentHistory(); });

function rememberNetReview(next,key){
  const prior=netReviewKey===key?netReview:null;
  if(!next.known&&prior){
    const amount=prior.known?prior.heldMinor:prior.previouslyHeldMinor;
    if(Number.isSafeInteger(amount))next.previouslyHeldMinor=amount;
    for(const member of next.members){
      if(member.known)continue;
      const previous=prior.members.find(row=>row.memberId===member.memberId);
      const held=previous?.known?previous.heldMinor:previous?.previouslyHeldMinor;
      if(Number.isSafeInteger(held))member.previouslyHeldMinor=held;
    }
  }
  netReview=next;netReviewKey=key;
}
function renderNetReview(state){
  const host=$("#changed-payment-review");
  host.replaceChildren();host.hidden=!netReview;
  if(!netReview)return;
  const message=netReview.stale?"These are previously checked amounts. Refresh before continuing."
    :!netReview.known?"Some payments are pending or unavailable. Check again before collecting more."
    :netReview.paymentPlanAccepted&&netReview.paymentPlanCurrent===false?"Retained payments changed. Record a new agreement before collecting more."
    :netReview.settled&&netReview.paymentPlanAccepted?"Everyone's current share is covered, and no return remains."
    :money(netReview.topUpMinor)+" to collect · "+money(netReview.refundDueMinor)+" to return";
  const note=el("p",message,"net-payment-summary");
  note.hidden=netReview.known&&!netReview.stale&&netReview.paymentPlanCurrent!==false;host.append(note);
  const list=el("ul",undefined,"net-payment-people");
  for(const member of netReview.members){
    const row=el("li");row.dataset.netMember=member.memberId;
    const identity=el("div",undefined,"net-payment-person"),avatar=el("span",member.memberName.slice(0,1).toUpperCase(),"person-avatar");
    avatar.style.backgroundColor=participantColors(state).get(member.memberId)||"#ff756c";
    const name=el("div");name.append(el("strong",member.memberName),el("small",member.current?money(member.obligationMinor)+" current share":"No current share"));
    identity.append(avatar,name);
    const position=el("div",undefined,"net-payment-position");
    position.append(el("strong",!member.known&&Number.isSafeInteger(member.previouslyHeldMinor)
      ?money(member.previouslyHeldMinor)+" last checked":money(member.knownHeldMinor)+(member.known?" retained":" confirmed in this check")));
    position.append(el("small",netReview.stale?"Previously checked":!member.known?"Status needs a check"
      :member.refundDueMinor>0?"Return "+money(member.refundDueMinor)
      :member.topUpMinor>0?"Collect "+money(member.topUpMinor):"Nothing more to collect"));
    row.append(identity,position);
    if(member.known&&member.refundDueMinor>0&&!netReview.stale){
      const source=(netReview.orders||[]).find(order=>order.memberId===member.memberId&&order.captureId&&["COMPLETED","PARTIALLY_REFUNDED"].includes(order.captureStatus));
      if(source){
        const review=el("button","Review return");review.type="button";
        const detail=el("div",undefined,"refund-review");
        review.onclick=()=>{renderRefundReview(source,state,detail,member.refundDueMinor);review.disabled=true;};
        row.append(review,detail);
      }
    }
    list.append(row);
  }
  host.append(list);

}
async function reviewChangedPayments(){
  const state=controller.state;if(!state||checkoutPreparing)return;
  const key=paymentContextKey(state);checkoutPreparing=true;
  if(netReview)netReview.stale=true;
  $("#checkout-status").textContent="Checking retained payments and returns…";renderCheckout(state);
  try{
    const response=await fetch("/api/paypal-sandbox/settlement",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({project:controller.exportText()})});
    const body=await response.json();
    if(!controller.state||paymentContextKey(controller.state)!==key)return;
    if(!response.ok||!body.ok||body.settlement.projectId!==state.project.projectId||body.settlement.revisionId!==state.current.revisionId)throw Error(body.message||"Payment check unavailable.");
    rememberNetReview(body.settlement,key);
    $("#checkout-status").textContent=netReview.known?"Review each person's retained payment before creating additional links.":"Payment status is incomplete. No additional links will be created.";
  }catch(error){$("#checkout-status").textContent=error.message;}
  finally{checkoutPreparing=false;if(controller.state)renderCheckout(controller.state);}
}
function renderSandboxSettlement(state) {
  const summary = summarizeSandboxChecks(state.evaluation.members, sandboxChecks);
  const total = state.evaluation.totalMinor;
  const net=netReviewKey===paymentContextKey(state)?netReview:null;
  let complete = summary.payable > 0 && summary.captured === summary.payable && ![...sandboxChecks.values()].some(check=>check.stale);
  const remaining = total-summary.totalMinor;
  let label, scope, kind="Payments";
  if (!summary.payable) {
    label="No payment needed";scope="This plan has no payable shares.";
  } else if (settlementLoading) {
    label="Checking payments…";scope=summary.totalMinor?money(summary.totalMinor)+" previously confirmed":"Opening the group’s existing orders.";
  } else if (complete) {
    label="All paid";scope=money(total)+" paid · $0.00 remaining";kind="Group status";
  } else if (settlementResult && settlementResult.uncertain==="0.00") {
    label=money(remaining)+" remaining";scope=money(summary.totalMinor)+" of "+money(total)+" paid";kind="To collect";
  } else if (sandboxCheckAttempted) {
    label=remaining===0?"Refresh unavailable":money(remaining)+" not confirmed";scope=money(summary.totalMinor)+" previously confirmed · Check again";kind="Payment status";
  } else {
    label="Not checked";scope="Check the group’s current payments.";
  }
  if(net){
    complete=net.settled&&net.paymentPlanAccepted&&!net.stale;
    if(net.stale||!net.known){label="Check changed payments";scope=money(net.previouslyHeldMinor??net.knownHeldMinor)+" previously confirmed";kind="Payment status";}
    else if(net.paymentPlanAccepted&&net.paymentPlanCurrent===false){label="Review the changed payments";scope="Retained credit changed. A new agreement is needed.";kind="Payment status";}
    else if(complete){label="All settled";scope=money(net.obligationMinor)+" retained · $0.00 remaining";kind="Group status";}
    else if(net.refundDueMinor>0){label=net.topUpMinor>0?"Settle the change":"Return "+money(net.refundDueMinor);scope=money(net.topUpMinor)+" to collect · "+money(net.refundDueMinor)+" to return";kind="Changed payments";}
    else{label=net.topUpMinor>0?money(net.topUpMinor)+" remaining":"Covered by earlier payments";scope=money(net.knownHeldMinor)+" already retained";kind="Changed payments";}
  }
  $("#settlement-kind").textContent=kind;$("#settlement-kind").hidden=Boolean(net);
  $("#settlement-label").textContent=label;
  $("#settlement-scope").textContent=scope;
  $("#checkout-heading").textContent=net?"Changed payments":complete?"All paid":"Settle your shares";
  $("#sandbox-checkout").classList.toggle("payments-complete",complete);
  const group=$("#group-payment-status");
  group.hidden=!state.evaluation.agreementRecorded || !sandboxCheckAttempted;
  group.classList.toggle("complete",complete);
  $("#group-payment-label").textContent=label;$("#group-payment-scope").textContent=scope;
  const prepared=checkoutRequest?.prepared?.created || [];
  const allPrepared=summary.payable>0 && state.evaluation.members.filter(m=>m.amountMinor>0).every(m=>prepared.some(e=>e.id===m.id));
  $("#prepare-checkout").hidden=complete || allPrepared;
  $("#prepare-checkout").textContent=state.current.ordinal>1||state.project.events.some(event=>event.type==="approval_withdrawn")
    ?net&&!net.stale&&net.known?(net.topUpMinor>0?"Create "+money(net.topUpMinor)+" in additional links":"Keep these payments"):"Review changed payments"
    :prepared.length?"Create remaining payer links":"Create payer links";
  if(net){
    $("#prepare-checkout").hidden=complete||(net.paymentPlanAccepted&&prepared.length>0);
    if(net.paymentPlanAccepted&&net.paymentPlanCurrent===false)$("#prepare-checkout").disabled=true;
  }
  renderNetReview(state);
  $("#checkout-status").hidden=complete || Boolean(net&&net.known&&!net.stale);
}
function renderCheckout(state) {
  if(checkoutSession!==controller.session){
    checkoutSession=controller.session;checkoutRequest=null;checkoutDiscoveryKey=null;
    sandboxEvidenceKey=null;settlementKey=null;settlementResult=null;
  }
  const key = state.project.projectId + ":" + state.current.revisionId + ":" + state.sequence;
  if(netReviewKey!==paymentContextKey(state)){netReview=null;netReviewKey=paymentContextKey(state);}
  if (sandboxEvidenceKey !== key) {
    sandboxEvidenceKey = key;
    sandboxChecks = new Map();
    sandboxCheckAttempted = false;
    settlementResult = null;
  }
  if (checkoutRequest?.key !== key) {
    const prior = Boolean(checkoutRequest);
    checkoutRequest = null;
    $("#checkout-links").replaceChildren();
    $("#checkout-status").textContent = prior
      ? "The agreement changed. Earlier PayPal links are not revoked; tell payers not to use them."
      : state.evaluation.agreementRecorded
        ? "Everyone has responded. Create a link for each share."
        : "Record everyone’s agreement before creating payer links.";
  }
  if (settlementKey && settlementKey !== key) {
    settlementKey = null;
    $("#settlement-ledger").hidden = true;
    $("#settlement-ledger").replaceChildren();
  }
  $("#refresh-settlement").disabled = checkoutPreparing || settlementLoading || !state.evaluation.agreementRecorded;
  $("#prepare-checkout").disabled = checkoutPreparing || settlementLoading || !state.evaluation.agreementRecorded;
  renderSandboxSettlement(state);
  if(state.evaluation.agreementRecorded && checkoutDiscoveryKey!==key && !checkoutPreparing && !settlementLoading){
    checkoutDiscoveryKey=key;
    queueMicrotask(()=>{const live=controller.state;if(live && paymentContextKey(live)===paymentContextKey(state))void refreshCurrentPayments();});
  }
}
function checkoutLinks(rows) {
  const list = $("#checkout-links");
  for (const entry of rows) {
    let url;
    try { url = new URL(entry.approveUrl); } catch { continue; }
    if (url.protocol !== "https:" || !["www.sandbox.paypal.com","sandbox.paypal.com"].includes(url.hostname)) continue;
    const row = el("li");
    row.dataset.payerId=entry.id;
    const identity=el("div",undefined,"payer-identity");
    const avatar=el("span",entry.name.slice(0,1).toUpperCase(),"person-avatar");
    avatar.style.backgroundColor=participantColors(controller.state).get(entry.id)||"#c1ed67";
    identity.append(avatar,el("strong",entry.name),el("strong","$"+entry.amount,"payer-amount"));
    const link = el("a", "Approve in PayPal");
    link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
    const status = el("p", "Awaiting payer approval.", "fine");
    status.setAttribute("role", "status");
    const inspect = el("button", "Check payment");
    const capture = el("button", "Capture $" + entry.amount);
    inspect.type = capture.type = "button";
    capture.disabled = true;
    capture.hidden = true;
    const actions = el("div", undefined, "checkout-actions");
    actions.append(inspect, capture);
    const key = checkoutRequest?.key;
    row.updatePayment = order => {
      if(order.status !== "UNKNOWN" && !matchesPreparedSandboxOrder(entry,order,controller.state.current.revisionId))order={status:"UNKNOWN"};
      const unknown = order.status === "UNKNOWN";
      const expired = order.reviewBefore && Date.parse(order.reviewBefore)<=Date.now();
      status.textContent = unknown ? (sandboxChecks.get(entry.id)?.captured ? "$"+entry.amount+" previously confirmed captured. Latest check unavailable." : "Payment status unavailable. Check again.")
        : order.captured ? "PayPal verified $" + order.amount + " captured for " + order.memberName + "."
        : expired ? "The review window ended. Check this existing order before another payment."
        : order.captureStatus ? "Payment " + order.captureStatus.toLowerCase() + "."
        : order.status === "APPROVED" ? "Payer approved. Ready to capture."
        : order.status === "VOIDED" ? "Order voided."
        : "Awaiting payer approval.";
      link.hidden = unknown || expired || order.captured || Boolean(order.captureStatus) || order.status === "APPROVED" || order.status === "VOIDED";
      capture.hidden = expired || order.status !== "APPROVED" || order.captured;
      capture.disabled = expired || order.status !== "APPROVED" || order.captured;
      row.dataset.paymentState = unknown ? "unknown" : order.captured ? "captured" : order.captureStatus ? order.captureStatus.toLowerCase() : order.status.toLowerCase();
    };
    async function requestStatus(action) {
      const state = controller.state;
      const liveKey = state.project.projectId + ":" + state.current.revisionId + ":" + state.sequence;
      if (key !== liveKey || checkoutRequest?.key !== key) {
        announce("The group agreement changed. Do not use a previous payer link."); return;
      }
      if (action === "capture" && !window.confirm(
        "Capture $" + entry.amount + " from the approved PayPal SANDBOX order for " + entry.name +
        "? This executes a sandbox payment and does not settle anyone else's share.")) return;
      sandboxCheckAttempted = true;
      inspect.disabled = capture.disabled = true;
      status.textContent = action === "capture" ? "Checking approval and requesting explicit sandbox capture…" : "Checking the exact PayPal order…";
      try {
        const response = await fetch("/api/paypal-sandbox/" + (action === "capture" ? "capture" : "status"), {
          method: "POST", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({project:controller.exportText(), memberId:entry.id})
        });
        const result = await response.json();
        const current = controller.state;
        const currentKey = current.project.projectId + ":" + current.current.revisionId + ":" + current.sequence;
        if (currentKey !== key || checkoutRequest?.key !== key) {
          announce("The agreement changed during the provider request. Inspect PayPal directly before further action."); return;
        }
        if (!response.ok || !result.ok) {
          if(sandboxChecks.get(entry.id)?.captured)sandboxChecks.set(entry.id,{...sandboxChecks.get(entry.id),stale:true});else sandboxChecks.delete(entry.id);
          row.updatePayment({status:"UNKNOWN"});
          status.textContent = result.message || "PayPal outcome not confirmed. Check provider status before trying again.";
          capture.disabled = true;
        } else {
          const order = result.order;
          if (!matchesPreparedSandboxOrder(entry, order, current.current.revisionId)) {
            if(sandboxChecks.get(entry.id)?.captured)sandboxChecks.set(entry.id,{...sandboxChecks.get(entry.id),stale:true});else sandboxChecks.delete(entry.id);
            row.updatePayment({status:"UNKNOWN"});
            status.textContent = "Provider order identity, revision, or amount disagrees with the prepared share. Payment status cannot be accepted.";
            capture.disabled = true;
          } else {
            sandboxChecks.set(entry.id, {amountMinor:entry.amountMinor, captured:order.captured});
            rememberPaymentOrders(current, [order], new Date().toISOString());
            status.textContent = order.captured
              ? "PayPal verified $" + order.amount + " captured for " + order.memberName + "."
              : "PayPal order " + order.status + " for " + order.memberName + " · $" + order.amount +
                (order.captureStatus ? "; payment " + order.captureStatus : "; no verified completed capture.");
            capture.disabled = order.status !== "APPROVED" || order.captured;
            row.updatePayment(order);
          }
        }
        announce(status.textContent);
        if (result.ok && result.order?.captured && action === "capture") $("#refresh-settlement").click();
      } catch {
        if(sandboxChecks.get(entry.id)?.captured)sandboxChecks.set(entry.id,{...sandboxChecks.get(entry.id),stale:true});else sandboxChecks.delete(entry.id);
        row.updatePayment({status:"UNKNOWN"});
        status.textContent = "Provider response unknown. Inspect this PayPal order before assuming a payment result.";
        capture.disabled = true;
        announce(status.textContent);
      } finally {
        if (checkoutRequest?.key === key) renderSandboxSettlement(controller.state);
        inspect.disabled = false;
      }
    }
    inspect.addEventListener("click", () => requestStatus("status"));
    capture.addEventListener("click", () => requestStatus("capture"));
    const references=el("details",undefined,"payer-references");
    references.append(el("summary","Payment reference"),el("small",entry.orderId));
    row.append(identity,status,link,actions,references);
    list.append(row);
  }
}
function renderSettlement(result) {
  const ledger = $("#settlement-ledger");
  ledger.replaceChildren();
  const heading = el("h3", "PayPal-checked position · R" + result.ordinal);
  const snapshot = el("small","Checked " + new Date(result.checkedAt).toLocaleString() + " · current recorded revision");
  const amounts = el("p", "$" + result.confirmed + " confirmed of $" + result.total +
    " agreed · $" + result.notConfirmed + " not yet confirmed", "settlement-numbers");
  const caution = el("p", result.uncertain !== "0.00"
    ? "$" + result.uncertain + " has uncertain provider evidence; do not infer it was paid or unpaid."
    : result.allCaptured
      ? "All current nonzero obligations have matching completed PayPal Sandbox captures."
      : "Only matching COMPLETED PayPal captures count as confirmed.", "fine");
  const tableWrap=el("div", undefined, "table-scroll");
  const table=el("table", undefined, "settlement-table");
  const thead=el("thead"), head=el("tr");
  for(const title of ["Member", "Agreed", "PayPal evidence"]) head.append(el("th",title));
  thead.append(head);
  const tbody=el("tbody");
  for(const item of result.members) {
    const row=el("tr");
    let verdict;
    if (item.status === "NO_OBLIGATION") verdict="No payment required";
    else if(item.captured) verdict="Verified captured · " + item.captureId;
    else if(item.status === "NOT_PREPARED") verdict="No current-revision payer order prepared";
    else if(item.status === "UNKNOWN") verdict="Unverified — " + (item.message || "PayPal status could not be checked");
    else verdict="PayPal order " + item.status +
      (item.captureStatus ? " · payment " + item.captureStatus : " · no completed capture");
    row.append(el("td",item.memberName),el("td","$"+item.amount),el("td",verdict));
    tbody.append(row);
  }
  table.append(thead,tbody);
  tableWrap.append(table);
  ledger.append(el("summary","Payment details"),heading,snapshot,amounts,caution,tableWrap);
  ledger.hidden=false;
}
async function refreshCurrentPayments(){
  const state=controller.state;
  if(!state || !state.evaluation.agreementRecorded || settlementLoading) return;
  const key=state.project.projectId + ":" + state.current.revisionId + ":" + state.sequence;
  settlementLoading=true;settlementKey=key;
  if(netReview?.paymentPlanAccepted)netReview.stale=true;
  sandboxCheckAttempted = true;
  sandboxChecks = new Map([...sandboxChecks].filter(([,check])=>check.captured).map(([id,check])=>[id,{...check,stale:true}]));
  settlementResult = null;
  renderCheckout(state);
  const ledger=$("#settlement-ledger");
  ledger.hidden=false;
  ledger.replaceChildren(el("summary","Payment details"),el("p","Checking existing orders…"));
  try {
    const response=await fetch("/api/paypal-sandbox/reconcile",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({project:controller.exportText()})
    });
    const result=await response.json();
    const live=controller.state;
    const liveKey=live.project.projectId + ":" + live.current.revisionId + ":" + live.sequence;
    if(key!==liveKey || settlementKey!==key) {
      ledger.hidden=true;ledger.replaceChildren();
      announce("Agreement changed. The previous payment check no longer describes the current revision.");
      return;
    }
    if(!response.ok || !result.ok) {
      ledger.replaceChildren(el("summary","Payment details"),el("p",result.message || "Unable to check PayPal. No amounts are confirmed by this attempt."));
      for(const row of $("#checkout-links").children)row.updatePayment?.({status:"UNKNOWN"});
      announce(ledger.textContent);
      return;
    }
    const reconciliation=result.reconciliation;
    if(reconciliation.projectId!==live.project.projectId || reconciliation.revisionId!==live.current.revisionId)
      throw Error("Payment check belongs to another plan");
    const prepared=reconciliation.prepared;
    if(prepared?.projectId===live.project.projectId && prepared.revisionId===live.current.revisionId && Array.isArray(prepared.created)){
      checkoutRequest={key,prepared};
      $("#checkout-links").replaceChildren();
      checkoutLinks(prepared.created);
      $("#checkout-status").textContent=prepared.created.length
        ? prepared.created.length+" existing payer orders"
        : "No payer orders yet. Create a link for each share.";
    }
    settlementResult=reconciliation;
    if(reconciliation.settlement){rememberNetReview(reconciliation.settlement,paymentContextKey(live));}
    const freshChecks = checksFromGroupReconciliation(live.evaluation.members, result.reconciliation, live.current.revisionId);
    for(const order of reconciliation.members){
      const prior=sandboxChecks.get(order.memberId);
      if(order.status==="UNKNOWN" && prior?.captured)freshChecks.set(order.memberId,{...prior,stale:true});
    }
    sandboxChecks = freshChecks;
    rememberPaymentOrders(live, result.reconciliation.members, result.reconciliation.checkedAt);
    for(const order of result.reconciliation.members){
      const card=[...$("#checkout-links").children].find(row=>row.dataset.payerId===order.memberId);
      card?.updatePayment?.(order);
    }
    renderSettlement(result.reconciliation);
    announce("$"+result.reconciliation.confirmed+" of $"+result.reconciliation.total+" verified captured for current revision.");
  } catch {
    ledger.replaceChildren(el("summary","Payment details"),el("p","PayPal status is unavailable. Check again before requesting more."));
    for(const row of $("#checkout-links").children)row.updatePayment?.({status:"UNKNOWN"});
    announce(ledger.textContent);
  } finally {
    settlementLoading=false;
    if(controller.state)renderCheckout(controller.state);
  }
}
$("#refresh-settlement").addEventListener("click",()=>{void (netReview&&!netReview.paymentPlanAccepted?reviewChangedPayments():refreshCurrentPayments());});

$("#prepare-checkout").addEventListener("click",async () => {
  const state = controller.state;
  if (!state || !state.evaluation.agreementRecorded || checkoutPreparing) return;
  const key = state.project.projectId + ":" + state.current.revisionId + ":" + state.sequence;
  const changed=state.current.ordinal>1||state.project.events.some(event=>event.type==="approval_withdrawn");
  if(changed&&(!netReview||netReview.stale||!netReview.known)){await reviewChangedPayments();return;}
  checkoutPreparing = true; renderCheckout(state);
  $("#checkout-status").textContent = "Requesting PayPal sandbox orders for this exact revision...";
  try {
    const response = await fetch(changed?"/api/paypal-sandbox/settlement-prepare":"/api/paypal-sandbox", {
      method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({project:controller.exportText(),...(changed?{reviewId:netReview.reviewId}:{})})
    });
    const result = await response.json();
    const current = controller.state;
    const liveKey = current.project.projectId + ":" + current.current.revisionId + ":" + current.sequence;
    if (key !== liveKey) {
      $("#checkout-status").textContent = "The plan changed during checkout. Any earlier issued links may still be active; do not reuse them.";
      $("#checkout-links").replaceChildren(); return;
    }
    checkoutRequest = {key, prepared:response.ok && result.ok ? result : null};
    $("#checkout-links").replaceChildren();
    if (Array.isArray(result.created)) checkoutLinks(result.created);
    if (Array.isArray(result.partial)) checkoutLinks(result.partial);
    $("#checkout-status").textContent = response.ok && result.ok
      ? result.created.length + " shares · $" + result.total + " · R" + result.ordinal
      : (result.message || "Sandbox checkout could not complete.") + (result.partial?.length ? " Earlier orders may exist; confirmed links appear below." : "");
    announce($("#checkout-status").textContent);
  } catch {
    checkoutRequest = {key};
    $("#checkout-status").textContent = "Request outcome unknown. Do not assume no orders were created; a retry in this running server uses the same idempotency keys.";
    announce($("#checkout-status").textContent);
  } finally {
    checkoutPreparing = false;
    renderCheckout(controller.state);
    if(controller.state?.evaluation.agreementRecorded)void refreshCurrentPayments();
  }
});

$("#start-plan-form").addEventListener("submit", event => {
  event.preventDefault();
  const title = $("#new-plan-name").value.trim();
  if (!title) { $("#new-plan-name").focus(); return; }
  startNewPlan(title);
});
$("#new-plan").addEventListener("click", () => startNewPlan());
$("#start-example").addEventListener("click", createExample);
$("#open-file").addEventListener("click", () => $("#file-input").click());
$("#replace-file").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", () => openFile($("#file-input").files[0]));
$("#invite-group").addEventListener("click", () => {
  $("#recipient-panel").scrollIntoView({block:"start",behavior:"instant"});
  $("#recipient-select").focus({preventScroll:true});
});
$("#begin-change").addEventListener("click", () => startDraft());
$("#cancel-change").addEventListener("click", () => {
  if (creatingPlan) {
    controller.touchDraft(); activeDraftId += 1; setCreationMode(false);
    $("#change-panel").hidden = true; hideError();
    $("#workspace").hidden = !controller.project;
    $("#welcome").hidden = Boolean(controller.project);
    if (controller.project) { render(); $("#new-plan").focus(); }
    else $("#new-plan-name").focus();
    persistWorkspace();
    announce("New group draft discarded. Your previous plan was not changed.");
    return;
  }
  activeDraftId += 1;
  const sourceOrdinal = draftReturnRevision;
  draftReturnRevision = null;
  $("#change-panel").hidden = true;
  hideError();
  persistWorkspace();
  announce("Draft discarded. The recorded project was not changed.");
  const originAction = sourceOrdinal === null ? null : document.querySelector(`[data-reuse-revision="${sourceOrdinal}"]`);
  (originAction ?? $("#begin-change")).focus();
});
$("#change-note").addEventListener("input", () => { controller.touchDraft(); persistWorkspace(); });
$("#ai-goal").addEventListener("input", persistWorkspace);
$("#save-work-file").addEventListener("click", () => {
  try {
    const text=exportPortableWorkspace(recoverySnapshot());
    const url=URL.createObjectURL(new Blob([text],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download="clearinghouse-saved-work.json";
    try { link.click(); announce("Saved work download requested, including unfinished edits and kept options. This file does not include hosted access."); }
    finally { setTimeout(()=>URL.revokeObjectURL(url),1000); }
  } catch(error) { window.alert(error.message); }
});
$("#export-plan").addEventListener("click", () => {
  try {
    const text = controller.exportText(); const blob = new Blob([text], { type: "application/json" }); const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url; link.download = `clearinghouse-${controller.state.project.projectId}.json`;
    try { link.click(); announce("Project download requested. Confirm the actual file in your browser."); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) { window.alert(error.message); }
});

$("#download-review").addEventListener("click", downloadParticipantReview);
$("#open-response").addEventListener("click", () => $("#response-input").click());
$("#response-input").addEventListener("change", () => openResponseFile($("#response-input").files[0]));

$("#compare-from-revision").addEventListener("change", () => {
  const state = controller.state;
  const selected = Number($("#compare-from-revision").value);
  if (!state || !state.revisions.slice(0, -1).some(revision => revision.ordinal === selected)) {
    if (state) renderLatestChange(state);
    announce("The selected baseline is not recorded in this workspace.");
    return;
  }
  comparisonFromOrdinal = selected;
  comparisonExplicit = true;
  renderLatestChange(state);
  announce(`Comparing R${selected} with current R${state.current.ordinal}; declarations and payments unchanged.`);
});

$("#save-change-brief").addEventListener("click", () => {
  try {
    const brief = controller.state && changeBriefAgainstRevision(controller.state, comparisonFromOrdinal);
    if (!brief) throw new Error("Record a second proposal before exporting a change brief.");
    const blob = new Blob([changeBriefHtml(brief)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a"); link.href = url;
    link.download = `clearinghouse-${brief.projectId}-r${brief.before.ordinal}-to-r${brief.after.ordinal}-change-brief.html`;
    try { link.click(); announce("Change brief download requested. Verify the file in your browser."); }
    finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
  } catch (error) { window.alert(error.message); }
});


function currentSharingChoice() {
  const host=$("#manual-split"),method=host.querySelector("#split-method");
  if(!method || host.dataset.sharingSource!==JSON.stringify(currentDraft))return undefined;
  return {method:method.value,
    fixedItems:[...host.querySelectorAll("[data-interpretation-item]:checked")].map(input=>input.getAttribute("data-interpretation-item")),
    fixedPeople:[...host.querySelectorAll("[data-interpretation-person]:checked")].map(input=>input.getAttribute("data-interpretation-person"))};
}
function recoverySnapshot() {
  const draft = !$("#change-panel").hidden && currentDraft ? {
    creating:creatingPlan, revision:currentDraft, base:JSON.parse($("#change-panel").dataset.token),
    fromOrdinal:draftReturnRevision, title:$("#draft-project-name").value,
    note:$("#change-note").value, goal:$("#ai-goal").value,
    ...(currentSharingChoice() ? {sharingChoice:currentSharingChoice()} : {}),
    fields:[...document.querySelectorAll("[data-recovery-key]")].map(input => ({
      key:input.dataset.recoveryKey, value:input.value,
      ...(input.type === "checkbox" ? {checked:input.checked} : {})
    }))
  } : null;
  const projectId = controller.project?.projectId;
  const ownerToken = projectId ? sharedOwner(projectId) : null;
  return {project:controller.project ? controller.exportText() : null, draft,
    ...(controller.project ? {scenarios:scenarios.snapshot(controller.captureAction())} : {}),
    ...(ownerToken ? {sharedOrganizer:{projectId, ownerToken}} : {})};
}
function hasWork() { return Boolean(controller.project || !$("#change-panel").hidden); }
function recoveryControls() {
  $("#browser-recovery").hidden = !hasWork() && $("#saved-work").hidden;
  $("#enable-recovery").hidden = recoveryEnabled || !hasWork();
  $("#save-work-file").hidden = !hasWork();
  $("#enable-recovery").disabled = !recoveryStore || !globalThis.navigator?.locks?.request;
  $("#copy-recovery").hidden = !hasWork() || !recoveryStore || !recoveryError;
  $("#recovery-options").hidden = !recoveryEnabled;
  $("#recovery-privacy").hidden = recoveryEnabled;
  $("#stop-recovery").hidden = !recoveryEnabled;
  $("#remove-recovery").hidden = !recoveryEnabled;
}
function persistWorkspace() {
  if (restoringRecovery) return;
  recoveryControls();
  if (!recoveryStore || !recoveryEnabled) {
    if (hasWork()) $("#recovery-status").textContent = recoveryError ||
      "Recovery is off. Keep this work on this browser, or export its recorded history.";
    return;
  }
  try {
    const workspace = recoverySnapshot();
    if (!workspace.project && !workspace.draft) {
      recoveryStore.remove(); recoveryEnabled=false; recoveryError="";
      showSavedWork(); recoveryControls(); return;
    }
    const record = recoveryStore.save(workspace);
    $("#recovery-status").textContent = "Saved here · " +
      new Date(record.savedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",second:"2-digit"}) +
      (workspace.draft ? " · unfinished edits" : " · recorded history");
    recoveryError = "";
  } catch (error) {
    recoveryEnabled=false; recoveryStore.release();
    recoveryError="Browser save failed. Your work is still in this tab. " + error.message;
    $("#recovery-status").textContent=recoveryError;
  }
  recoveryControls();
}
function showSavedWork() {
  const list=$("#saved-work-list");list.replaceChildren();
  let copies=[];
  try { copies=recoveryStore?.list() ?? []; }
  catch { recoveryError="Saved browser work could not be read. Export the open plan to keep it."; }
  for (const copy of copies) {
    const row=el("li"), info=el("div");
    let name="Saved workspace", detail=copy.error;
    try {
      if(copy.record) {
        const w=copy.record.workspace;
        const project=w.project ? controller.parseImport(w.project) : null;
        name=w.draft?.creating ? w.draft.title || "Untitled group draft" : project?.title || "Unfinished group";
        detail=(project ? "R"+replayProject(project).current.ordinal+" · "+project.events.length+" recorded events" : "Draft only") + (w.draft ? " · unfinished edit" : "") +
          " · " + new Date(copy.record.savedAt).toLocaleString();
      }
    } catch(error) {detail=error.message;}
    info.append(el("strong",name),el("small",detail));row.append(info);
    const resume=el("button","Resume");resume.type="button";resume.dataset.recoveryCopy=copy.key;
    resume.disabled=Boolean(copy.error);
    resume.addEventListener("click",()=>{void resumeWorkspace(copy.key)});
    row.append(resume);list.append(row);
  }
  $("#saved-work").hidden=copies.length===0 || hasWork();
  recoveryControls();
}
async function keepWorkspaceCopy() {
  if(!recoveryStore || !hasWork())return;
  recoveryEnabled=false;
  try {
    const claim=await recoveryStore.claim();
    if(!claim.acquired)throw new Error("Could not start a browser copy.");
    recoveryEnabled=true;recoveryError="";
    $("#saved-work").hidden=true;
    persistWorkspace();
  } catch(error) {recoveryError=error.message;persistWorkspace();}
}
function validateRecoverableDraft(draft) {
  if(!draft)return;
  const r=draft.revision;
  if(!r.members.length || r.members.length>constants.LIMITS.members ||
     !r.items.length || r.items.length>constants.LIMITS.items ||
     r.members.some(m=>typeof m.id!=="string" || typeof m.name!=="string") ||
     r.items.some(i=>typeof i.id!=="string" || typeof i.label!=="string" || !Array.isArray(i.weights)) ||
     draft.fields.some(f=>typeof f.key!=="string" || typeof f.value!=="string"))
    throw new Error("This saved unfinished edit is not supported. Its browser copy has been kept.");
}
function restoreWorkspaceContent(snapshot, parsed) {
    controller.reset();activeDraftId+=1;currentDraft=null;draftReturnRevision=null;
    if(parsed) {
      controller.adoptImport(controller.beginImport(),parsed,true);
      scenarios.restore(snapshot.scenarios ?? [], controller.captureAction());
    }
    if(snapshot.sharedOrganizer) {
      const {projectId,ownerToken}=snapshot.sharedOrganizer;
      sharedOwners.set(projectId,ownerToken);
      try {sessionStorage.setItem("clearinghouse-owner:"+projectId,ownerToken);} catch {}
    }
    setCreationMode(false);
    $("#welcome").hidden=Boolean(parsed);$("#workspace").hidden=!parsed;$("#change-panel").hidden=true;
    if(parsed)render();
    if(snapshot.draft) {
      const d=snapshot.draft;
      if(!d.creating && !parsed)throw new Error("This edit is missing its recorded plan.");
      setCreationMode(d.creating);draftReturnRevision=d.fromOrdinal;
      $("#welcome").hidden=true;$("#workspace").hidden=false;$("#change-panel").hidden=false;
      $("#draft-project-name").value=d.title;$("#change-note").value=d.note;$("#ai-goal").value=d.goal;
      const live=parsed ? controller.captureAction() : {generation:controller.generation,session:controller.session};
      const stable=["projectId","sequence","revisionId","revisionFingerprint","ordinal"];
      const stale=!d.creating && stable.some(k=>d.base[k]!==live[k]);
      $("#change-panel").dataset.token=JSON.stringify({...d.base,generation:controller.generation-(stale?1:0),session:controller.session});
      $("#draft-base").textContent=parsed ? "R"+controller.state.current.ordinal+(d.fromOrdinal ? "; reusing R"+d.fromOrdinal+" inputs" : "") : "";
      const draft=structuredClone(d.revision);
      renderDraft(draft);
      const values=new Map(d.fields.map(f=>[f.key,f]));
      for(const input of document.querySelectorAll("[data-recovery-key]")) {
        const value=values.get(input.dataset.recoveryKey);if(!value)continue;
        input.value=value.value;if("checked" in value)input.checked=value.checked;
        input.dispatchEvent(new Event(input.type==="checkbox" ? "change" : "input",{bubbles:true}));
      }
      if(d.creating)$("#draft-project-name").oninput=()=>{controller.touchDraft();preview(draft)};
      preview(draft);
      if(d.sharingChoice && !$("#choose-split").disabled) {
        $("#choose-split").click();
        const host=$("#manual-split"),method=host.querySelector("#split-method");
        if(method) {
          method.value=d.sharingChoice.method;
          for(const input of host.querySelectorAll("[data-interpretation-item]"))
            input.checked=d.sharingChoice.fixedItems.includes(input.getAttribute("data-interpretation-item"));
          for(const input of host.querySelectorAll("[data-interpretation-person]"))
            input.checked=d.sharingChoice.fixedPeople.includes(input.getAttribute("data-interpretation-person"));
          method.dispatchEvent(new Event("change",{bubbles:true}));
          host.querySelector(".interpretation-editor [role=status]").textContent="Sharing choices restored. Calculate to review the amounts.";
          $(".draft-alternatives").open=true;
        }
      }
    }
}
async function resumeWorkspace(key) {
  if(hasWork() && !window.confirm("Replace the open workspace with this browser copy? Unsaved changes in this tab will be replaced."))return;
  recoveryEnabled=false;
  try {
    const claim=await recoveryStore.claim(key);
    const record=claim.record ?? recoveryStore.read(key);
    if(!record)throw new Error("This browser copy is no longer available.");
    const snapshot=record.workspace;
    const parsed=snapshot.project ? controller.parseImport(snapshot.project) : null;
    validateRecoverableDraft(snapshot.draft);
    if(snapshot.draft && !snapshot.draft.creating && !parsed)throw new Error("This edit is missing its recorded plan.");
    restoringRecovery=true;
    restoreWorkspaceContent(snapshot, parsed);
    recoveryEnabled=claim.acquired;
    recoveryError=claim.acquired ? "" : "Another tab is saving this copy. Your edits here stay in this tab; save a separate copy to keep both.";
    $("#saved-work").hidden=true;
    $("#recovery-status").textContent=recoveryError || ("Restored from this browser · "+
      (snapshot.draft ? "unfinished edits are still unrecorded." : "history replayed; payment status needs a fresh check."));
    recoveryControls();
    announce("Browser workspace restored. No new revision, declaration or payment was created.");
  } catch(error) {
    recoveryStore?.release();recoveryEnabled=false;
    recoveryError="Browser copy was not opened. "+error.message;
    $("#recovery-status").textContent=recoveryError;recoveryControls();
  } finally {restoringRecovery=false;}
}
function initializeRecovery() {
  try {
    if(globalThis.window?.localStorage && globalThis.navigator?.locks?.request)
      recoveryStore=new BrowserWorkspaceStore(window.localStorage,navigator.locks);
    else recoveryError="Browser recovery is unavailable here. Export recorded history to keep it.";
  } catch {recoveryError="This browser is not allowing local recovery. Export recorded history to keep it.";}
  showSavedWork();
  $("#enable-recovery").addEventListener("click",()=>{void keepWorkspaceCopy()});
  $("#copy-recovery").addEventListener("click",()=>{void keepWorkspaceCopy()});
  $("#stop-recovery").addEventListener("click",()=>{
    recoveryStore?.release();recoveryEnabled=false;
    recoveryError="Saving stopped. The last browser copy is kept; newer edits stay in this tab.";
    persistWorkspace();
  });
  $("#remove-recovery").addEventListener("click",()=>{
    if(!window.confirm("Remove this browser copy? The open plan stays in this tab. Export history first if you need a portable backup."))return;
    try {recoveryStore.remove();recoveryEnabled=false;recoveryError="Browser copy removed. The open work is still in this tab.";persistWorkspace();}
    catch(error){recoveryError=error.message;$("#recovery-status").textContent=recoveryError;}
  });
  window.addEventListener?.("pagehide",()=>{
    recoveryResume=recoveryEnabled ? {key:recoveryStore.key,stamp:recoveryStore.stamp} : null;
    recoveryStore?.release();recoveryEnabled=false;
  });
  window.addEventListener?.("pageshow",async event=>{
    if(!event.persisted || !recoveryResume)return;
    const previous=recoveryResume;recoveryResume=null;
    try {
      const claim=await recoveryStore.claim(previous.key);
      if(!claim.acquired || claim.record?.stamp!==previous.stamp) {
        recoveryStore.release();
        throw new Error("Saved work changed while this page was away. Save this tab as a separate copy.");
      }
      recoveryEnabled=true;recoveryError="";persistWorkspace();
    } catch(error) {recoveryError=error.message;persistWorkspace();}
  });
  window.addEventListener?.("storage",event=>{
    if(event.key === recoveryStore?.key && recoveryEnabled) {
      recoveryStore.release();recoveryEnabled=false;
      recoveryError="The browser copy changed elsewhere. Your current work is untouched; save a separate copy.";
      persistWorkspace();
    } else if(!hasWork())showSavedWork();
  });
  window.addEventListener?.("beforeunload",event=>{
    if(recoveryError && hasWork() && !recoveryEnabled) {event.preventDefault();event.returnValue="";}
  });
}
initializeRecovery();
initializeHostedPlans();

void checkAiConfiguration();
