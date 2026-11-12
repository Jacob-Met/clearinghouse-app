import { groupTabFontCss } from "../app/group-tab-font.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createProject, amendProject, expectedState, replayProject } from "../app/core.mjs";
import { participantPacket, participantReviewHtml, parseParticipantResponse, reviewedTerms, participantLimitForDraft } from "../app/participant-review.mjs";
import { creation, revision, at } from "./fixtures.mjs";

function state() { return replayProject(createProject(creation())); }
function response(packet, overrides = {}) {
  return JSON.stringify({
    format: "clearinghouse-participant-response/v2",
    reviewedTerms: reviewedTerms(packet, overrides.format ?? "clearinghouse-participant-response/v2"),
    projectId: packet.projectId,
    revisionId: packet.revisionId,
    ordinal: packet.ordinal,
    memberId: packet.memberId,
    amountMinor: packet.amountMinor,
    answer: "agree",
    note: "Reviewed my share.",
    createdAt: "2026-11-09T21:00:00.000Z",
    ...overrides
  });
}
function changed() {
  let project = createProject(creation());
  const next = revision(2);
  next.items[0].quantity = 5;
  project = amendProject(project, expectedState(project), {
    eventId: "revision-change", at: at(10), revision: next
  });
  return replayProject(project);
}

test("person-specific packet reconciles exact item cents and reveals no other participant identities", () => {
  const packet = participantPacket(state(), "asha");
  assert.equal(packet.amountMinor, 6000);
  assert.equal(packet.budgetMinor, 9000);
  assert.equal(packet.priorAmountMinor, null);
  assert.deepEqual(packet.items.map(item => [item.label, item.amountMinor]), [
    ["Tickets", 4000], ["Coach", 2000]
  ]);
  const html = participantReviewHtml(packet);
  assert.match(html, /Asha/);
  assert.match(html, /\$60\.00/);
  assert.match(html, /First recorded proposal/);
  assert.ok(!html.replace(groupTabFontCss, "").includes("Ben"));
  assert.ok(!html.replace(groupTabFontCss, "").includes("Chen"));
  assert.ok(!html.includes("https:"));
  assert.match(html, /does not authenticate your identity/);
  assert.match(html, /Download my response/);
});

test("revised proposal exports actual personal difference and refuses agreement while anyone is over budget", () => {
  const packet = participantPacket(changed(), "ben");
  assert.equal(packet.amountMinor, 12000);
  assert.equal(packet.priorAmountMinor, 10000);
  assert.equal(packet.feasible, false);
  const html = participantReviewHtml(packet);
  assert.match(html, /Previous proposal: \$100\.00/);
  assert.match(html, /Change: \+\$20\.00/);
  assert.match(html, /value='agree' disabled/);
  assert.match(html, /ask the organizer to revise/);
  assert.throws(() => parseParticipantResponse(changed(), response(packet)), /exceeds at least one budget/);
  assert.equal(parseParticipantResponse(changed(), response(packet, { answer: "decline" })).response.answer, "decline");
});

test("only a current version-bound amount with explicit answer is accepted for inspection", () => {
  const s = state(), p = participantPacket(s, "asha");
  const parsed = parseParticipantResponse(s, response(p));
  assert.equal(parsed.packet.memberId, "asha");
  assert.equal(parsed.packet.amountMinor, 6000);
  assert.equal(parsed.response.answer, "agree");
  for (const bad of [
    { projectId: "other-project" }, { revisionId: "prior" }, { ordinal: 99 },
    { amountMinor: 5999 }, { memberId: "missing" }, { answer: "automatic" },
    { createdAt: "yesterday" }, { note: "x".repeat(501) }
  ]) assert.throws(() => parseParticipantResponse(s, response(p, bad)));
  assert.throws(() => parseParticipantResponse(s, response(p).replace(/}$/, ',"extra":1}')), /recognized/);
  assert.throws(() => parseParticipantResponse(s, "{"));
  assert.throws(() => participantPacket(s, "not-here"), /not in/);
});

test("superseded response cannot be reused after a revision change", () => {
  const first = state(), packet = participantPacket(first, "asha");
  assert.throws(() => parseParticipantResponse(changed(), response(packet)), /different or retired proposal/);
});

