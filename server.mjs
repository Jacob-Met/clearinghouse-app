import { participantUnavailableHtml } from "./app/participant-review.mjs";
import { createParticipation } from "./server/participation.mjs";
import { importProject, replayProject } from "./app/core.mjs";
import { personalPaymentContext, personalPayerHandoff } from "./app/personal-payment-context.mjs";
import { createServer } from "node:http";
import { createSandboxCheckout, CheckoutError } from "./app/paypal-sandbox.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleAiSuggestion, handleAiStatus, handleAiCalculation } from "./server/ai-suggest.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const invitationOrigin = (() => {
  const configured = process.env.CLEARINGHOUSE_INVITATION_ORIGIN;
  if (!configured) return null;
  const url = new URL(configured);
  const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash)
    throw new Error("CLEARINGHOUSE_INVITATION_ORIGIN must be one HTTPS origin.");
  return url.origin;
})();
// A private receiving port can coexist with the original payment-return origin.
// Only the same HTTPS hostname is accepted; each POST must match its own host.
const receivingOrigin = (() => {
  const configured = process.env.CLEARINGHOUSE_RECEIVING_ORIGIN;
  if (!configured) return invitationOrigin;
  const url = new URL(configured), original = invitationOrigin && new URL(invitationOrigin);
  if (!original || original.protocol !== "https:" || url.protocol !== "https:" ||
      url.hostname !== original.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash)
    throw new Error("The receiving origin must use the existing HTTPS hostname.");
  return url.origin;
})();
const invitationOrigins = new Set([invitationOrigin, receivingOrigin].filter(Boolean));
const organizerCode = process.env.CLEARINGHOUSE_ORGANIZER_CODE || null;
if(organizerCode && (!invitationOrigin || !invitationOrigin.startsWith("https://")))
  throw new Error("Hosted organizer access requires an HTTPS invitation origin.");
const participation = createParticipation({organizerCode,paymentReview:async(project,memberId)=>{
  const data=await checkout.payerReview(project,memberId), state=replayProject(importProject(project));
  return {paymentContext:(data.history?.orders.length || !state.evaluation.members.some(m=>m.id===memberId))?personalPaymentContext(state,memberId,data.history,data.settlement):null,
    payerHandoff:personalPayerHandoff(state,memberId,data.prepared,data.order)};
},storagePath:process.env.CLEARINGHOUSE_PARTICIPATION_PATH || join(root,".private","participation.json")});

