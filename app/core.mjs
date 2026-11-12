const FORMAT = "clearinghouse-project/v1";
const POLICY = "largest-remainder-by-member-id/v1";
const LIMITS = Object.freeze({ bytes: 2_000_000, events: 1000, members: 50, items: 200, text: 200, note: 2000 });
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class DomainError extends Error {
  constructor(code, message) { super(message); this.name = "DomainError"; this.code = code; }
}

const fail = (code, message) => { throw new DomainError(code, message); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, keys, where) => {
  if (!plain(value)) fail("invalid_shape", `${where} must be an object`);
  const got = Object.keys(value).sort();
  const wanted = [...keys].sort();
  if (got.length !== wanted.length || got.some((key, i) => key !== wanted[i])) fail("unknown_or_missing_field", `${where} fields must be exactly: ${wanted.join(", ")}`);
};
const string = (value, where, max = LIMITS.text) => {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) fail("invalid_text", `${where} must be 1-${max} characters`);
  return value;
};
const id = (value, where) => { if (typeof value !== "string" || !ID.test(value)) fail("invalid_id", `${where} must be a stable ASCII ID`); return value; };
const integer = (value, where, min = 0) => {
  if (!Number.isSafeInteger(value) || value < min) fail("invalid_integer", `${where} must be a safe integer at least ${min}`);
  return value;
};
const time = (value, where) => {
  const parsed = typeof value === "string" ? new Date(value) : null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) fail("invalid_time", `${where} must be a canonical UTC timestamp`);
  return value;
};
const denseArray = (value, where) => {
  if (!Array.isArray(value)) fail("invalid_shape", `${where} must be an array`);
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) fail("invalid_shape", `${where} must be a dense ordinary array`);
  return value;
};
const asciiCompare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const clone = value => JSON.parse(JSON.stringify(value));
const deepFreeze = value => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
};

function validateMembers(members, where) {
  denseArray(members, where);
  if (members.length < 1 || members.length > LIMITS.members) fail("invalid_members", `${where} must contain 1-${LIMITS.members} members`);
  const seen = new Set();
  return members.map((member, index) => {
    exactKeys(member, ["id", "name", "budgetMinor"], `${where}[${index}]`);
    const memberId = id(member.id, `${where}[${index}].id`);
    if (seen.has(memberId)) fail("duplicate_id", `duplicate member ID ${memberId}`);
    seen.add(memberId);
    return { id: memberId, name: string(member.name, `${where}[${index}].name`), budgetMinor: member.budgetMinor === null ? null : integer(member.budgetMinor, `${where}[${index}].budgetMinor`) };
  });
}

function validateItems(items, memberIds, where) {
  denseArray(items, where);
  if (items.length < 1 || items.length > LIMITS.items) fail("invalid_items", `${where} must contain 1-${LIMITS.items} items`);
  const seen = new Set();
  return items.map((item, index) => {
    exactKeys(item, ["id", "label", "unitMinor", "quantity", "weights"], `${where}[${index}]`);
    const itemId = id(item.id, `${where}[${index}].id`);
    if (seen.has(itemId)) fail("duplicate_id", `duplicate item ID ${itemId}`);
    seen.add(itemId);
    integer(item.unitMinor, `${where}[${index}].unitMinor`);
    integer(item.quantity, `${where}[${index}].quantity`, 1);
    if (item.unitMinor !== 0 && item.quantity > Math.floor(Number.MAX_SAFE_INTEGER / item.unitMinor)) fail("overflow", `${where}[${index}] total is unsafe`);
    denseArray(item.weights, `${where}[${index}].weights`);
    if (item.weights.length !== memberIds.size) fail("invalid_weights", `${where}[${index}].weights must contain every member exactly once`);
    const weightIds = new Set();
    const weights = item.weights.map((weight, weightIndex) => {
      exactKeys(weight, ["memberId", "units"], `${where}[${index}].weights[${weightIndex}]`);
      const memberId = id(weight.memberId, `${where}[${index}].weights[${weightIndex}].memberId`);
      if (!memberIds.has(memberId)) fail("unknown_member", `${where}[${index}] references unknown member ${memberId}`);
      if (weightIds.has(memberId)) fail("duplicate_id", `${where}[${index}] repeats member ${memberId}`);
      weightIds.add(memberId);
      return { memberId, units: integer(weight.units, `${where}[${index}].weights[${weightIndex}].units`) };
    });
    const totalWeight = weights.reduce((sum, weight) => sum + weight.units, 0);
    if (!Number.isSafeInteger(totalWeight) || totalWeight < 1) fail("invalid_weights", `${where}[${index}] must have a positive total weight`);
    return { id: itemId, label: string(item.label, `${where}[${index}].label`), unitMinor: item.unitMinor, quantity: item.quantity, weights };
  });
}

