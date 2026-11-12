// Model output is untrusted proposal data: it never approves a revision or moves money.
import { evaluateRevision } from "./core.mjs";
const record = v => v !== null && typeof v === "object" && !Array.isArray(v);
const same = (a,b) => a.size === b.size && [...b].every(id => a.has(id));
export class SuggestionError extends Error {}
export function validateSuggestion(revision, output) {
  const before = evaluateRevision(revision);
  if (!before.budgetsKnown) throw new SuggestionError("Confirm every spending limit before exploring a within-budget split.");
  if (!record(output) || !Array.isArray(output.itemWeights) || output.itemWeights.length !== revision.items.length)
    throw new SuggestionError("The model did not return a complete item-by-item split.");
  const memberIds = new Set(revision.members.map(m => m.id));
  const weights = new Map();
  for (const entry of output.itemWeights) {
    if (!record(entry) || typeof entry.itemId !== "string" || weights.has(entry.itemId) ||
        !Array.isArray(entry.weights) || entry.weights.length !== memberIds.size)
      throw new SuggestionError("The model returned an incomplete or duplicate item.");
    const perMember = new Map();
    for (const row of entry.weights) {
      if (!record(row) || !memberIds.has(row.memberId) || perMember.has(row.memberId) ||
          !Number.isSafeInteger(row.units) || row.units < 0)
        throw new SuggestionError("The model proposed an invalid participant or weight.");
      perMember.set(row.memberId, row.units);
    }
    if (!same(new Set(perMember.keys()), memberIds))
      throw new SuggestionError("Every item must include every current participant.");
    weights.set(entry.itemId, perMember);
  }
  if (!same(new Set(weights.keys()), new Set(revision.items.map(i=>i.id))))
    throw new SuggestionError("The model invented or omitted an item ID.");
  let changed = false;
  const candidate = {
    ...revision, members: revision.members.map(m=>({...m})),
    items: revision.items.map(item=>({...item,weights:item.weights.map(w=>{
      const units=weights.get(item.id).get(w.memberId);
      if (units!==w.units) changed=true;
      return {memberId:w.memberId,units};
    })}))
  };
  if (!changed) throw new SuggestionError("The model did not suggest a different split.");
  let after;
  try { after = evaluateRevision(candidate); }
  catch { throw new SuggestionError("The suggested weights fail the exact-cent allocation rules."); }
  if (!after.feasible || after.totalMinor!==before.totalMinor)
    throw new SuggestionError("The suggestion exceeds a budget or changes the purchase total.");
  const prior=new Map(before.members.map(m=>[m.id,m.amountMinor]));
  return {
    candidate,
    changes:after.members.map(m=>({memberId:m.id,name:m.name,beforeMinor:prior.get(m.id),
      afterMinor:m.amountMinor,deltaMinor:m.amountMinor-prior.get(m.id),budgetMinor:m.budgetMinor})),
    totalMinor:after.totalMinor,
    explanation:typeof output.explanation==="string"?output.explanation.trim().slice(0,1600):"",
    disclosure:"AI-proposed draft only. No consent, payment or revision was recorded."
  };
}
