const app = document.getElementById("cases-app");
const usd = m => (m < 0 ? "-" : "") + "$" + (Math.abs(m) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = d => { const [, m, dd] = d.split("-"); return MON[+m - 1] + " " + +dd; };
const other = s => (s === "a" ? "b" : "a");
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || "That did not work.");
  return data;
}

const S = { c: null, sheet: null, busy: "", msg: "", err: "", pay: null, form: null, text: "" };
const markText = (m, names) => m === "settled" ? "Settled" : m === "you" ? "Waiting on you" : "Waiting on them";
const markPill = m => h("span", { class: "pill " + m }, m === "settled" ? "✓ " : "", markText(m));
const statusLabel = { agreed: "Agreed", disputed: "Disputed", unknown: "Unknown", replaced: "Replaced" };
const sideOf = id => store.get("ch-view-" + id);

/* ---------- home ---------- */
async function home() {
  S.c = null; S.sheet = null; S.msg = S.err = "";
  const { cases, demo } = await api("/api/cases");
  const list = h("ul", { class: "case-list", id: "case-list" }, cases.map(c => {
    const side = sideOf(c.id) || c.me, mark = c.marks[side];
    const owe = c.settled ? "Paid in full" : c.amountMinor ? `${c.names[c.payer]} owes ${c.names[other(c.payer)]} ${usd(c.amountMinor)} so far` : "Nothing agreed yet";
    return h("li", {}, h("button", { class: "case-card", "data-case": c.id, onclick: () => (location.hash = "#/c/" + c.id) },
      h("div", { class: "row" }, h("strong", { text: c.title }), markPill(mark)),
      h("div", { class: "fine" }, h("span", { class: "who-a", text: c.names.a }), " & ", h("span", { class: "who-b", text: c.names.b }), ` · ${c.evidence} pieces of evidence · ${c.facts} facts`),
      h("div", { text: owe })));
  }));
  const form = h("form", { class: "card new-case", id: "new-case-form", hidden: true, onsubmit: async e => {
    e.preventDefault();
    try { const c = await api("/api/cases", { title: form.title.value, aName: form.aName.value, bName: form.bName.value }); store.set("ch-view-" + c.id, "a"); location.hash = "#/c/" + c.id; }
    catch (err) { form.querySelector(".msg").textContent = err.message; }
  } },
  h("h2", {}, "A new case"), h("label", {}, "What is it about", h("input", { name: "title", required: true, maxlength: 40, placeholder: "Weekend away" })),
  h("label", {}, "You", h("input", { name: "aName", required: true, maxlength: 40, placeholder: "Your name" })), h("label", {}, "The other person", h("input", { name: "bName", required: true, maxlength: 40, placeholder: "Their name" })),
  h("button", { class: "primary", type: "submit" }, "Start the case"), h("p", { class: "msg err", role: "alert" }));
  form.querySelector(".msg").textContent = "";
  form.querySelector(".msg").hidden = false;
  app.replaceChildren(h("div", { class: "wrap" },
    h("div", { class: "top" }, h("div", {}, h("p", { class: "eyebrow" }, "CLEARINGHOUSE"), h("h1", {}, "Cases")), h("a", { href: "/", class: "pill them", style: "text-decoration:none" }, "Group tab"),
      h("button", { class: "primary", id: "new-case", onclick: () => { form.hidden = !form.hidden; if (!form.hidden) form.title.focus(); } }, "New case")),
    h("p", { class: "fine" }, "Agree what is owed from the evidence you both already have, then settle it through PayPal."),
    form, cases.length ? list : h("div", { class: "card" }, h("h2", {}, "No cases yet"), h("p", { class: "fine" }, "Start one, then drop in a screenshot, a receipt photo, a pasted thread or a voice note." + (demo ? "" : "")))));
}

/* ---------- case ---------- */
async function load(id) { S.c = await api("/api/cases/" + id); render(); }
function viewer() { return sideOf(S.c.id) || S.c.me; }

function sourceNode(c, f, big) {
  const s = f.sources[0], ev = c.evidence.find(e => e.id === s?.evidenceId);
  if (ev?.image) return big ? h("img", { src: ev.image, alt: `${ev.name || "Picture"} from ${c.names[ev.side]}` }) : h("img", { class: "thumb", src: ev.image, alt: "" });
  const quote = s?.quote || ev?.transcript || ev?.text || "";
  return big ? h("blockquote", {}, "“" + quote + "”") : h("div", { class: "words", "aria-hidden": "true" }, "“" + quote + "”");
}

