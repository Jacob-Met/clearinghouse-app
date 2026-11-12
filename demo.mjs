// Simulated demo: `npm run demo` (or `node demo.mjs`).
// Runs the normal app with an in-process fake PayPal Sandbox and a canned AI answer.
// Nothing here touches the network, reads PayPal keys, or needs a local model.
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const origin = `http://127.0.0.1:${port}`;
const SB = "https://www.sandbox.paypal.com/checkoutnow?token=";
const SAMPLE_GOAL = "Keep everyone within their spending limit and share any extra equally.";
const state = mkdtempSync(path.join(os.tmpdir(), "clearinghouse-demo-"));

// Replace the whole environment the app reads: fake credentials, fake model endpoint, throwaway state.
for (const key of Object.keys(process.env)) if (/^(PAYPAL_|CLEARINGHOUSE_)/.test(key)) Reflect.deleteProperty(process.env, key);
Object.assign(process.env, {
  PORT: String(port), CLEARINGHOUSE_CASES_DEMO: "1", PAYPAL_SANDBOX_CLIENT_ID: "SIMULATED", PAYPAL_SANDBOX_CLIENT_SECRET: "SIMULATED",
  CLEARINGHOUSE_AI_BASE_URL: "http://127.0.0.1:1/v1", CLEARINGHOUSE_AI_MODEL: "simulated-canned-answer",
  CLEARINGHOUSE_PAYPAL_STATE_PATH: path.join(state, "paypal.json"), CLEARINGHOUSE_PARTICIPATION_PATH: path.join(state, "participation.json")
});

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---- fake PayPal: token, create order, get order, capture ----
const orders = new Map();
const payPal = async (method, pathname, body) => {
  if (pathname === "/v1/oauth2/token")
    return json({ scope: "https://uri.paypal.com/services/payments/payment", access_token: "SIMULATED-ACCESS-TOKEN", token_type: "Bearer", app_id: "APP-SIMULATED", expires_in: 32400, nonce: "simulated" });
  if (method === "POST" && pathname === "/v2/checkout/orders") {
    const unit = body.purchase_units[0], id = "SIM" + crypto.randomBytes(7).toString("hex").toUpperCase();
    orders.set(id, { id, status: "CREATED", unit, returnUrl: body.payment_source?.paypal?.experience_context?.return_url || origin + "/", captures: [] });
    return json({ id, status: "PAYER_ACTION_REQUIRED", intent: "CAPTURE", purchase_units: [unit], links: [
      { href: "https://api-m.sandbox.paypal.com/v2/checkout/orders/" + id, rel: "self", method: "GET" },
      { href: SB + id, rel: "payer-action", method: "GET" }] }, 201);
  }
  const m = pathname.match(/^\/v2\/checkout\/orders\/([A-Z0-9]+)(\/capture)?$/), o = m && orders.get(m[1]);
  if (!o) return json({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, 404);
  const view = () => ({ id: o.id, intent: "CAPTURE", status: o.status,
    purchase_units: [{ reference_id: o.unit.reference_id, custom_id: o.unit.custom_id, description: o.unit.description, amount: o.unit.amount, ...(o.captures.length ? { payments: { captures: o.captures } } : {}) }] });
  if (method === "GET" && !m[2]) return json(view());
  if (method === "POST" && m[2]) {
    if (o.status !== "APPROVED") return json({ name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] }, 422);
    o.captures = [{ id: "SIMCAP" + crypto.randomBytes(5).toString("hex").toUpperCase(), status: "COMPLETED", amount: o.unit.amount, final_capture: true }];
    o.status = "COMPLETED";
    return json(view(), 201);
  }
  return json({ name: "NOT_FOUND" }, 404);
};

// ---- canned AI answer: the two structured model calls the app makes, in the same wire shape ----
const model = async body => {
  await wait(900);
  const schema = body.response_format?.json_schema?.name, prompt = JSON.parse(body.messages.at(-1).content);
  const content = schema === "sharing_policy" ? { method: "balanced_extra" }
    : { purchases: Object.fromEntries(prompt.purchases.map(p => [p.id, { role: "unspecified", quote: "" }])),
        people: Object.fromEntries(prompt.people.map(p => [p.id, { role: "unspecified", quote: "" }])) };
  return json({ id: "chatcmpl-simulated", object: "chat.completion", model: "simulated", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(content) } }] });
};

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(String(url)), body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : undefined;
  if (u.hostname === "api-m.sandbox.paypal.com") return payPal(init.method || "GET", u.pathname, body);
  if (u.hostname === "127.0.0.1" && u.port === "1" && u.pathname.endsWith("/chat/completions")) return model(body);
  throw new TypeError("Simulated demo: network access is disabled (" + u.hostname + ")");
};