function validateRevision(revision, expectedOrdinal, where) {
  exactKeys(revision, ["ordinal", "revisionId", "createdAt", "note", "policy", "members", "items"], where);
  integer(revision.ordinal, `${where}.ordinal`, 1);
  if (revision.ordinal !== expectedOrdinal) fail("revision_sequence", `${where}.ordinal must be ${expectedOrdinal}`);
  id(revision.revisionId, `${where}.revisionId`);
  time(revision.createdAt, `${where}.createdAt`);
  if (typeof revision.note !== "string" || revision.note.length > LIMITS.note) fail("invalid_text", `${where}.note is too long`);
  if (revision.policy !== POLICY) fail("unsupported_policy", `${where}.policy is unsupported`);
  const members = validateMembers(revision.members, `${where}.members`);
  const items = validateItems(revision.items, new Set(members.map(member => member.id)), `${where}.items`);
  return { ordinal: revision.ordinal, revisionId: revision.revisionId, createdAt: revision.createdAt, note: revision.note, policy: POLICY, members, items };
}

function validateEventEnvelope(event, sequence, seenIds, where) {
  if (!plain(event)) fail("invalid_shape", `${where} must be an object`);
  integer(event.sequence, `${where}.sequence`, 1);
  if (event.sequence !== sequence) fail("event_sequence", `${where}.sequence must be ${sequence}`);
  id(event.eventId, `${where}.eventId`);
  if (seenIds.has(event.eventId)) fail("duplicate_id", `duplicate event ID ${event.eventId}`);
  seenIds.add(event.eventId);
  time(event.at, `${where}.at`);
}

export function allocateItem(item) {
  const total = BigInt(item.unitMinor) * BigInt(item.quantity);
  const positive = item.weights.filter(weight => weight.units > 0);
  const totalWeight = positive.reduce((sum, weight) => sum + BigInt(weight.units), 0n);
  if (totalWeight < 1n) fail("invalid_weights", `item ${item.id} must have positive total weight`);
  const rows = item.weights.map(weight => {
    const numerator = total * BigInt(weight.units);
    return { memberId: weight.memberId, minor: numerator / totalWeight, remainder: numerator % totalWeight };
  });
  let leftovers = total - rows.reduce((sum, row) => sum + row.minor, 0n);
  const ranked = rows.filter(row => row.remainder > 0n).sort((a, b) => a.remainder === b.remainder ? asciiCompare(a.memberId, b.memberId) : a.remainder > b.remainder ? -1 : 1);
  for (let index = 0; leftovers > 0n; index += 1, leftovers -= 1n) ranked[index].minor += 1n;
  return rows.map(row => ({ memberId: row.memberId, minor: Number(row.minor) })).sort((a, b) => asciiCompare(a.memberId, b.memberId));
}

export function evaluateRevision(revision, approvals = new Set()) {
  // Draft previews and Budget Rescue receive editable inputs, unlike replay's
  // already validated revisions. Use the recording contract before calculating.
  return evaluateValidatedRevision(validateRevision(revision, revision?.ordinal, "revision"), approvals);
}