function factRow(c, f) {
  const me = viewer(), ev = c.evidence.find(e => e.id === f.sources[0]?.evidenceId);
  const turn = f.turn === me ? h("span", { class: "pill you" }, "Your answer") : f.turn ? h("span", { class: "pill them" }, `Waiting on ${c.names[f.turn]}`) : null;
  return h("li", { class: "fact " + f.status }, h("button", { class: "fact-btn", "data-fact": f.id, "aria-label": `${day(f.date)}, ${f.what}, ${usd(f.amountMinor)}, ${statusLabel[f.status]}. Open`, onclick: () => { S.sheet = f.id; S.err = ""; render(); } },
    sourceNode(c, f, false),
    h("div", { class: "fact-main" },
      h("div", { class: "fact-top" }, h("span", { class: "fact-date", text: day(f.date) }), h("span", { class: "fact-amt", text: usd(f.amountMinor) })),
      h("div", { class: "fact-what", text: (f.kind === "repay" ? "Payment: " : "") + f.what }),
      h("div", { class: "fact-meta" }, h("span", { class: "pill " + f.status }, statusLabel[f.status]), turn,
        h("span", {}, `${c.names[f.paidBy]} ${f.kind === "repay" ? "paid back" : "paid"}`), f.sources.length > 1 ? h("span", {}, `${f.sources.length} sources`) : null))));
}

function sheet(c) {
  const f = c.facts.find(x => x.id === S.sheet);
  if (!f) return null;
  const me = viewer(), mine = f.turn === me;
  const ev = c.evidence.find(e => e.id === f.sources[0]?.evidenceId);
  const ta = h("textarea", { id: "answer-text", placeholder: mine ? "Answer in your own words. Put a new amount as $560 to correct it." : "Add a note for them", "aria-label": "Answer in words" });
  const hint = h("p", { class: "hint", hidden: true });
  ta.addEventListener("input", () => { const m = /\$\s?([\d,]+(?:\.\d{1,2})?)/.exec(ta.value); const v = m && Math.round(parseFloat(m[1].replace(/,/g, "")) * 100); hint.hidden = !(v && v !== f.amountMinor); hint.textContent = v ? `This will change the amount to ${usd(v)} and ask ${c.names[other(me)]} to confirm.` : ""; });
  const send = async v => { try { S.c = await api(`/api/cases/${c.id}/facts/${f.id}/vote`, { side: me, vote: v, text: ta.value }); S.sheet = null; S.err = ""; } catch (e) { S.err = e.message; } render(); };
  return h("div", { class: "scrim", id: "fact-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Fact detail", onclick: e => { if (e.target.classList.contains("scrim")) { S.sheet = null; render(); } } },
    h("div", { class: "sheet" }, h("div", { class: "grab" }),
      h("p", { class: "eyebrow" }, `${day(f.date)} · ${f.kind === "repay" ? "payment between you" : "shared cost"}`),
      h("h2", {}, `${f.what}: ${usd(f.amountMinor)}`),
      h("p", { class: "fine" }, f.kind === "repay" ? `${c.names[f.paidBy]} paid ${c.names[other(f.paidBy)]} back.` : `${c.names[f.paidBy]} paid; ${c.names[other(f.paidBy)]}'s half is ${usd(f.owedMinor)}.`),
      f.sources.map(s => { const e = c.evidence.find(x => x.id === s.evidenceId); const one = { ...f, sources: [s] };
        return h("figure", { class: "src" }, sourceNode(c, one, true), h("figcaption", {}, `${c.names[e?.side || f.by]}: ${e?.name || "evidence"}${e?.readBy ? " · read by " + e.readBy : ""}${s.quote && e?.image ? " · “" + s.quote + "”" : ""}`)); }),
      h("div", { class: "votes" }, ["a", "b"].map(s => h("span", { class: "pill " + (f.votes[s] === "yes" ? "agreed" : f.votes[s] === "no" ? "disputed" : "unknown") },
        `${c.names[s]}: ${f.votes[s] === "yes" ? "says yes" : f.votes[s] === "no" ? "says no" : "not answered"}`))),
      f.answers.length ? h("div", { class: "thread" }, f.answers.map(a => h("div", { class: "bubble " + a.side }, h("small", {}, c.names[a.side]), a.text))) : null,
      ta, hint, S.err ? h("p", { class: "msg err", role: "alert", text: S.err }) : null,
      h("div", { class: "btn-row" }, h("button", { class: "primary", id: "vote-yes", onclick: () => send("yes") }, "That's right"), h("button", { id: "vote-no", onclick: () => send("no") }, "That's not right")),
      h("p", { class: "fine" }, `Answering as ${c.names[me]}.`),
      h("button", { class: "ghost", style: "margin-top:8px;width:100%", onclick: () => { S.sheet = null; render(); } }, "Close")));
}

