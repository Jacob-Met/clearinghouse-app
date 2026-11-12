import { createModelFetch, modelProxyUrl } from "./model-transport.mjs";
import { evaluateRevision } from "../app/core.mjs";
import { SuggestionError } from "../app/ai-negotiation.mjs";
import { policyRequest, preferenceRequest, preferenceFromRoles, preferenceForReview, counterofferFromPreference } from "./negotiation-preference.mjs";
const jsonHeaders = {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",
  "Referrer-Policy":"no-referrer","X-Content-Type-Options":"nosniff"};
const respond = (res,status,body) => {res.writeHead(status,jsonHeaders);res.end(JSON.stringify(body));};
function config(env) {
  const base=env.CLEARINGHOUSE_AI_BASE_URL,model=env.CLEARINGHOUSE_AI_MODEL;
  if (!base || !model) return null;
  const url=new URL(base.replace(/\/+$/,"")+"/chat/completions");
  if (!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)
    throw new Error("Invalid configured AI URL");
  const thinking=env.CLEARINGHOUSE_AI_ENABLE_THINKING;
  if(thinking!==undefined && thinking!=="true" && thinking!=="false")
    throw new Error("Invalid configured AI thinking control");
  return {url,model,key:env.CLEARINGHOUSE_AI_API_KEY||"",proxy:modelProxyUrl(env.CLEARINGHOUSE_AI_HTTP_PROXY),thinking:thinking===undefined?undefined:thinking==="true"};
}
export function aiConfigurationStatus(env = process.env) {
  try { return { configured: Boolean(config(env)) }; }
  catch { return { configured: false }; }
}
export function handleAiStatus(request,response) {
  if (request.method !== "GET") return respond(response,405,{error:"Use GET."});
  respond(response,200,aiConfigurationStatus());
}
const policySystem = "Choose the requested sharing policy. Use the person's words, not the existence of a budget problem.\nbalanced_extra: equal additional amounts or a named person covering the remaining excess.\nbalanced_total: equal final bills or equal total shares.\nminimum_change: explicitly asks for the least change, or only asks to fit the existing budgets without a fairness objective.\nclarify: fairness is requested but the meaning of fair is unspecified, or the request changes prices, membership or budgets.\n\"Make it fair within our limits\" is clarify, because equal increases and equal final totals differ.\n\"Everyone adds the same extra amount\" is balanced_extra.\n\"Everyone should owe the same total\" is balanced_total.\n\"Change as little as possible\" is minimum_change.\nReturn only JSON with method.";
const constraintsSystem = "Classify each purchase and person by their role in the request. This is reading, not arithmetic. Do not infer roles from a person's budget or from list order. Return every supplied ID exactly once.\nFor each purchase: keep means its current allocation must stay unchanged; unspecified means the request does not protect that allocation. This workflow changes who pays, never purchase prices or quantities. Leaving a purchase unchanged therefore preserves its current allocation. A statement only about its price or quantity does not protect the allocation.\nFor each person: reduce means lower their current share, including down to their spending limit; help means cover extra cost; keep means preserve their current share; unspecified means no individual role was requested. A spending limit is not a current share.\nFor each non-unspecified role, copy the shortest exact quote that identifies that purchase/person and their requested action. Use an empty quote for unspecified. Do not invent quotes or mark someone keep just because they are not a helper: the calculator handles the unmentioned people. Read the action attached to each entity independently.";

