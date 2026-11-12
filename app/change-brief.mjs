// Source-derived comparison of the latest two immutable, validated revisions.
// A briefing is not an approval, participant communication, or payment instruction.
import { evaluateRevision } from "./core.mjs";
import { formatUsdMinor as money } from "./ui-utils.mjs";

const byId = rows => new Map(rows.map(row => [row.id, row]));
const stableWeights = item => [...item.weights].sort((a,b)=>a.memberId < b.memberId ? -1 : a.memberId > b.memberId ? 1 : 0).map(w => `${w.memberId}:${w.units}`).join("|");
const esc = value => String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[char]);
const signed = minor => minor > 0 ? `+${money(minor)}` : money(minor);
const sumStatus = (amount, limit) => limit === null ? "Limit not provided; budget check unresolved" : amount > limit ? `Over by ${money(amount - limit)}` : "Within limit";

function activePriorDeclarations(project, revisionId) {
  const active = new Set();
  for (const event of project.events) {
    if (event.type === "approved" && event.revisionId === revisionId) active.add(event.memberId);
    if (event.type === "approval_withdrawn" && event.revisionId === revisionId) active.delete(event.memberId);
  }
  return active.size;
}

/** Compare a historical recorded revision against the current immutable proposal. */
export function changeBriefAgainstRevision(state, baselineOrdinal) {
  if (!state || state.revisions.length < 2) return null;
  if (!Number.isSafeInteger(baselineOrdinal) || baselineOrdinal >= state.current.ordinal)
    throw new RangeError("Comparison baseline must be an earlier recorded revision");
  const before = state.revisions.find(revision => revision.ordinal === baselineOrdinal), after = state.current;
  if (!before) throw new RangeError("Comparison baseline is not in this project");
  const beforeEval = evaluateRevision(before), afterEval = state.evaluation;
  const old = byId(beforeEval.members), next = byId(afterEval.members);
  // Current participants first, then departures in their former recorded order.
  const ids = [...after.members.map(m => m.id), ...before.members.filter(m => !next.has(m.id)).map(m => m.id)];
  const members = ids.map(id => {
    const first = old.get(id), last = next.get(id);
    const previousMinor = first?.amountMinor ?? 0, currentMinor = last?.amountMinor ?? 0;
    const transition = !first ? "joined" : !last ? "departed" : "continuing";
    const limitChanged = first && last && first.budgetMinor !== last.budgetMinor;
    const renamed = first && last && first.name !== last.name;
    return Object.freeze({ id, name: last?.name ?? first.name, previousName: first?.name ?? null,
      transition, previousMinor, currentMinor, deltaMinor: currentMinor - previousMinor,
      oldLimitMinor: first?.budgetMinor ?? null, limitMinor: last?.budgetMinor ?? null,
      limitChanged: Boolean(limitChanged), renamed: Boolean(renamed),
      previousStatus: first ? sumStatus(previousMinor, first.budgetMinor) : "Not a participant",
      currentStatus: last ? sumStatus(currentMinor, last.budgetMinor) : "Departed; no new obligation",
      currentDeclaration: last?.approved === true });
  });
  const oldItems = byId(before.items), newItems = byId(after.items);
  const oldAlloc = new Map(beforeEval.items.map(item => [item.itemId, item]));
  const newAlloc = new Map(afterEval.items.map(item => [item.itemId, item]));
  const itemIds = [...after.items.map(i => i.id), ...before.items.filter(i => !newItems.has(i.id)).map(i => i.id)];
  const items = itemIds.map(id => {
    const first = oldItems.get(id), last = newItems.get(id);
    const differences = !first ? ["added"] : !last ? ["removed"] : [
      ...(first.label === last.label ? [] : ["label"]),
      ...(first.quantity === last.quantity ? [] : ["quantity"]),
      ...(first.unitMinor === last.unitMinor ? [] : ["unit price"]),
      ...(stableWeights(first) === stableWeights(last) ? [] : ["split weights"])
    ];
    const previousMinor = oldAlloc.get(id)?.totalMinor ?? 0, currentMinor = newAlloc.get(id)?.totalMinor ?? 0;
    return Object.freeze({ id, label: last?.label ?? first.label, previousLabel: first?.label ?? null,
      previousMinor, currentMinor, deltaMinor: currentMinor - previousMinor,
      status: !first ? "added" : !last ? "removed" : differences.length ? "changed" : "unchanged",
      differences: Object.freeze(differences) });
  });
  const activeRetired = activePriorDeclarations(state.project, before.revisionId);
  return Object.freeze({ projectId: state.project.projectId, title: state.project.title,
    before: Object.freeze({ ordinal: before.ordinal, revisionId: before.revisionId, note: before.note, totalMinor: beforeEval.totalMinor }),
    after: Object.freeze({ ordinal: after.ordinal, revisionId: after.revisionId, note: after.note, totalMinor: afterEval.totalMinor }),
    deltaMinor: afterEval.totalMinor - beforeEval.totalMinor, feasible: afterEval.feasible, budgetsKnown: afterEval.budgetsKnown,
    currentDeclarations: state.approvals.length, requiredDeclarations: after.members.length,
    retiredActiveDeclarations: activeRetired, members: Object.freeze(members), items: Object.freeze(items) });
}