async function addEvidence(payload, label) {
  S.busy = label; S.err = ""; render();
  try { S.c = await api(`/api/cases/${S.c.id}/evidence`, { side: viewer(), ...payload }); const ev = S.c.evidence.at(-1); S.msg = ev.note || `Read ${ev.factIds.length} fact${ev.factIds.length === 1 ? "" : "s"} from it${ev.readBy ? " (" + ev.readBy + ")" : ""}.`; }
  catch (e) { S.err = e.message; }
  S.busy = ""; render();
}
const b64 = file => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1]); r.onerror = no; r.readAsDataURL(file); });
async function fromFile(file) {
  if (!file) return;
  if (file.type.startsWith("image/")) return addEvidence({ kind: "image", mime: file.type, name: file.name, data: await b64(file) }, "Reading the picture with the local vision model");
  if (file.type.startsWith("audio/") || file.type.startsWith("video/")) return addEvidence({ kind: "audio", name: file.name, data: await b64(file) }, "Listening to the recording");
  S.err = "Add a picture or a recording, or paste the words."; render();
}

function dropCard(c) {
  const photo = h("input", { type: "file", accept: "image/*", hidden: true, id: "pick-photo", onchange: () => fromFile(photo.files[0]) });
  const voice = h("input", { type: "file", accept: "audio/*,video/*", hidden: true, id: "pick-voice", onchange: () => fromFile(voice.files[0]) });
  const me = viewer();
  const card = h("section", { class: "drop", id: "drop-zone", "aria-label": "Add evidence" },
    h("h2", { style: "margin:0;font-size:1.2rem" }, `${c.names[me]}, drop in what you have`),
    h("p", { class: "fine" }, "A screenshot, a receipt photo, a pasted thread or a voice note. It is read on this machine, and the other side sees it."),
    h("div", { class: "tiles" },
      h("button", { class: "tile", id: "add-photo", onclick: () => photo.click() }, h("span", { class: "ic", "aria-hidden": "true" }, "📷"), "Photo"),
      h("button", { class: "tile", id: "add-words", onclick: () => { S.form = "words"; render(); } }, h("span", { class: "ic", "aria-hidden": "true" }, "💬"), "Paste words"),
      h("button", { class: "tile", id: "add-voice", onclick: () => voice.click() }, h("span", { class: "ic", "aria-hidden": "true" }, "🎙"), "Voice note")),
    photo, voice,
    c.samples.length ? h("div", { class: "samples", id: "samples" }, h("span", { class: "fine", style: "align-self:center" }, "Try a sample:"), c.samples.map(s => h("button", { class: "chip", "data-sample": s.id, onclick: () => addEvidence({ sampleId: s.id }, "Reading it") }, s.label))) : null,
    S.busy ? h("div", { class: "busy", role: "status" }, h("span", { class: "spin" }), S.busy) : null,
    S.msg && !S.busy ? h("p", { class: "msg", role: "status", id: "read-msg", text: S.msg }) : null,
    S.err && !S.sheet ? h("p", { class: "msg err", role: "alert", text: S.err }) : null);
  card.addEventListener("dragover", e => { e.preventDefault(); card.classList.add("over"); });
  card.addEventListener("dragleave", () => card.classList.remove("over"));
  card.addEventListener("drop", e => { e.preventDefault(); card.classList.remove("over"); fromFile(e.dataTransfer.files[0]); });
  return card;
}