const checkout = createSandboxCheckout({
  clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID,
  clientSecret: process.env.PAYPAL_SANDBOX_CLIENT_SECRET,
  storagePath: process.env.CLEARINGHOUSE_PAYPAL_STATE_PATH || join(root, ".private", "paypal-sandbox-orders.json"),
  returnUrl: process.env.PAYPAL_SANDBOX_RETURN_URL || (receivingOrigin ? receivingOrigin+"/payment-return" : null) || "http://127.0.0.1:" + (process.env.PORT || "4173") + "/#paypal-return",
  cancelUrl: process.env.PAYPAL_SANDBOX_CANCEL_URL || (receivingOrigin ? receivingOrigin+"/payment-cancel" : null) || "http://127.0.0.1:" + (process.env.PORT || "4173") + "/#paypal-cancel"
});
const json = (res, status, body, headers = {}) => {
  res.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff",...headers});
  res.end(JSON.stringify(body));
};
async function readCheckoutBody(req, memberOperation = false, refundOperation = null, settlementOperation = false) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new CheckoutError("JSON content type is required.",415);
  let total = 0; const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2100000) throw new CheckoutError("Project exceeds the checkout intake limit.",413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new CheckoutError("Invalid project JSON envelope."); }
  if(settlementOperation){
    if(!value||Array.isArray(value)||typeof value!=="object"||Object.keys(value).length!==2||
      typeof value.project!=="string"||typeof value.reviewId!=="string"||!/^[a-f0-9]{64}$/.test(value.reviewId))
      throw new CheckoutError("Exactly one project and its current payment review are required.");
    return value;
  }
  if (refundOperation) {
    const keys = refundOperation === "refund" ? ["project","orderId","amountMinor","requestId"] : ["project","orderId"];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length ||
      keys.some(key => !Object.hasOwn(value,key)) || typeof value.project !== "string" || typeof value.orderId !== "string" ||
      (refundOperation === "refund" && (!Number.isSafeInteger(value.amountMinor) || typeof value.requestId !== "string")))
      throw new CheckoutError("Invalid refund request envelope.");
    return value;
  }
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.project !== "string" ||
    (memberOperation ? Object.keys(value).length !== 2 || typeof value.memberId !== "string" || !value.memberId
      : Object.keys(value).length !== 1)) {
    throw new CheckoutError(memberOperation ? "Exactly one project and memberId are required." : "Exactly one exported project is required.");
  }
  return value;
}
const cookieName = "__Host-clearinghouse-organizer";
const organizerCookie = request => (request.headers.cookie || "").split(";").map(v=>v.trim()).find(v=>v.startsWith(cookieName+"="))?.slice(cookieName.length+1) || "";
const sessionCookie = (token,age) => cookieName+"="+token+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age="+age;
const routes = new Map([
  ["/BricolageGrotesque.ttf", ["app/BricolageGrotesque.ttf", "font/ttf"]],
  ["/organizer-signin.mjs", ["app/organizer-signin.mjs", "text/javascript; charset=utf-8"]],
  ["/organizer-signin.css", ["app/organizer-signin.css", "text/css; charset=utf-8"]],
  ["/organizer-session.mjs", ["app/organizer-session.mjs", "text/javascript; charset=utf-8"]],
  ["/", ["app/index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["app/app.mjs", "text/javascript; charset=utf-8"]],
  ["/controller.mjs", ["app/controller.mjs", "text/javascript; charset=utf-8"]],
  ["/ui-utils.mjs", ["app/ui-utils.mjs", "text/javascript; charset=utf-8"]],
  ["/workspace-recovery.mjs", ["app/workspace-recovery.mjs", "text/javascript; charset=utf-8"]],
  ["/sandbox-settlement.mjs", ["app/sandbox-settlement.mjs", "text/javascript; charset=utf-8"]],
  ["/change-brief.mjs", ["app/change-brief.mjs", "text/javascript; charset=utf-8"]],
  ["/participant-colors.mjs", ["app/participant-colors.mjs", "text/javascript; charset=utf-8"]],
  ["/participant-review.mjs", ["app/participant-review.mjs", "text/javascript; charset=utf-8"]],
  ["/group-tab-font.mjs", ["app/group-tab-font.mjs", "text/javascript; charset=utf-8"]],
  ["/personal-payment-context.mjs", ["app/personal-payment-context.mjs", "text/javascript; charset=utf-8"]],
  ["/budget-rescue.mjs", ["app/budget-rescue.mjs", "text/javascript; charset=utf-8"]],
  ["/scenario-comparison.mjs", ["app/scenario-comparison.mjs", "text/javascript; charset=utf-8"]],
  ["/ai-negotiation.mjs", ["app/ai-negotiation.mjs", "text/javascript; charset=utf-8"]],
  ["/core.mjs", ["app/core.mjs", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["app/styles.css", "text/css; charset=utf-8"]]
]);
function unavailableInvitation(response, status) {
  response.writeHead(status, {"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"});
  response.end(participantUnavailableHtml({expired:status===410,temporary:![401,403,404,410].includes(status)}));
}
async function handleRequest(request, response, invitationOnly = false) {
  const url = new URL(request.url, "http://127.0.0.1");
  let hostedOrganizer = false, signInPage = false;
  const requestOrigin = [...invitationOrigins].find(value => new URL(value).host === request.headers.host);
  if (invitationOnly) {
    if (invitationOrigin && !requestOrigin) {
      json(response, 421, {message:"Use the invitation address."}); return;
    }
    if (url.pathname === "/healthz" && request.method === "GET") {
      json(response, 200, {ok:true, product:"clearinghouse-invitations", audience:"participants", ...(organizerCode?{organizerConfigured:true}:{})});
      return;
    }
    const guestRoute = (request.method === "GET" && /^\/participant\/[A-Za-z0-9_-]{43}(?:\/pay)?$/.test(url.pathname)) ||
      (request.method === "POST" && (url.pathname === "/api/participation/reply" || /^\/participant\/[A-Za-z0-9_-]{43}\/continue$/.test(url.pathname))) ||
      (request.method === "GET" && ["/payment-return","/payment-cancel"].includes(url.pathname));
    if(!guestRoute && request.method==="GET" && url.pathname.startsWith("/participant/")) {
      unavailableInvitation(response,404);return;
    }
    if(!guestRoute && organizerCode) {
      try {
        if(!requestOrigin)
          throw Object.assign(new Error("Use the organizer workspace address."),{status:403});
        if(request.method === "POST" && request.headers.origin !== requestOrigin)
          throw Object.assign(new Error("Use this application's origin."),{status:403});
        if(url.pathname === "/organizer/login" || url.pathname === "/organizer/logout") {
          if(request.method !== "POST") { json(response,404,{message:"Not found."}); return; }
          if(!String(request.headers["content-type"]||"").startsWith("application/json"))
            throw Object.assign(new Error("JSON is required."),{status:415});
          let size=0;const chunks=[];
          for await(const chunk of request){size+=chunk.length;if(size>4096)throw Object.assign(new Error("Sign-in request is too large."),{status:413});chunks.push(chunk);}
          const input=JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if(url.pathname === "/organizer/login") {
            const result=await participation.organizerLogin(input?.code);
            json(response,200,{ok:true},{"Set-Cookie":sessionCookie(result.session,28800)});
          } else {
            await participation.organizerLogout(organizerCookie(request));
            json(response,200,{ok:true},{"Set-Cookie":sessionCookie("",0)});
          }
          return;
        }
        const signInAsset=["/organizer-signin.mjs","/organizer-signin.css","/BricolageGrotesque.ttf"].includes(url.pathname);
        if(!signInAsset) {
          try { await participation.organizerRead(organizerCookie(request)); hostedOrganizer=true; }
          catch(error) {
            if(error.status===401 && request.method==="GET" && url.pathname==="/") signInPage=true;
            else throw error;
          }
        }
        if(hostedOrganizer) {
          // The authenticated HTTPS boundary has checked the original host/origin.
          // Reuse the same local handlers and journal without a second writer.
          request.headers.host="127.0.0.1:"+(server.address()?.port || process.env.PORT || "4173");
          if(request.method==="POST") request.headers.origin="http://"+request.headers.host;
          invitationOnly=false;
        }
      } catch(error) {
        json(response,error.status||400,{message:error.status?error.message:"Unable to process sign-in."}); return;
      }
    } else if(!guestRoute) {
      json(response,404,{message:"Not found."});return;
    }
  }
  const paymentCookiePrefix=(invitationOrigin?.startsWith("https:")?"__Host-":"")+"clearinghouse-payment-";
  const paymentCookie=(orderId,token,age)=>paymentCookiePrefix+orderId+"="+token+"; Path=/; HttpOnly; SameSite=Lax; Max-Age="+age+(invitationOrigin?.startsWith("https:")?"; Secure":"");
  const redirect=(location,cookie)=>{response.writeHead(303,{"Location":location,"Cache-Control":"no-store","Referrer-Policy":"no-referrer",...(cookie?{"Set-Cookie":cookie}:{})});response.end();};
  if(request.method==="GET" && ["/payment-return","/payment-cancel"].includes(url.pathname)) {
    const orderId=url.searchParams.get("token")||"";
    const name=paymentCookiePrefix+orderId+"=";
    const token=/^[A-Za-z0-9]{8,36}$/.test(orderId)?(request.headers.cookie||"").split(";").map(v=>v.trim()).find(v=>v.startsWith(name))?.slice(name.length):null;
    if(token && /^[A-Za-z0-9_-]{43}$/.test(token)) {
      redirect("/participant/"+token,paymentCookie(orderId,"",0));return;
    }
    response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer"});
    response.end("<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'><title>Return to your share · CLEARINGHOUSE</title><main><h1>Return to your share</h1><p>Open your original group invitation to check the current PayPal status.</p><p>Returning from PayPal does not confirm that payment was captured.</p></main>");return;
  }
  const continuationPath=/^\/participant\/([A-Za-z0-9_-]{43})\/continue$/.exec(url.pathname);
  if(request.method==="POST" && continuationPath) {
    try {
      const origin=request.headers.origin,host=request.headers.host||"";
      if(invitationOnly && invitationOrigin ? origin!==requestOrigin : !origin || (origin!=="http://"+host && origin!=="https://"+host))
        throw Object.assign(new Error("Use this application's origin."),{status:403});
      const next=await participation.continueReview(continuationPath[1]);
      redirect(next.path);return;
    } catch(error) {json(response,error.status||400,{message:error.status?error.message:"Unable to open the updated proposal."});}
    return;
  }
  const payerPath=/^\/participant\/([A-Za-z0-9_-]{43})\/pay$/.exec(url.pathname);
  if(request.method==="GET" && payerPath) {
    try {
      const handoff=await participation.payer(payerPath[1]);
      if(!handoff) {redirect("/participant/"+payerPath[1]);return;}
      redirect(handoff.url,paymentCookie(handoff.orderId,payerPath[1],3600));
    } catch(error) {json(response,error.status||400,{message:error.status?error.message:"Unable to check this payment."});}
    return;
  }
  if(url.pathname.startsWith("/participant/") && request.method === "GET") {
    try {
      const html = await participation.review(url.pathname.slice("/participant/".length));
      response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"});
      response.end(html);
    } catch(error) { unavailableInvitation(response,error.status||400); }
    return;
  }
  if(url.pathname.startsWith("/api/participation/") && request.method === "POST") {
    try {
      const host = request.headers.host || "", origin = request.headers.origin;
      if(invitationOnly && invitationOrigin ? origin !== requestOrigin : origin && origin !== "http://"+host && origin !== "https://"+host) throw Object.assign(new Error("Use this application's origin."),{status:403});
      if(!String(request.headers["content-type"]||"").startsWith("application/json")) throw Object.assign(new Error("JSON is required."),{status:415});
      let size=0; const chunks=[];
      for await(const chunk of request){size+=chunk.length;if(size>2100000)throw Object.assign(new Error("Request is too large."),{status:413});chunks.push(chunk);}
      const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const token=String(request.headers.authorization||"").replace(/^Bearer /,"");
      let value;
      const action=url.pathname.slice("/api/participation/".length);
      if(action==="plans" || action==="open" || action==="archive") {
        if(!hostedOrganizer) throw Object.assign(new Error("Sign in to open shared plans."),{status:401});
        value=action==="plans" ? await participation.organizerPlans(organizerCookie(request)) : action==="archive" ? await participation.organizerArchive(organizerCookie(request),body.id,body.archived) : await participation.organizerOpen(organizerCookie(request),body.id);
      } else if(action==="create") {
        if(!/^((127[.]0[.]0[.]1)|localhost):[0-9]{1,5}$/.test(host)) throw Object.assign(new Error("Create shared plans from the local organizer."),{status:403});
        value=await participation.create(body.project,hostedOrganizer?organizerCookie(request):null);
      } else if(action==="publish") {
        value=await participation.publish(token,body.project,body.memberId??null,hostedOrganizer?organizerCookie(request):null);
        if(value.path && invitationOrigin) value={...value,path:new URL(value.path,receivingOrigin).href};
      }
      else if(action==="responses") value=await participation.responses(token);
      else if(action==="reply") value=await participation.reply(token,body.response);
      else throw Object.assign(new Error("Not found."),{status:404});
      json(response,200,value);
    } catch(error) {json(response,error.status||400,{message:error.status?error.message:"Unable to process this shared response."});}
    return;
  }
  if (url.pathname === "/api/ai/status") return handleAiStatus(request, response);
  if (url.pathname === "/api/ai/suggest") return handleAiSuggestion(request, response);
  if (url.pathname === "/api/ai/calculate") return handleAiCalculation(request, response);

  if (["/api/paypal-sandbox", "/api/paypal-sandbox/status", "/api/paypal-sandbox/capture", "/api/paypal-sandbox/reconcile", "/api/paypal-sandbox/history", "/api/paypal-sandbox/refund-review", "/api/paypal-sandbox/refund", "/api/paypal-sandbox/settlement", "/api/paypal-sandbox/settlement-prepare"].includes(url.pathname) && request.method === "POST") {
    const host = request.headers.host || "";
    const origin = request.headers.origin;
    if (!/^((127[.]0[.]0[.]1)|localhost):[0-9]{1,5}$/.test(host) || (origin && origin !== "http://" + host)) {
      json(response, 403, {ok:false,message:"Only the local application origin may request checkout."}); return;
    }
    try {
      const memberOperation = url.pathname === "/api/paypal-sandbox/status" || url.pathname === "/api/paypal-sandbox/capture";
      const refundOperation = url.pathname.endsWith("/refund-review") ? "review" : url.pathname.endsWith("/refund") ? "refund" : null;
      const body = await readCheckoutBody(request, memberOperation, refundOperation,url.pathname==="/api/paypal-sandbox/settlement-prepare");
      if (refundOperation === "review") json(response,200,{ok:true,review:await checkout.refundReview(body.project,body.orderId)});
      else if (refundOperation === "refund") json(response,200,{ok:true,review:await checkout.refund(body.project,body.orderId,body.amountMinor,body.requestId)});
      else if (url.pathname === "/api/paypal-sandbox/settlement-prepare") json(response,200,{ok:true,...(await checkout.prepareSettlement(body.project,body.reviewId))});
      else if (url.pathname === "/api/paypal-sandbox") json(response, 200, {ok:true, ...(await checkout.prepare(body.project))});
      else if (url.pathname === "/api/paypal-sandbox/status") json(response, 200, {ok:true, order:await checkout.inspect(body.project, body.memberId)});
      else if (url.pathname === "/api/paypal-sandbox/capture") json(response, 200, {ok:true, order:await checkout.capture(body.project, body.memberId)});
      else if (url.pathname === "/api/paypal-sandbox/settlement") json(response,200,{ok:true,settlement:await checkout.settlement(body.project)});
      else if (url.pathname === "/api/paypal-sandbox/history") json(response, 200, {ok:true, history:await checkout.history(body.project)});
      else json(response, 200, {ok:true, reconciliation:await checkout.reconcile(body.project)});
    } catch (error) {
      const known = error instanceof CheckoutError;
      json(response, known ? error.status : 502, {ok:false,message:known?error.message:"Unable to prepare sandbox checkout.",partial:known?error.partial:[]});
    }
    return;
  }
  const route = signInPage ? ["app/organizer-signin.html","text/html; charset=utf-8"] : request.method === "GET" || request.method === "HEAD" ? routes.get(url.pathname) : null;
  if (!route) { response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" }); response.end("Not found"); return; }
  try {
    let body = await readFile(join(root, route[0]));
    if(hostedOrganizer && url.pathname === "/")
      body=Buffer.from(body.toString("utf8").replace('data-view="welcome"','data-view="welcome" data-hosted-organizer="true"').replace("</body>",'<script type="module" src="/organizer-session.mjs"></script></body>'));
    response.writeHead(200, { "Content-Type": route[1], "Cache-Control":"no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch { response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }); response.end("Unable to load application"); }
}
export const server = createServer((request,response) => handleRequest(request,response));
export const invitationServer = createServer((request,response) => handleRequest(request,response,true));

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = "127.0.0.1", port = Number(process.env.PORT || 4173);
  const invitationPort = process.env.CLEARINGHOUSE_INVITATION_PORT;
  if (Boolean(invitationPort) !== Boolean(invitationOrigin))
    throw new Error("Set the participant port and HTTPS origin together.");
  const guestPort = Number(invitationPort);
  if (invitationPort && (!Number.isInteger(guestPort) || guestPort < 1024 || guestPort > 65535 || guestPort === port))
    throw new Error("The participant listener needs a distinct unprivileged port.");
  const listen = (listener, number) => new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(number, host, () => { listener.removeListener("error", reject); resolve(); });
  });
  try {
    await listen(server, port);
    if (invitationPort) await listen(invitationServer, guestPort);
    console.log(`CLEARINGHOUSE listening at http://${host}:${port}`);
    if (invitationPort) console.log(`Invitations served for ${invitationOrigin}`);
  } catch (error) {
    for (const listener of [server, invitationServer]) if (listener?.listening) listener.close();
    console.error("Unable to start CLEARINGHOUSE listeners: " + (error.code || "invalid configuration"));
    process.exitCode = 1;
  }
}