function evaluateValidatedRevision(revision, approvals = new Set()) {
  const totals = new Map(revision.members.map(member => [member.id, 0]));
  const items = revision.items.map(item => {
    const allocations = allocateItem(item);
    for (const allocation of allocations) {
      const next = totals.get(allocation.memberId) + allocation.minor;
      if (!Number.isSafeInteger(next)) fail("overflow", "project total is unsafe");
      totals.set(allocation.memberId, next);
    }
    return { itemId: item.id, totalMinor: item.unitMinor * item.quantity, allocations };
  });
  const members = revision.members.map(member => {
    const amountMinor = totals.get(member.id);
    return { id: member.id, name: member.name, budgetMinor: member.budgetMinor, amountMinor, overMinor: member.budgetMinor === null ? null : Math.max(0, amountMinor - member.budgetMinor), budgetStatus: member.budgetMinor === null ? "unknown" : amountMinor > member.budgetMinor ? "over" : "within", approved: approvals.has(member.id) };
  });
  const totalMinor = items.reduce((sum, item) => sum + item.totalMinor, 0);
  if (!Number.isSafeInteger(totalMinor)) fail("overflow", "project total is unsafe");
  const budgetsKnown = members.every(member => member.budgetMinor !== null);
  const feasible = budgetsKnown && members.every(member => member.overMinor === 0);
  const allApproved = members.every(member => member.approved);
  return deepFreeze({ totalMinor, items, members, budgetsKnown, feasible, allApproved, agreementRecorded: feasible && allApproved, executedMinor: 0, paymentState: "not-executing" });
}

export function replayProject(project) {
  exactKeys(project, ["format", "projectId", "title", "currency", "events"], "project");
  if (project.format !== FORMAT) fail("unsupported_format", `format must be ${FORMAT}`);
  const projectId = id(project.projectId, "project.projectId");
  const title = string(project.title, "project.title");
  if (project.currency !== "USD") fail("unsupported_currency", "only USD is supported in this release");
  denseArray(project.events, "project.events");
  if (project.events.length < 1 || project.events.length > LIMITS.events) fail("invalid_events", `project.events must contain 1-${LIMITS.events} events`);
  const seenIds = new Set();
  const revisionIds = new Set();
  const revisions = [];
  const approvals = new Set();
  const normalizedEvents = [];
  let current = null;
  project.events.forEach((event, index) => {
    const where = `project.events[${index}]`;
    validateEventEnvelope(event, index + 1, seenIds, where);
    if (event.type === "created" || event.type === "amended") {
      exactKeys(event, ["sequence", "eventId", "at", "type", "expectedRevision", "revision"], where);
      if (event.type === "created" && index !== 0) fail("invalid_transition", "created must be the first and only creation event");
      if (event.type === "amended" && current === null) fail("invalid_transition", "amended requires an existing project revision");
      const wanted = event.type === "created" ? 0 : current?.ordinal;
      if (event.expectedRevision !== wanted) fail("stale_revision", `${where} expected revision ${String(wanted)}`);
      const revision = validateRevision(event.revision, revisions.length + 1, `${where}.revision`);
      evaluateValidatedRevision(revision);
      if (revisionIds.has(revision.revisionId)) fail("duplicate_id", `duplicate revision ID ${revision.revisionId}`);
      revisionIds.add(revision.revisionId);
      current = revision;
      revisions.push(revision);
      approvals.clear();
      normalizedEvents.push({ ...event, revision });
    } else if (event.type === "approved" || event.type === "approval_withdrawn") {
      exactKeys(event, ["sequence", "eventId", "at", "type", "projectId", "revisionId", "memberId"], where);
      if (event.projectId !== projectId) fail("wrong_project", `${where} targets another project`);
      if (!current || event.revisionId !== current.revisionId) fail("stale_revision", `${where} targets a stale revision`);
      id(event.memberId, `${where}.memberId`);
      if (!current.members.some(member => member.id === event.memberId)) fail("unknown_member", `${where} targets a nonmember`);
      if (event.type === "approved") {
        const evaluated = evaluateValidatedRevision(current);
        if (!evaluated.budgetsKnown) fail("unknown_limits", "Confirm every spending limit before recording approval declarations.");
        if (!evaluated.feasible) fail("infeasible", "an infeasible revision cannot receive approval declarations");
        if (approvals.has(event.memberId)) fail("duplicate_transition", `${event.memberId} is already approved`);
        approvals.add(event.memberId);
      } else {
        if (!approvals.has(event.memberId)) fail("duplicate_transition", `${event.memberId} has no current approval to withdraw`);
        approvals.delete(event.memberId);
      }
      normalizedEvents.push({ ...event });
    } else fail("unsupported_event", `${where}.type is unsupported`);
  });
  const normalized = deepFreeze({ format: FORMAT, projectId, title, currency: "USD", events: normalizedEvents });
  if (new TextEncoder().encode(JSON.stringify(normalized, null, 2)).length > LIMITS.bytes) fail("too_large", "project exceeds the portable 2,000,000-byte export limit");
  return deepFreeze({ project: normalized, revisions: deepFreeze(revisions), current, approvals: deepFreeze([...approvals].sort()), evaluation: evaluateValidatedRevision(current, approvals), sequence: normalizedEvents.length });
}

