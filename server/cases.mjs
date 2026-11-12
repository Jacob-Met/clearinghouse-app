// Cases: two people agree what is owed from the evidence they already have, then settle it through
// the existing PayPal Sandbox path. State is in memory (a case is a short-lived negotiation).
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createProject, approveProject, expectedState, exportProject, constants } from "../app/core.mjs";
import { readText, readImageWithModel, transcribe, parseDollars } from "./case-reader.mjs";
import { seedCases } from "./case-seed.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "cases");
const files = new Map([["/cases", ["cases.html", "text/html; charset=utf-8"]], ["/cases.mjs", ["cases.mjs", "text/javascript; charset=utf-8"]], ["/cases.css", ["cases.css", "text/css; charset=utf-8"]]]);
const store = new Map();
let seeded = false;
const uid = p => p + "-" + randomBytes(4).toString("hex");
const other = s => (s === "a" ? "b" : "a");
const money = m => (m < 0 ? "-" : "") + "$" + (Math.abs(m) / 100).toFixed(2);

export const statusOf = f => f.replaced ? "replaced" : f.votes.a === "yes" && f.votes.b === "yes" ? "agreed" : f.votes.a === "no" || f.votes.b === "no" ? "disputed" : "unknown";
const owedBy = f => f.kind === "repay" ? f.amountMinor : f.amountMinor - Math.round(f.amountMinor * f.splitPct / 100);
export const deltaOf = f => (f.paidBy === "a" ? 1 : -1) * owedBy(f); // positive: a is owed by b

function settlementOf(c) {
  const counted = c.facts.filter(f => statusOf(f) === "agreed").sort((x, y) => x.date.localeCompare(y.date));
  const lines = counted.map(f => {
    const payer = c.names[f.paidBy], o = c.names[other(f.paidBy)];
    const text = f.kind === "repay" ? `${payer} paid ${o} back ${money(f.amountMinor)}` : `${payer} paid ${money(f.amountMinor)} for ${f.what.toLowerCase()}, ${o}'s half`;
    return { factId: f.id, date: f.date, text, deltaMinor: deltaOf(f) };
  });
  const net = lines.reduce((s, l) => s + l.deltaMinor, 0);
  const pending = c.facts.filter(f => ["unknown", "disputed"].includes(statusOf(f)) && f.kind !== "note");
  const payer = net > 0 ? "b" : net < 0 ? "a" : null;
  return { lines, netMinor: net, amountMinor: Math.abs(net), payer, payee: payer && other(payer), pendingCount: pending.length,
    pendingMinor: pending.reduce((s, f) => s + owedBy(f), 0) };
}

// Whose turn it is on one fact.
function turnOf(f) {
  const s = statusOf(f);
  if (s === "unknown") return f.votes.a === null ? "a" : "b";
  if (s === "disputed") {
    const last = f.answers.at(-1);
    if (last) return other(last.side);
    return f.votes.a === "no" ? other("a") : other("b");
  }
  return null;
}

export function marksOf(c) {
  if (c.settled) return { a: "settled", b: "settled" };
  const s = settlementOf(c), out = {};
  for (const side of ["a", "b"]) {
    const pendingMine = c.facts.some(f => turnOf(f) === side), pendingTheirs = c.facts.some(f => turnOf(f) === other(side));
    if (pendingMine) out[side] = "you";
    else if (pendingTheirs) out[side] = "them";
    else if (s.lines.length === 0) out[side] = "them";
    else if (!c.accepted[side]) out[side] = "you";
    else if (!c.accepted[other(side)]) out[side] = "them";
    else out[side] = s.payer === side ? "you" : "them";
  }
  return out;
}

