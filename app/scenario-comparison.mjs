import { evaluateRevision } from "./core.mjs";

// Alternatives never enter the append-only agreement or payment registry.
const key = token => JSON.stringify([token.session, token.projectId, token.sequence, token.revisionFingerprint]);
export function validateSavedScenarios(entries, projectId) {
  if (!Array.isArray(entries) || entries.length > 6) throw new Error("The saved purchase options could not be read.");
  const ids = new Set();
  for (const entry of entries) {
    if (!entry || !Number.isSafeInteger(entry.id) || entry.id < 1 || ids.has(entry.id) ||
        typeof entry.name !== "string" || !entry.name.trim() || entry.name.length > 80 ||
        !Array.isArray(entry.base) || entry.base.length !== 3 ||
        entry.base[0] !== projectId || !Number.isSafeInteger(entry.base[1]) || entry.base[1] < 1 ||
        typeof entry.base[2] !== "string" || !entry.base[2])
      throw new Error("The saved purchase options do not match this plan.");
    evaluateRevision(entry.revision);
    ids.add(entry.id);
  }
  return structuredClone(entries);
}

export class ScenarioComparison {
  #entries = [];
  #serial = 0;
  #session = null;
  sync(token) {
    if (this.#session !== token.session) { this.#entries = []; this.#session = token.session; }
  }
  list(token) {
    this.sync(token);
    return this.#entries.map(entry => ({ ...structuredClone(entry), stale: entry.base !== key(token) }));
  }
  pin(name, revision, token) {
    this.sync(token);
    const label = name.trim();
    if (!label || label.length > 80) throw new Error("Name this option using 1–80 characters.");
    evaluateRevision(revision);
    if (this.#entries.length >= 6) throw new Error("Keep up to six options. Remove one before adding another.");
    const entry = { id: ++this.#serial, name: label, revision: structuredClone(revision), base: key(token) };
    this.#entries.push(entry);
    return entry.id;
  }
  snapshot(token) {
    this.sync(token);
    return this.#entries.map(entry => ({...structuredClone(entry), base:JSON.parse(entry.base).slice(1)}));
  }
  restore(entries, token) {
    const saved = validateSavedScenarios(entries, token.projectId);
    this.#entries = saved.map(entry => ({...entry, base:JSON.stringify([token.session, ...entry.base])}));
    this.#session = token.session;
    this.#serial = Math.max(0, ...saved.map(entry => entry.id));
  }
  remove(id) { this.#entries = this.#entries.filter(entry => entry.id !== id); }
  copy(id, token) {
    const entry = this.list(token).find(entry => entry.id === id);
    if (!entry || entry.stale) throw new Error("The recorded agreement changed. Keep this option for comparison, but build a fresh draft from the current revision.");
    return structuredClone(entry.revision);
  }
}

export function compareScenarios(current, entries) {
  const revisions = [current, ...entries.map(entry => entry.revision)];
  const evaluations = revisions.map(revision => evaluateRevision(revision));
  const members = new Map();
  for (const revision of revisions) for (const member of revision.members) if (!members.has(member.id)) members.set(member.id, member.name);
  return {
    totals: evaluations.map(evaluation => evaluation.totalMinor),
    people: [...members].map(([id, name]) => ({
      id, name,
      values: evaluations.map((evaluation, index) => {
        const member = evaluation.members.find(person => person.id === id);
        const original = evaluations[0].members.find(person => person.id === id);
        return { present: Boolean(member), name: member?.name ?? name, amountMinor: member?.amountMinor ?? 0, deltaMinor: (member?.amountMinor ?? 0) - (original?.amountMinor ?? 0), overMinor: member?.overMinor ?? 0, budgetMinor: member?.budgetMinor ?? null };
      })
    }))
  };
}