function wordsSheet(c) {
  const ta = h("textarea", { id: "words-text", placeholder: `Paste a thread, an email or a note.\n${c.names.a}: booked the room, $120 on my card`, "aria-label": "Pasted words", style: "min-height:180px" });
  return h("div", { class: "scrim", id: "words-sheet", role: "dialog", "aria-modal": "true", "aria-label": "Paste words", onclick: e => { if (e.target.classList.contains("scrim")) { S.form = null; render(); } } },
    h("div", { class: "sheet" }, h("div", { class: "grab" }), h("h2", {}, "Paste what was said"), h("p", { class: "fine" }, "Each line with a dollar amount becomes a dated fact. Both sides see it."), ta,
      h("div", { class: "btn-row" }, h("button", { class: "ghost", onclick: () => { S.form = null; render(); } }, "Cancel"),
        h("button", { class: "primary", id: "words-send", onclick: () => { const text = ta.value; S.form = null; addEvidence({ kind: "text", text, name: "Pasted words" }, "Reading the words"); } }, "Add to the case"))));
}

function settlementCard(c) {
  const s = c.settlement, me = viewer(), card = h("section", { class: "card", id: "settlement" });
  card.append(h("h2", {}, "What is owed"), h("p", { class: "fine" }, "Only facts both sides agreed count. Each line shows who is owed what."));
  if (!s.lines.length) { card.append(h("p", { class: "msg" }, "No agreed facts yet. Answer the facts above and this fills in.")); return card; }
  card.append(h("table", { class: "sum", id: "arithmetic" }, h("tbody", {},
    s.lines.map(l => h("tr", {}, h("td", {}, h("span", { class: "fact-date" }, day(l.date) + " "), l.text), h("td", { class: l.deltaMinor >= 0 ? "pos" : "neg", text: (l.deltaMinor >= 0 ? "+" : "-") + usd(Math.abs(l.deltaMinor)) }))),
    h("tr", { class: "net" }, h("td", {}, s.payer ? `${c.names[s.payer]} owes ${c.names[s.payee]}` : "Nothing owed either way"), h("td", { id: "net-amount", text: usd(s.amountMinor) })))));
  card.append(h("p", { class: "fine" }, `Positive lines (${c.names.a}) mean ${c.names.b} owes ${c.names.a}; negative lines (${c.names.b}) the other way. Shared costs are split in half; payments between you count in full.`));
  if (s.pendingCount) card.append(h("p", { class: "msg", id: "not-counted" }, `Not counted yet: ${s.pendingCount} open fact${s.pendingCount === 1 ? "" : "s"} (${usd(s.pendingMinor)} of shared cost, half each). Settle them to firm this up.`));
  if (c.settled) { card.append(h("div", { class: "done", id: "settled-note" }, `✓ Settled through PayPal: ${usd(c.settled.amountMinor)}`)); return card; }
  if (!s.pendingCount && s.amountMinor) {
    const chips = h("div", { class: "votes" }, ["a", "b"].map(x => h("span", { class: "pill " + (c.accepted[x] ? "agreed" : "unknown") }, `${c.names[x]}: ${c.accepted[x] ? "accepted" : "not yet"}`)));
    card.append(chips);
    const row = h("div", { class: "accept-row" });
    if (!c.accepted[me]) row.append(h("button", { class: "primary", id: "accept", onclick: () => accept(true) }, `Accept ${usd(s.amountMinor)} as ${c.names[me]}`));
    else row.append(h("button", { id: "unaccept", onclick: () => accept(false) }, "Take back my acceptance"));
    card.append(row);
    if (c.accepted[me] && !c.accepted[other(me)]) card.append(h("p", { class: "fine" }, `Waiting for ${c.names[other(me)]} to accept. Payment opens once both have.`));
    if (s.ready) card.append(payBox(c, s, me));
  }
  return card;
}
async function accept(v) { try { S.c = await api(`/api/cases/${S.c.id}/accept`, { side: viewer(), accept: v }); S.pay = null; S.err = ""; } catch (e) { S.err = e.message; } render(); }