function buildProject(c, s) {
  const stamp = createHash("sha256").update(JSON.stringify([c.id, s.lines.map(l => [l.factId, l.deltaMinor]), s.payer])).digest("hex").slice(0, 10);
  const at = c.agreedAt;
  const revision = { ordinal: 1, revisionId: "rev-" + stamp, createdAt: at, note: "Agreed settlement for " + c.title.slice(0, 80), policy: constants.POLICY,
    members: [{ id: s.payer, name: c.names[s.payer], budgetMinor: s.amountMinor }],
    items: [{ id: "owed", label: "Agreed settlement", unitMinor: s.amountMinor, quantity: 1, weights: [{ memberId: s.payer, units: 1 }] }] };
  let p = createProject({ projectId: "case-" + c.id + "-" + stamp, title: c.title.slice(0, 120), eventId: "evt-created", at, revision });
  p = approveProject(p, expectedState(p), { eventId: "evt-approved", at, memberId: s.payer });
  return exportProject(p);
}

function view(c) {
  const s = settlementOf(c), ready = !c.settled && s.amountMinor > 0 && c.accepted.a && c.accepted.b && s.pendingCount === 0;
  return { id: c.id, title: c.title, names: c.names, me: c.me, settled: c.settled, accepted: c.accepted, marks: marksOf(c), evidence: c.evidence.map(e => ({ ...e })),
    samples: c.samples.filter(x => !x.used).map(x => ({ id: x.id, side: x.side, kind: x.kind, label: x.label })),
    facts: c.facts.map(f => ({ ...f, status: statusOf(f), turn: turnOf(f), deltaMinor: deltaOf(f), owedMinor: owedBy(f) })).sort((x, y) => x.date.localeCompare(y.date)),
    settlement: { ...s, ready, project: ready ? buildProject(c, s) : null } };
}
const summary = c => { const s = settlementOf(c); return { id: c.id, title: c.title, names: c.names, me: c.me, marks: marksOf(c), settled: c.settled, amountMinor: s.amountMinor, payer: s.payer, facts: c.facts.length, evidence: c.evidence.length }; };

function resetAcceptance(c) { c.accepted = { a: false, b: false }; c.agreedAt = null; }
function afterChange(c) {
  for (const f of c.facts) if (f.conflictWith && statusOf(f) === "agreed") { const o = c.facts.find(x => x.id === f.conflictWith); if (o && statusOf(o) !== "agreed") o.replaced = true; }
  resetAcceptance(c);
}

function addFacts(c, side, evidenceId, facts) {
  const added = [];
  for (const raw of facts) {
    const same = c.facts.find(f => !f.replaced && f.date === raw.date && f.kind === raw.kind && f.paidBy === raw.paidBy && f.amountMinor === raw.amountMinor);
    if (same) { same.sources.push({ evidenceId, quote: raw.quote }); if (same.votes[side] === null) same.votes[side] = "yes"; added.push(same.id); continue; }
    const clash = c.facts.find(f => !f.replaced && f.kind === raw.kind && f.date === raw.date && f.paidBy === raw.paidBy && f.amountMinor !== raw.amountMinor && raw.kind === "cost" && f.votes[side] === null);
    const fact = { id: uid("f"), date: raw.date, what: raw.what, kind: raw.kind, paidBy: raw.paidBy, amountMinor: raw.amountMinor, splitPct: raw.splitPct ?? 50,
      sources: [{ evidenceId, quote: raw.quote }], by: side, votes: { a: null, b: null }, answers: [] };
    fact.votes[side] = "yes";
    if (clash) { clash.votes[side] = "no"; clash.answers.push({ side, text: `My record shows ${money(raw.amountMinor)}, not ${money(clash.amountMinor)}.`, at: new Date().toISOString() }); fact.conflictWith = clash.id; clash.conflictWith = fact.id; }
    c.facts.push(fact); added.push(fact.id);
  }
  return added;
}

