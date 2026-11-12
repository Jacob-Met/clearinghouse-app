// Canned cases for the simulated demo. Pictures are generated SVG so nothing is fetched.
const svg = s => "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const receipt = (shop, date, rows, total) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><rect width="300" height="420" fill="#d9d4c8"/><path d="M30 14h240v392l-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8-12-8-12 8z" fill="#fffef9" stroke="#bbb"/><g font-family="Courier New,monospace" fill="#222"><text x="150" y="58" text-anchor="middle" font-size="19" font-weight="700">${esc(shop)}</text><text x="150" y="80" text-anchor="middle" font-size="11">${esc(date)}</text>${rows.map((r, i) => `<text x="48" y="${120 + i * 24}" font-size="13">${esc(r[0])}</text><text x="252" y="${120 + i * 24}" font-size="13" text-anchor="end">${esc(r[1])}</text>`).join("")}<line x1="48" x2="252" y1="310" y2="310" stroke="#222" stroke-dasharray="3 3"/><text x="48" y="338" font-size="17" font-weight="700">TOTAL</text><text x="252" y="338" font-size="17" font-weight="700" text-anchor="end">${esc(total)}</text><text x="150" y="380" text-anchor="middle" font-size="10">Obrigado - thank you</text></g></svg>`);
const payShot = (to, amount, date) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><rect width="300" height="420" fill="#f2f5fa"/><rect x="20" y="40" width="260" height="330" rx="22" fill="#fff" stroke="#d5dde8"/><circle cx="150" cy="104" r="26" fill="#0070e0"/><text x="150" y="112" font-family="system-ui" font-size="22" fill="#fff" text-anchor="middle" font-weight="700">P</text><g font-family="system-ui" text-anchor="middle"><text x="150" y="168" font-size="14" fill="#556">You sent</text><text x="150" y="214" font-size="40" font-weight="700" fill="#112">${esc(amount)}</text><text x="150" y="246" font-size="14" fill="#556">to ${esc(to)}</text><text x="150" y="290" font-size="12" fill="#0a7">Completed - ${esc(date)}</text><text x="150" y="330" font-size="11" fill="#889">Note: apartment share</text></g></svg>`);
const chat = (lines) => svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 420"><rect width="300" height="420" fill="#eef1f5"/>${lines.map((l, i) => `<rect x="${l[0] ? 150 : 16}" y="${24 + i * 64}" width="134" height="48" rx="16" fill="${l[0] ? "#0b84ff" : "#fff"}"/><text x="${l[0] ? 160 : 26}" y="${54 + i * 64}" font-family="system-ui" font-size="13" fill="${l[0] ? "#fff" : "#111"}">${esc(l[1])}</text>`).join("")}</svg>`);

const f = (date, what, kind, paidBy, amountMinor, quote, extra = {}) => ({ date, what, kind, paidBy, amountMinor, splitPct: 50, quote, ...extra });
const yr = new Date().getUTCFullYear();
const d = md => `${yr}-${md}`;

function mk(id, title, a, b, me) {
  return { id, title, names: { a, b }, me, evidence: [], facts: [], samples: [], accepted: { a: false, b: false }, settled: null, agreedAt: null };
}
function put(c, side, kind, name, extra, facts, votes = {}) {
  const ev = { id: `${c.id}-e${c.evidence.length + 1}`, side, kind, name, at: new Date(Date.UTC(yr, 5, 9, 12, c.evidence.length)).toISOString(), readBy: "sample reading", note: "", ...extra, factIds: [] };
  c.evidence.push(ev);
  for (const x of facts) {
    const fact = { id: `${c.id}-f${c.facts.length + 1}`, date: x.date, what: x.what, kind: x.kind, paidBy: x.paidBy, amountMinor: x.amountMinor, splitPct: 50,
      sources: [{ evidenceId: ev.id, quote: x.quote }], by: side, votes: { a: null, b: null, [side]: "yes", ...votes }, answers: [] };
    c.facts.push(fact); ev.factIds.push(fact.id);
  }
  return ev;
}