export async function produceAiSuggestion(input,{env=process.env,fetchImpl=fetch}={}) {
  let cfg;
  try {cfg=config(env);} catch {return {status:503,body:{error:"The AI server configuration is invalid."}};}
  if (!cfg) return {status:503,body:{error:"AI is not configured. Set CLEARINGHOUSE_AI_BASE_URL and CLEARINGHOUSE_AI_MODEL on the server."}};
  const goal=input?.goal,revision=input?.revision;
  if (typeof goal!=="string"||!goal.trim()||goal.length>1200)
    return {status:400,body:{error:"Describe the change in 1–1200 characters."}};
  let current;
  try {
    current=evaluateRevision(revision);
    if (!current.budgetsKnown) return {status:400,body:{error:"Confirm every spending limit before exploring a within-budget split."}};
  } catch {
    return {status:400,body:{error:"The current draft is invalid. Fix its entries first."}};
  }
  const budgetTotal=current.members.reduce((sum,member)=>sum+member.budgetMinor,0);
  if(budgetTotal<current.totalMinor) return {status:422,body:{error:"The recorded limits fall short by $"+((current.totalMinor-budgetTotal)/100).toFixed(2)+". A different split cannot fund this purchase."}};
  let modelInterpretation,modelEvidence;
  try {
    const signal=AbortSignal.timeout(60000);
    const modelFetch=createModelFetch({proxyUrl:cfg.proxy,fetchImpl});
    const interpret=async({prompt,schema,maxTokens=160},system,name)=>{
      const response=await modelFetch(cfg.url,{method:"POST",signal,
        headers:{"Content-Type":"application/json",...(cfg.key?{Authorization:"Bearer "+cfg.key}:{})},
        body:JSON.stringify({model:cfg.model,temperature:0,max_tokens:maxTokens,
          response_format:{type:"json_schema",json_schema:{name,strict:true,schema}},
          messages:[{role:"system",content:system},{role:"user",content:JSON.stringify(prompt)}],
          ...(cfg.thinking===undefined?{}:{chat_template_kwargs:{enable_thinking:cfg.thinking}})})});
      if(!response.ok)throw new Error("upstream_http");
      const raw=await response.text();if(raw.length>80000)throw new Error("upstream_size");
      const content=JSON.parse(raw)?.choices?.[0]?.message?.content;
      if(typeof content!=="string")throw new Error("upstream_shape");
      try{return JSON.parse(content);}catch{throw new SuggestionError("The model returned non-JSON content; try a more specific request.");}
    };
    const policy=await interpret(policyRequest(goal.trim()),policySystem,"sharing_policy");
    if(!policy || Object.keys(policy).length!==1 || !["balanced_extra","balanced_total","minimum_change","clarify"].includes(policy.method))
      throw new SuggestionError("The model did not identify a supported sharing policy. Nothing changed.");
    if(policy.method==="clarify")return {status:422,body:{modelInterpretation:{method:"clarify",fixedItems:[],fixedPeople:[]},error:"What should fair mean here: equal extra costs, equal final totals, or the smallest changes to fit the limits?",clarification:true}};
    const roles=await interpret(preferenceRequest(revision,goal.trim(),policy.method),constraintsSystem,"allocation_roles");
    const classified=preferenceFromRoles(revision,goal.trim(),policy.method,roles);
    modelInterpretation=preferenceForReview(revision,classified.preference);modelEvidence=classified.evidence;
    if(classified.error)throw new SuggestionError(classified.error);
    return {status:200,body:{...counterofferFromPreference(revision,modelInterpretation),modelInterpretation,modelEvidence}};

  } catch(e) {
    if (e instanceof SuggestionError) return {status:422,body:{error:e.message,...(modelInterpretation?{modelInterpretation}: {}),...(modelEvidence?{modelEvidence}:{})}};
    if (e?.name === "TimeoutError" || e?.name === "AbortError")
      return {status:504,body:{error:"The model did not answer within one minute. Your draft is unchanged."}};
    return {status:502,body:{error:"The configured model did not return a valid answer. No changes were made."}};
  }
}
export function calculateReviewedSuggestion(input) {
  try {
    if(!evaluateRevision(input?.revision).budgetsKnown)return {status:400,body:{error:"Confirm every spending limit first."}};
  }catch{return {status:400,body:{error:"The current draft is invalid."}};}
  try {return {status:200,body:{...counterofferFromPreference(input.revision,input.preference),adjustedByUser:true}};}
  catch(e){return {status:422,body:{error:e.message}};}
}
export const handleAiSuggestion=(req,res)=>handleAiRequest(req,res,produceAiSuggestion);
export const handleAiCalculation=(req,res)=>handleAiRequest(req,res,calculateReviewedSuggestion);
async function handleAiRequest(req,res,producer) {
  if (req.method!=="POST") return respond(res,405,{error:"Use POST."});
  if (!req.headers["content-type"]?.startsWith("application/json"))
    return respond(res,415,{error:"Expected JSON input."});
  const chunks=[];let total=0;
  try {
    for await (const chunk of req) {
      total+=chunk.length;
      if (total>96000) return respond(res,413,{error:"Draft is too large for AI negotiation."});
      chunks.push(chunk);
    }
    const payload=JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result=await producer(payload);
    return respond(res,result.status,result.body);
  } catch {
    if (!res.headersSent) respond(res,400,{error:"Could not parse the AI request."});
  }
}