async function addEvidence(c, body) {
  const side = body.side === "b" ? "b" : "a", ctx = { names: c.names, side, today: new Date() };
  const ev = { id: uid("e"), side, kind: body.kind, name: String(body.name || "").slice(0, 80), at: new Date().toISOString(), readBy: "", note: "" };
  let facts = [];
  if (body.sampleId) {
    const sm = c.samples.find(x => x.id === body.sampleId && !x.used);
    if (!sm) throw Object.assign(new Error("That sample was already added."), { status: 409 });
    sm.used = true; Object.assign(ev, { side: sm.side, kind: sm.kind === "voice" ? "audio" : sm.kind, name: sm.label, image: sm.image, text: sm.text, transcript: sm.transcript });
    ctx.side = sm.side;
    if (sm.facts) { facts = sm.facts.map(f => ({ splitPct: 50, ...f })); ev.readBy = "sample reading"; }
    else { const r = await readText(sm.text || sm.transcript, ctx); facts = r.facts; ev.readBy = r.by; }
  } else if (body.kind === "text") {
    const text = String(body.text || "").trim().slice(0, 8000);
    if (!text) throw Object.assign(new Error("Paste some words first."), { status: 400 });
    ev.text = text; const r = await readText(text, ctx); facts = r.facts; ev.readBy = r.by;
  } else if (body.kind === "image") {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(body.mime || "") || typeof body.data !== "string" || body.data.length > 9_000_000) throw Object.assign(new Error("Add a PNG, JPEG or WebP photo under 6 MB."), { status: 400 });
    ev.image = `data:${body.mime};base64,${body.data}`;
    try { facts = await readImageWithModel(body.data, ctx); ev.readBy = "local vision model"; }
    catch { ev.note = "The picture could not be read automatically here. Tell us what it shows below."; }
    if (typeof body.caption === "string" && body.caption.trim() && !facts.length) { const r = await readText(body.caption, ctx); facts = r.facts; ev.readBy = r.by + " (from your words)"; ev.text = body.caption.trim().slice(0, 600); }
  } else if (body.kind === "audio") {
    if (typeof body.data !== "string" || body.data.length > 28_000_000) throw Object.assign(new Error("That recording is too large."), { status: 400 });
    let text = "";
    try { text = await transcribe(Buffer.from(body.data, "base64")); } catch { /* speech-to-text not running */ }
    if (!text && typeof body.caption === "string") text = body.caption.trim();
    if (!text) { ev.note = "Speech-to-text is not running here. Type what the recording says and add it as words."; }
    else { ev.transcript = text; const r = await readText(text, ctx); facts = r.facts; ev.readBy = "speech-to-text, " + r.by; }
  } else throw Object.assign(new Error("Unknown kind of evidence."), { status: 400 });
  c.evidence.push(ev);
  const ids = addFacts(c, ev.side, ev.id, facts);
  ev.factIds = ids;
  if (!ids.length && !ev.note) ev.note = "Nothing with a dollar amount was found in this piece.";
  afterChange(c);
  return ev;
}

function vote(c, f, body) {
  const side = body.side === "b" ? "b" : "a", text = String(body.text || "").trim().slice(0, 500), v = body.vote === "no" ? "no" : "yes";
  const amended = text ? parseDollars(text) : null;
  if (text) f.answers.push({ side, text, at: new Date().toISOString() });
  if (amended !== null && amended !== f.amountMinor && amended > 0) {
    f.answers.push({ side, text: `Amount changed to ${money(amended)} (was ${money(f.amountMinor)}).`, at: new Date().toISOString(), system: true });
    f.amountMinor = amended; f.votes = { a: null, b: null }; f.votes[side] = "yes";
  } else f.votes[side] = v;
  afterChange(c);
}