function payBox(c, s, me) {
  const box = h("div", { class: "paybox", id: "paybox" });
  if (me !== s.payer) { box.append(h("p", { class: "msg" }, `Both have accepted. ${c.names[s.payer]} pays ${usd(s.amountMinor)} to ${c.names[s.payee]} through PayPal.`)); return box; }
  const post = (path, extra = {}) => fetch("/api/paypal-sandbox" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project: s.project, ...extra }) }).then(async r => { const d = await r.json(); if (!r.ok || !d.ok) throw new Error(d.message || "PayPal did not accept that."); return d; });
  const run = fn => async () => { try { S.err = ""; await fn(); } catch (e) { S.err = e.message; } render(); };
  const p = S.pay || {};
  if (!p.link) box.append(h("button", { class: "primary", id: "pay-create", onclick: run(async () => { const d = await post(""); const e = d.created[0]; S.pay = { link: e.approveUrl, orderId: e.orderId, amount: e.amount }; }) }, `Pay ${usd(s.amountMinor)} with PayPal`));
  else {
    box.append(h("p", { class: "fine" }, "Open PayPal in a new tab, approve, then come back here."),
      h("a", { class: "btn", id: "pay-approve", href: p.link, target: "_blank", rel: "noopener" }, "Approve in PayPal"),
      h("button", { id: "pay-capture", class: "primary", onclick: run(async () => {
        const d = await post("/capture", { memberId: s.payer });
        if (!d.order?.captured) throw new Error("PayPal has not confirmed the payment yet. Approve it first, then try again.");
        S.c = await api(`/api/cases/${c.id}/settled`, { orderId: d.order.orderId }); S.pay = null; S.msg = "";
      }) }, `I approved: capture ${usd(s.amountMinor)}`));
  }
  return box;
}

function evidenceUnread(c) {
  const bare = c.evidence.filter(e => !e.factIds?.length);
  if (!bare.length) return null;
  return h("section", { class: "card" }, h("h2", {}, "Added, but nothing read yet"), bare.map(e => h("div", { class: "msg" }, e.image ? h("img", { class: "thumb", src: e.image, alt: "", style: "float:left;margin-right:10px;height:56px;width:44px" }) : null, `${c.names[e.side]}: ${e.name || "evidence"}. ${e.note}`, h("div", { style: "clear:both" }))));
}

function render() {
  const c = S.c; if (!c) return;
  const me = viewer(), marks = c.marks[me];
  const seg = h("div", { class: "seg", role: "group", "aria-label": "View this case as" }, ["a", "b"].map(s => h("button", { "data-as": s, "aria-pressed": String(me === s), onclick: () => { store.set("ch-view-" + c.id, s); S.pay = null; S.msg = ""; S.err = ""; render(); } }, c.names[s])));
  const facts = c.facts.length ? h("ol", { class: "timeline", id: "timeline" }, c.facts.map(f => factRow(c, f))) : h("p", { class: "msg" }, "Nothing on the timeline yet. Drop in the first piece of evidence.");
  const wrap = h("div", { class: "wrap" },
    h("div", { class: "top" }, h("button", { class: "back ghost", id: "back", "aria-label": "Back to cases", onclick: () => (location.hash = "#/") }, "←"),
      h("div", { style: "flex:1;min-width:0" }, h("p", { class: "eyebrow" }, "One shared timeline"), h("h1", { text: c.title })), markPill(marks)),
    h("p", { class: "fine", style: "margin:0 0 8px" }, "Both sides see the same facts and the same pictures. See it as:"), seg,
    dropCard(c),
    h("section", { class: "card" }, h("h2", {}, "Timeline"), h("p", { class: "fine", style: "margin-bottom:14px" }, "Tap a fact to see where it came from and to answer."), facts),
    evidenceUnread(c), settlementCard(c));
  app.replaceChildren(...[wrap, S.form === "words" ? wordsSheet(c) : null, S.sheet ? sheet(c) : null].filter(Boolean));
  document.title = c.title + " - Cases";
}

/* ---------- routing ---------- */
async function route() {
  const m = /^#\/c\/([\w-]+)/.exec(location.hash);
  try { if (m) { S.sheet = null; S.form = null; S.msg = S.err = ""; S.pay = null; await load(m[1]); } else await home(); }
  catch (e) { app.replaceChildren(h("div", { class: "wrap" }, h("p", { class: "msg err", role: "alert" }, e.message), h("button", { onclick: () => (location.hash = "#/") }, "Back to cases"))); }
}
window.addEventListener("hashchange", route);
window.addEventListener("paste", e => { const f = [...(e.clipboardData?.files || [])].find(x => x.type.startsWith("image/")); if (f && S.c && !S.form) fromFile(f); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && (S.sheet || S.form)) { S.sheet = null; S.form = null; render(); } });
route();