/** Preserve the existing latest-two-revisions entry point for other consumers. */
export function latestChangeBrief(state) {
  if (!state || state.revisions.length < 2) return null;
  return changeBriefAgainstRevision(state, state.revisions.at(-2).ordinal);
}

/** An intentionally inert, self-contained printable brief; this is not signed consent. */
export function changeBriefHtml(brief) {
  if (!brief) throw new TypeError("At least two revisions are required");
  const personRows = brief.members.map(m => `<tr><th scope="row">${esc(m.name)}<small>${esc(m.id)} · ${esc(m.transition)}${m.renamed ? ` · formerly ${esc(m.previousName)}` : ""}</small></th><td>${money(m.previousMinor)}</td><td>${money(m.currentMinor)}</td><td>${signed(m.deltaMinor)}</td><td>${esc(m.currentStatus)}${m.limitChanged ? " · limit changed" : ""}</td><td>${m.currentDeclaration ? "Recorded locally" : "Not recorded"}</td></tr>`).join("\n");
  const itemRows = brief.items.map(i => `<tr><th scope="row">${esc(i.label)}<small>${esc(i.id)} · ${esc(i.status)}${i.previousLabel !== null && i.previousLabel !== i.label ? ` · formerly ${esc(i.previousLabel)}` : ""}</small></th><td>${money(i.previousMinor)}</td><td>${money(i.currentMinor)}</td><td>${signed(i.deltaMinor)}</td><td>${esc(i.differences.join(", ") || "No input change")}</td></tr>`).join("\n");
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${esc(brief.title)} — revision ${brief.after.ordinal} change brief</title><style>
  :root{color-scheme:light;font-family:system-ui,sans-serif;color:#17241e;background:#f3f5ef}*{box-sizing:border-box}body{max-width:1100px;margin:auto;padding:clamp(1rem,4vw,3rem)}h1{font-family:Georgia,serif;font-size:clamp(2rem,5vw,3rem)}.tag{font-weight:700;color:#326346;text-transform:uppercase;letter-spacing:.1em}.note{padding:1rem;border-left:5px solid #99700b;background:#fff1c6;line-height:1.55}.stats{display:flex;flex-wrap:wrap;gap:1rem}.stats p{padding:.8rem 1rem;border:1px solid #cbd6cd;border-radius:.5rem;background:#fff}section{margin:2rem 0}.scroll{overflow-x:auto}table{width:100%;min-width:680px;border-collapse:collapse;background:#fff}th,td{padding:.7rem;text-align:left;border:1px solid #d8dfd8}thead{background:#deeadf}small{display:block;font-weight:400;font-size:.8em;color:#50645c;overflow-wrap:anywhere}.fine{color:#53655b;font-size:.9rem}h2{font-family:Georgia,serif}@media print{body{padding:0;background:#fff}.scroll{overflow:visible}table{min-width:0}thead{display:table-header-group}tr{break-inside:avoid}}
  </style></head><body><p class="tag">CLEARINGHOUSE / portable change brief</p><h1>${esc(brief.title)}</h1><p><strong>R${brief.before.ordinal} → R${brief.after.ordinal}</strong> · ${esc(brief.after.note)}</p><p class="note"><strong>Local planning record only.</strong> This document does not authenticate any person, establish consent, or authorize/capture/transfer/refund money. It can be edited and is not signed. Every revision requires fresh explicit declarations. ${brief.retiredActiveDeclarations} active declaration(s) on R${brief.before.ordinal} remain historical; none authorize R${brief.after.ordinal}; ${brief.currentDeclarations} of ${brief.requiredDeclarations} new local declarations currently recorded. ${brief.feasible ? "The new draft meets its declared budget limits." : brief.budgetsKnown === false ? "At least one spending limit is not provided. The new proposal cannot receive approval declarations until every limit is confirmed." : "The new proposal exceeds at least one declared budget limit and cannot receive approval declarations."}</p><div class="stats"><p>Previous proposed total<br><strong>${money(brief.before.totalMinor)}</strong></p><p>Current proposed total<br><strong>${money(brief.after.totalMinor)}</strong></p><p>Change<br><strong>${signed(brief.deltaMinor)}</strong></p></div><section><h2>Each person's proposed obligation</h2><div class="scroll"><table><thead><tr><th>Participant</th><th>Before</th><th>After</th><th>Difference</th><th>New budget status</th><th>New declaration</th></tr></thead><tbody>${personRows}</tbody></table></div></section><section><h2>Items and changes</h2><div class="scroll"><table><thead><tr><th>Item</th><th>Before</th><th>After</th><th>Difference</th><th>Edited inputs</th></tr></thead><tbody>${itemRows}</tbody></table></div></section><p class="fine">Project ID: ${esc(brief.projectId)}. Source revisions: ${esc(brief.before.revisionId)} → ${esc(brief.after.revisionId)}. This is a summary of the selected historical and current validated, immutable recorded revisions, not a replacement for the full event history. Declarations are recorded by a single local operator, not verified participant signatures.</p></body></html>`;
}