async function readBody(req) {
  let n = 0; const chunks = [];
  for await (const ch of req) { n += ch.length; if (n > 40_000_000) throw Object.assign(new Error("Too large."), { status: 413 }); chunks.push(ch); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw Object.assign(new Error("Bad JSON."), { status: 400 }); }
}
const send = (res, status, body, type = "application/json; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

// Returns true when the request belonged to Cases.
export async function handleCases(req, res, url, { transformHtml = h => h } = {}) {
  const p = url.pathname;
  if (!seeded) { seeded = true; if (process.env.CLEARINGHOUSE_CASES_DEMO === "1") for (const c of seedCases()) store.set(c.id, c); }
  if (req.method === "GET" && files.has(p)) {
    const [file, type] = files.get(p);
    let body = await readFile(join(root, file), "utf8");
    if (file.endsWith(".html") && process.env.CLEARINGHOUSE_CASES_DEMO === "1") body = body.replace("</head>", '<link rel="stylesheet" href="/demo-badge.css"><script src="/demo-badge.js" defer></script></head>');
    else if (file.endsWith(".html")) body = transformHtml(body);
    send(res, 200, body, type); return true;
  }
  if (!p.startsWith("/api/cases")) return false;
  const host = req.headers.host || "";
  if (req.method !== "GET" && (!/^((127[.]0[.]0[.]1)|localhost):[0-9]{1,5}$/.test(host) || (req.headers.origin && req.headers.origin !== "http://" + host))) { send(res, 403, { message: "Local origin only." }); return true; }
  try {
    const m = /^\/api\/cases(?:\/([\w-]+))?(?:\/(evidence|accept|settled|facts\/([\w-]+)\/vote))?$/.exec(p);
    if (!m) throw Object.assign(new Error("Not found."), { status: 404 });
    const [, id, action, fid] = m;
    if (!id) {
      if (req.method === "GET") { send(res, 200, { cases: [...store.values()].map(summary), demo: process.env.CLEARINGHOUSE_CASES_DEMO === "1" }); return true; }
      const b = await readBody(req), clean = s => String(s || "").trim().slice(0, 40);
      if (!clean(b.title) || !clean(b.aName) || !clean(b.bName) || clean(b.aName).toLowerCase() === clean(b.bName).toLowerCase()) throw Object.assign(new Error("Give the case a title and two different names."), { status: 400 });
      const c = { id: uid("case"), title: clean(b.title), names: { a: clean(b.aName), b: clean(b.bName) }, me: "a", evidence: [], facts: [], samples: [], accepted: { a: false, b: false }, settled: null, agreedAt: null };
      store.set(c.id, c); send(res, 201, view(c)); return true;
    }
    const c = store.get(id);
    if (!c) throw Object.assign(new Error("No such case."), { status: 404 });
    if (req.method === "GET" && !action) { send(res, 200, view(c)); return true; }
    if (req.method !== "POST") throw Object.assign(new Error("Use POST."), { status: 405 });
    const b = await readBody(req);
    if (c.settled && action !== "settled") throw Object.assign(new Error("This case is settled."), { status: 409 });
    if (action === "evidence") await addEvidence(c, b);
    else if (fid) { const f = c.facts.find(x => x.id === fid); if (!f) throw Object.assign(new Error("No such fact."), { status: 404 }); vote(c, f, b); }
    else if (action === "accept") {
      const s = settlementOf(c);
      if (s.pendingCount || !s.lines.length) throw Object.assign(new Error("Settle the open facts first."), { status: 409 });
      const side = b.side === "b" ? "b" : "a";
      c.accepted[side] = b.accept !== false;
      if (c.accepted.a && c.accepted.b) c.agreedAt = c.agreedAt || new Date().toISOString(); else c.agreedAt = null;
    } else if (action === "settled") {
      const s = settlementOf(c);
      if (!(c.accepted.a && c.accepted.b) || !s.amountMinor || typeof b.orderId !== "string" || !/^[A-Za-z0-9]{8,36}$/.test(b.orderId)) throw Object.assign(new Error("Both sides must accept before settling."), { status: 409 });
      c.settled = { orderId: b.orderId, amountMinor: s.amountMinor, at: new Date().toISOString() };
    } else throw Object.assign(new Error("Not found."), { status: 404 });
    send(res, 200, view(c)); return true;
  } catch (e) { send(res, e.status || 500, { message: e.status ? e.message : "Something went wrong." }); return true; }
}