test("recipient HTML escapes adversarial source text and includes no remote scripts", () => {
  const packet = participantPacket(state(), "asha");
  const evil = '</script><img src=x onerror=alert("x")>';
  const html = participantReviewHtml({
    ...packet, title: evil, memberName: evil, proposalNote: evil, items: [{ label: evil, amountMinor: 6000 }]
  });
  assert.equal(html.includes(evil), false);
  assert.ok(html.includes("&lt;/script&gt;"));
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<script src"), false);
  assert.equal(html.includes("connect-src 'none'"), true);
  assert.equal(html.includes('script id='), true);
});

test("sampled response is never a signed identity proof or a payment action", () => {
  const html = participantReviewHtml(participantPacket(state(), "asha"));
  assert.match(html, /not a signature/);
  assert.match(html, /does not authenticate/);
  assert.ok(html.includes("Nothing") === false || html.includes("money"));
  assert.doesNotMatch(html, /fetch\(|XMLHttpRequest|paypal\.com|localStorage|sessionStorage/);
});

test("same identifiers and total cannot reuse consent for changed private terms", () => {
  const original = state(), packet = participantPacket(original, "asha");
  for (const modify of [
    x => x.revision.items[0].label = "Non-refundable sponsorship",
    x => x.title = "Another purchase",
    x => x.revision.note = "No cancellations",
    x => x.revision.members[0].name = "Different recipient",
    x => x.revision.members[0].budgetMinor = 10000
  ]) {
    const fork = creation(); modify(fork);
    const current = replayProject(createProject(fork));
    assert.equal(participantPacket(current, "asha").amountMinor, packet.amountMinor);
    assert.throws(() => parseParticipantResponse(current, response(packet)), /reviewed terms differ/);
  }
  assert.throws(() => parseParticipantResponse(original, response(packet, {format:"clearinghouse-participant-response/v1"})), /Export a fresh/);
});

test("v3 proposed limits are exact cents and never agreement, including unknown and zero", () => {
  const input = creation(); input.revision.members[0].budgetMinor = null;
  const s = replayProject(createProject(input)), p = participantPacket(s, "asha");
  const before = JSON.stringify(s.project);
  const text = response(p, {format:"clearinghouse-participant-response/v3", answer:"propose-limit", proposedBudgetMinor:2550, note:"I can contribute this much."});
  const parsed = parseParticipantResponse(s,text);
  assert.equal(parsed.response.answer,"propose-limit");
  assert.equal(parsed.response.proposedBudgetMinor,2550);
  assert.equal(JSON.stringify(s.project),before);
  const draft=structuredClone(s.current);draft.members[1].name="My pending rename";draft.items[0].quantity=7;
  const snapshot=JSON.stringify(draft);
  const limit=participantLimitForDraft(s,text,draft);
  assert.equal(limit.budgetMinor,2550);assert.equal(limit.note,"I can contribute this much.");
  assert.equal(JSON.stringify(draft),snapshot);
  assert.equal(participantLimitForDraft(s,response(p,{format:"clearinghouse-participant-response/v3",answer:"propose-limit",proposedBudgetMinor:0}),draft).budgetMinor,0);
  assert.throws(()=>participantLimitForDraft(s,text,{...draft,members:draft.members.filter(m=>m.id!=="asha")}),/no longer/);
  assert.throws(()=>parseParticipantResponse(changed(),text),/different or retired/);
});
test("v3 malformed or contradictory proposed limits cannot become consent", () => {
  const s=state(),p=participantPacket(s,"asha");
  for(const value of [-1,1.5,null,"25.50",Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>parseParticipantResponse(s,response(p,{format:"clearinghouse-participant-response/v3",answer:"propose-limit",proposedBudgetMinor:value})));
  }
  for(const answer of ["agree","decline"]) {
    assert.throws(()=>parseParticipantResponse(s,response(p,{format:"clearinghouse-participant-response/v3",answer,proposedBudgetMinor:2500})));
    assert.equal(parseParticipantResponse(s,response(p,{format:"clearinghouse-participant-response/v3",answer,proposedBudgetMinor:null})).response.answer,answer);
  }
  assert.throws(()=>parseParticipantResponse(s,response(p,{answer:"propose-limit"})));
  assert.equal(parseParticipantResponse(s,response(p)).response.answer,"agree");
});