export function seedCases() {
  // 1. A trip: Theo (you) has been sent Maya's thread and now has to answer it.
  const lisbon = mk("lisbon", "Lisbon trip, Jun", "Maya", "Theo", "b");
  const thread = `Maya: booked the Alfama apartment Jun 2, $620 on my card
Theo: ok I'll take half
Maya: groceries Jun 4 $84.20 on my card
Theo: I paid for the Sintra tickets Jun 5, $46 for both of us
Theo: sent you $150 on Jun 8 toward the apartment`;
  put(lisbon, "a", "text", "Pasted thread from Maya", { text: thread }, [
    f(d("06-02"), "Alfama apartment", "cost", "a", 62000, "booked the Alfama apartment Jun 2, $620 on my card"),
    f(d("06-04"), "Groceries", "cost", "a", 8420, "groceries Jun 4 $84.20 on my card"),
    f(d("06-05"), "Sintra tickets", "cost", "b", 4600, "I paid for the Sintra tickets Jun 5, $46 for both of us"),
    f(d("06-08"), "Sent toward the apartment", "repay", "b", 15000, "sent you $150 on Jun 8 toward the apartment")]);
  lisbon.samples = [
    { id: "s-receipt", side: "a", kind: "image", label: "Maya: grocery receipt photo", image: receipt("MERCEARIA ALFAMA", `${d("06-04")}  18:42`, [["Pao e queijo", "$21.40"], ["Vinho tinto x2", "$27.80"], ["Fruta", "$14.60"], ["Azeite", "$12.10"], ["Agua x6", "$8.30"]], "$84.20"),
      facts: [f(d("06-04"), "Groceries", "cost", "a", 8420, "TOTAL $84.20, Mercearia Alfama")] },
    { id: "s-booking", side: "a", kind: "image", label: "Maya: booking confirmation", image: chat([[0, "Alfama Loft - confirmed"], [0, `Total ${"$620.00"}`], [1, "Paid by Maya, Jun 2"]]),
      facts: [f(d("06-02"), "Alfama apartment", "cost", "a", 62000, "Booking confirmed. Total $620.00. Paid by Maya, Jun 2")] },
    { id: "s-voice", side: "b", kind: "voice", label: "Theo: voice note", transcript: "The apartment was five sixty, not six twenty. I saw the booking page. Total $560 on June 2, Maya paid.",
      facts: [f(d("06-02"), "Alfama apartment", "cost", "a", 56000, "The apartment was five sixty, not six twenty. Total $560 on June 2, Maya paid.")] },
    { id: "s-paypal", side: "b", kind: "image", label: "Theo: PayPal screenshot", image: payShot("Maya", "$150.00", "Jun 8"),
      facts: [f(d("06-08"), "Sent toward the apartment", "repay", "b", 15000, "You sent $150.00 to Maya, Completed Jun 8")] }];

  // 2. Tickets: everything agreed; Sam already accepted, Riley is next.
  const gig = mk("gig", "Concert tickets", "Sam", "Riley", "a");
  put(gig, "a", "image", "Ticket receipt", { image: receipt("TICKETLINE", `${d("07-11")}  09:03`, [["Floor ticket x2", "$220.00"], ["Service fee", "$20.00"]], "$240.00") },
    [f(d("07-11"), "Concert tickets", "cost", "a", 24000, "TOTAL $240.00, Floor ticket x2")], { b: "yes" });
  put(gig, "b", "text", "Riley's message", { text: "Riley: I'll pay you my half once we agree. Parking was $18 on Jul 12, I covered it." },
    [f(d("07-12"), "Parking", "cost", "b", 1800, "Parking was $18 on Jul 12, I covered it.")], { a: "yes" });
  gig.accepted.a = true;

  // 3. Already settled.
  const flat = mk("flat", "Flat deposit", "Jo", "Kim", "a");
  put(flat, "a", "image", "Deposit receipt", { image: receipt("LETTINGS CO", `${d("03-01")}`, [["Deposit", "$900.00"]], "$900.00") }, [f(d("03-01"), "Deposit", "cost", "a", 90000, "Deposit $900.00")], { b: "yes" });
  flat.accepted = { a: true, b: true };
  flat.settled = { orderId: "SIMDEMO0001", amountMinor: 45000, at: new Date(Date.UTC(yr, 2, 20)).toISOString() };
  return [lisbon, gig, flat];
}