// ---- demo-only routes: approval page, badge assets, and the index with the badge ----
const { server } = await import("./server.mjs");
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"; // same as server.mjs
const send = (res, status, type, text) => { res.writeHead(status, { "Content-Type": type, "Content-Security-Policy": CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); res.end(text); };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const badgeJs = `(function(){
  var SB=${JSON.stringify(SB)};
  var b=document.createElement("div");b.className="sim-badge";b.setAttribute("role","note");b.textContent="Simulated demo: no real PayPal call";document.body.prepend(b);
  // The fake PayPal returns a realistic sandbox link; point it at the local approval page instead.
  function fix(){document.querySelectorAll('a[href^="'+SB+'"]').forEach(function(a){a.href="/demo/paypal/approve?order="+a.getAttribute("href").slice(SB.length);});}
  new MutationObserver(fix).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:["href"]});fix();
  var g=document.getElementById("ai-goal");if(g&&!g.value)g.value=${JSON.stringify(SAMPLE_GOAL)};
})();`;
const original = server.listeners("request")[0];
server.removeAllListeners("request");
server.on("request", async (req, res) => {
  const url = new URL(req.url || "/", origin);
  if (req.method === "GET" && url.pathname === "/demo-badge.css") return send(res, 200, "text/css; charset=utf-8", await readFile(path.join(here, "demo-badge.css")));
  if (req.method === "GET" && url.pathname === "/demo-badge.js") return send(res, 200, "text/javascript; charset=utf-8", badgeJs);
  if (req.method === "GET" && url.pathname === "/") {
    const html = (await readFile(path.join(here, "app", "index.html"), "utf8")).replace("</head>", '<link rel="stylesheet" href="/demo-badge.css"><script src="/demo-badge.js" defer></script></head>');
    return send(res, 200, "text/html; charset=utf-8", html);
  }
  if (url.pathname === "/demo/paypal/approve") {
    if (req.method === "POST") {
      let raw = ""; for await (const c of req) raw += c;
      const form = new URLSearchParams(raw), o = orders.get(form.get("order"));
      if (!o) return send(res, 404, "text/plain", "Unknown simulated order.");
      if (form.get("action") === "approve" && o.status === "CREATED") o.status = "APPROVED";
      const back = new URL(o.returnUrl); back.searchParams.set("token", o.id);
      res.writeHead(303, { Location: back.href }); return res.end();
    }
    const o = orders.get(url.searchParams.get("order"));
    if (!o) return send(res, 404, "text/plain", "Unknown simulated order.");
    return send(res, 200, "text/html; charset=utf-8", `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated PayPal approval</title><link rel="stylesheet" href="/demo-badge.css"><script src="/demo-badge.js" defer></script></head><body class="sim-page"><main class="sim-card"><h1>Simulated PayPal approval</h1><p>This page stands in for PayPal's hosted approval page. No real PayPal account or card is involved.</p><p><b>${esc(o.unit.description)}</b><br>$${esc(o.unit.amount.value)} ${esc(o.unit.amount.currency_code)}<br>Order ${esc(o.id)}</p><form method="post" action="/demo/paypal/approve"><input type="hidden" name="order" value="${esc(o.id)}"><button type="submit" name="action" value="approve" id="sim-approve">Approve</button> <button type="submit" name="action" value="cancel" class="sim-secondary">Cancel</button></form></main></body></html>`);
  }
  // Payer links opened from a participant page are server redirects; point those at the local page too.
  const writeHead = res.writeHead;
  res.writeHead = function (status, headers, ...rest) {
    if (headers?.Location?.startsWith(SB)) headers = { ...headers, Location: "/demo/paypal/approve?order=" + headers.Location.slice(SB.length) };
    return writeHead.call(this, status, headers, ...rest);
  };
  return original(req, res);
});
server.listen(port, "127.0.0.1", () => console.log(`CLEARINGHOUSE SIMULATED demo: ${origin}\nFake PayPal Sandbox and a canned AI answer; no keys, no model, no network.`));