function append(project, expected, event) {
  const state = replayProject(project);
  if (expected.projectId !== state.project.projectId || expected.revisionId !== state.current.revisionId || expected.revisionFingerprint !== JSON.stringify(state.current) || expected.sequence !== state.sequence) fail("stale_action", `action expected ${expected.revisionId} at sequence ${expected.sequence}; current is ${state.current.revisionId} at sequence ${state.sequence}`);
  const next = clone(state.project); next.events.push(event); return replayProject(next).project;
}

export function createProject({ projectId, title, eventId, at, revision }) {
  return replayProject({ format: FORMAT, projectId, title, currency: "USD", events: [{ sequence: 1, eventId, at, type: "created", expectedRevision: 0, revision }] }).project;
}
export function amendProject(project, expected, { eventId, at, revision }) {
  return append(project, expected, { sequence: expected.sequence + 1, eventId, at, type: "amended", expectedRevision: expected.ordinal, revision });
}
export function approveProject(project, expected, { eventId, at, memberId }) {
  return append(project, expected, { sequence: expected.sequence + 1, eventId, at, type: "approved", projectId: expected.projectId, revisionId: expected.revisionId, memberId });
}
export function withdrawApproval(project, expected, { eventId, at, memberId }) {
  return append(project, expected, { sequence: expected.sequence + 1, eventId, at, type: "approval_withdrawn", projectId: expected.projectId, revisionId: expected.revisionId, memberId });
}
export function expectedState(project) { const s = replayProject(project); return { projectId: s.project.projectId, revisionId: s.current.revisionId, revisionFingerprint: JSON.stringify(s.current), ordinal: s.current.ordinal, sequence: s.sequence }; }
export function exportProject(project) { const normalized = replayProject(project).project; const text = JSON.stringify(normalized, null, 2); if (new TextEncoder().encode(text).length > LIMITS.bytes) fail("too_large", "project export exceeds 2,000,000 UTF-8 bytes"); return text; }
export function importProject(text) { if (typeof text !== "string" || new TextEncoder().encode(text).length > LIMITS.bytes) fail("too_large", "project import exceeds 2,000,000 UTF-8 bytes"); let value; try { value = JSON.parse(text); } catch { fail("invalid_json", "project is not valid JSON"); } return replayProject(value).project; }
export const constants = deepFreeze({ FORMAT, POLICY, LIMITS });
