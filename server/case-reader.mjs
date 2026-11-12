// Turns a piece of evidence (pasted words, a photo, a voice note) into dated facts.
// Local models are tried first (Ollama, speech-to-text on this machine). Every path has a
// deterministic fallback, so the feature works with no model at all.
const OLLAMA = process.env.CLEARINGHOUSE_CASES_OLLAMA || "http://127.0.0.1:11434";
const LISTEN = process.env.CLEARINGHOUSE_CASES_LISTEN || "http://127.0.0.1:5621/listen";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const AMOUNT = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/;

export const toMinor = (whole, frac = "") => Number(String(whole).replace(/,/g, "")) * 100 + Number(String(frac).padEnd(2, "0") || 0);
export const parseDollars = text => { const m = AMOUNT.exec(text || ""); return m ? toMinor(m[1], m[2]) : null; };

export function parseDate(text, today = new Date()) {
  const year = today.getUTCFullYear();
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return m[0];
  m = new RegExp("\\b(" + MONTHS.join("|") + ")[a-z]*\\.?\\s+(\\d{1,2})\\b", "i").exec(text);
  if (m) return `${year}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = new RegExp("\\b(\\d{1,2})\\s+(" + MONTHS.join("|") + ")[a-z]*\\b", "i").exec(text);
  if (m) return `${year}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

// Deterministic reading: one fact per line that carries a dollar amount.
export function readThread(text, ctx) {
  const { names, side } = ctx, other = side === "a" ? "b" : "a";
  const facts = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    const amountMinor = parseDollars(line);
    if (!line || amountMinor === null) continue;
    let speaker = side, body = line;
    const pre = /^([A-Za-z][\w .'-]{0,24}):\s*(.*)$/.exec(line);
    if (pre) {
      const who = pre[1].trim().toLowerCase();
      if (who === names.a.toLowerCase()) speaker = "a"; else if (who === names.b.toLowerCase()) speaker = "b";
      body = pre[2];
    }
    const o = names[speaker === "a" ? "b" : "a"].toLowerCase(), mine = names[speaker].toLowerCase();
    const lower = body.toLowerCase();
    let kind = "cost", paidBy = speaker;
    const repay = /(paid (you|me) back|sent (you|me)|transferred|repaid|reimburs|venmo|paypal)/.test(lower) || /\bsent\b.*\bto\b/.test(lower);
    if (repay) {
      kind = "repay";
      paidBy = new RegExp(`(${o}|you)\\b.{0,12}(sent|paid|transferred)`).test(lower) && !new RegExp(`(sent|paid) (to )?(${o}|you)`).test(lower) ? (speaker === "a" ? "b" : "a") : speaker;
    } else if (new RegExp(`\\b(${o}|you)\\b.{0,14}(paid|bought|covered|booked|got)`).test(lower) && !/\bi\b/.test(lower)) paidBy = speaker === "a" ? "b" : "a";
    const date = parseDate(body, ctx.today) || ctx.today.toISOString().slice(0, 10);
    const what = body.replace(AMOUNT, "").replace(/\s+/g, " ").replace(/[,.\s]+$/, "").slice(0, 90) || "Payment";
    void mine;
    facts.push({ date, what: tidy(what), kind, paidBy, amountMinor, splitPct: 50, quote: line.slice(0, 220) });
  }
  return facts;
}
const tidy = s => s.charAt(0).toUpperCase() + s.slice(1);

async function post(url, body, ms, headers = { "Content-Type": "application/json" }) {
  const res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error("upstream " + res.status);
  return res;
}
const cleanFacts = (list, ctx) => (Array.isArray(list) ? list : []).slice(0, 12).map(f => {
  const amountMinor = typeof f.amount === "number" ? Math.round(f.amount * 100) : parseDollars(String(f.amount ?? ""));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor > 10_000_000) return null;
  const paidBy = f.paid_by === "other" ? (ctx.side === "a" ? "b" : "a") : f.paid_by === "a" || f.paid_by === "b" ? f.paid_by : ctx.side;
  return { date: parseDate(String(f.date || ""), ctx.today) || ctx.today.toISOString().slice(0, 10), what: tidy(String(f.what || "Payment").slice(0, 90)),
    kind: f.kind === "repay" ? "repay" : "cost", paidBy, amountMinor, splitPct: 50, quote: String(f.quote || "").slice(0, 220) };
}).filter(Boolean);

const schemaNote = names => `Return JSON {"facts":[{"date":"YYYY-MM-DD or empty","what":"short label","kind":"cost|repay","paid_by":"submitter|other","amount":number,"quote":"exact words or text seen"}]}. kind cost = someone paid for something shared by ${names.a} and ${names.b}. kind repay = one of them sent money to the other. Only facts with a dollar amount.`;

export async function readTextWithModel(text, ctx) {
  const prompt = `Two people, ${ctx.names.a} and ${ctx.names.b}, share costs. Read this ${ctx.names[ctx.side]}'s evidence and list each money fact. paid_by is "submitter" for ${ctx.names[ctx.side]}, "other" for the other person.\n${schemaNote(ctx.names)}\n\n${text}`;
  const res = await post(OLLAMA + "/api/chat", JSON.stringify({ model: "qwen2.5:7b", stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "user", content: prompt }] }), 60000);
  const out = JSON.parse((await res.json()).message.content);
  const facts = cleanFacts((out.facts || []).map(f => ({ ...f, paid_by: f.paid_by === "submitter" ? ctx.side : f.paid_by })), ctx);
  if (!facts.length) throw new Error("no facts");
  return facts;
}

export async function readImageWithModel(b64, ctx) {
  const prompt = `This picture is evidence from ${ctx.names[ctx.side]} about money shared with ${ctx.names[ctx.side === "a" ? "b" : "a"]}: a receipt, invoice, or screenshot of messages or a payment. Read it. paid_by is "submitter" unless the picture shows the other person paying.\n${schemaNote(ctx.names)}`;
  const res = await post(OLLAMA + "/api/chat", JSON.stringify({ model: "qwen2.5vl:3b", stream: false, format: "json", options: { temperature: 0 }, messages: [{ role: "user", content: prompt, images: [b64] }] }), 90000);
  const out = JSON.parse((await res.json()).message.content);
  const facts = cleanFacts((out.facts || []).map(f => ({ ...f, paid_by: f.paid_by === "submitter" ? ctx.side : f.paid_by })), ctx);
  if (!facts.length) throw new Error("no facts");
  return facts;
}

export async function transcribe(buffer) {
  const res = await post(LISTEN, buffer, 120000, { "Content-Type": "application/octet-stream" });
  const out = await res.json();
  return (out.lines || []).map(l => l.text).join("\n").trim();
}

// Text path: model first, then the deterministic reader.
export async function readText(text, ctx) {
  try { return { facts: await readTextWithModel(text, ctx), by: "local text model" }; }
  catch { return { facts: readThread(text, ctx), by: "built-in reader" }; }
}
