import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { server } from "../server.mjs";
import { produceAiSuggestion } from "../server/ai-suggest.mjs";
import { revision } from "./fixtures.mjs";
const model = {purchases:{tickets:{role:"unspecified",quote:""},coach:{role:"keep",quote:"keep coach unchanged"}},
  people:{asha:{role:"unspecified",quote:""},ben:{role:"reduce",quote:"Reduce Ben to his recorded limit"},chen:{role:"unspecified",quote:""}}};
test("disabled AI and bad draft fail without contacting a model",async()=>{
  const disabled=await produceAiSuggestion({goal:"redistribute",revision:revision()},{env:{},fetchImpl:()=>{throw Error("must not call")}});
  assert.equal(disabled.status,503);
  const { aiConfigurationStatus } = await import("../server/ai-suggest.mjs");
  assert.deepEqual(aiConfigurationStatus({}),{configured:false});
  assert.deepEqual(aiConfigurationStatus({CLEARINGHOUSE_AI_BASE_URL:"invalid",CLEARINGHOUSE_AI_MODEL:"local"}),{configured:false});
  assert.deepEqual(aiConfigurationStatus({CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"local",CLEARINGHOUSE_AI_API_KEY:"never-return-me"}),{configured:true});
  const invalid=await produceAiSuggestion({goal:"change",revision:{}},{
    env:{CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"local"},
    fetchImpl:()=>{throw Error("must not call")}});
  assert.equal(invalid.status,400);
});
test("real HTTP model route sends source inputs, validates, and never changes the workspace",async()=>{
  let seen=null;
  const fake=createServer(async(req,res)=>{
    let body="";for await(const chunk of req)body+=chunk;
    seen={url:req.url,request:JSON.parse(body)};
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(seen.request.response_format.json_schema.name==="sharing_policy"?{method:"balanced_extra"}:model)}}]}));
  });
  fake.listen(0,"127.0.0.1");await once(fake,"listening");
  const prior={base:process.env.CLEARINGHOUSE_AI_BASE_URL,model:process.env.CLEARINGHOUSE_AI_MODEL};
  process.env.CLEARINGHOUSE_AI_BASE_URL="http://127.0.0.1:"+fake.address().port+"/v1";
  process.env.CLEARINGHOUSE_AI_MODEL="test-local-model";
  server.listen(0,"127.0.0.1");await once(server,"listening");
  try {
    const source=revision();source.members.find(member=>member.id==="ben").budgetMinor=6000;
    const before=JSON.stringify(source);
    const response=await fetch("http://127.0.0.1:"+server.address().port+"/api/ai/suggest",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({goal:"Reduce Ben to his recorded limit; share the extra ticket cost equally and keep coach unchanged.",revision:source})
    });
    assert.equal(response.status,200);
    assert.match(response.headers.get("cache-control"),/no-store/);
    const result=await response.json();
    assert.deepEqual(result.changes.map(r=>r.afterMinor),[8000,6000,8000]);
    assert.equal(result.totalMinor,22000);
    assert.equal(JSON.stringify(source),before);
    const status=await fetch("http://127.0.0.1:"+server.address().port+"/api/ai/status");
    assert.equal(status.status,200);
    assert.deepEqual(await status.json(),{configured:true});
    assert.equal((await fetch("http://127.0.0.1:"+server.address().port+"/api/ai/status",{method:"POST"})).status,405);
    assert.equal(seen.url,"/v1/chat/completions");
    assert.equal(seen.request.model,"test-local-model");
    assert.equal(seen.request.response_format.type,"json_schema");
    assert.ok(seen.request.max_tokens>=320);
    assert.deepEqual(result.itemChanges.map(item=>item.itemId),["tickets"]);
    assert.deepEqual(result.candidate.items[1],source.items[1]);
    assert.match(seen.request.messages[1].content,/Reduce Ben/);
    assert.equal(Object.hasOwn(JSON.parse(seen.request.messages[1].content),"mustDecrease"),false);
    assert.equal((await fetch("http://127.0.0.1:"+server.address().port+"/api/ai/suggest")).status,405);
    const tampered=await fetch("http://127.0.0.1:"+server.address().port+"/api/ai/suggest",{
      method:"POST",headers:{"Content-Type":"application/json"},body:"{broken"});
    assert.equal(tampered.status,400);
  } finally {
    if(prior.base===undefined)delete process.env.CLEARINGHOUSE_AI_BASE_URL;
    else process.env.CLEARINGHOUSE_AI_BASE_URL=prior.base;
    if(prior.model===undefined)delete process.env.CLEARINGHOUSE_AI_MODEL;
    else process.env.CLEARINGHOUSE_AI_MODEL=prior.model;
    await new Promise(resolve=>server.close(resolve));
    await new Promise(resolve=>fake.close(resolve));
  }
});

test("ambiguous policy asks a genuine clarification before interpreting allocations",async()=>{
  let calls=0;
  const source=revision();source.members[1].budgetMinor=6000;
  const result=await produceAiSuggestion({goal:"Make this fair within our limits",revision:source},{
    env:{CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"test"},
    fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({method:"clarify"})}}]}));}
  });
  assert.equal(calls,1);assert.equal(result.status,422);assert.equal(result.body.clarification,true);
  assert.match(result.body.error,/equal extra costs, equal final totals/);
});
test("a one-cent aggregate shortfall is determined before spending a model call",async()=>{
  const source=revision();source.members[0].budgetMinor=7999;source.members[1].budgetMinor=6000;source.members[2].budgetMinor=8000;
  const result=await produceAiSuggestion({goal:"Respect every limit",revision:source},{
    env:{CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"test"},
    fetchImpl:()=>{throw Error("must not call");}
  });
  assert.equal(result.status,422);assert.match(result.body.error,/short by \$0.01/);
});

test("a rejected model reading remains visible and its explicit correction uses no model",async()=>{
  const source=revision();source.members[1].budgetMinor=6000;const before=JSON.stringify(source);let calls=0;
  const bad={method:"balanced_extra",fixedItems:["coach"],fixedPeople:["ben"]};
  const result=await produceAiSuggestion({goal:"Share the extra ticket costs equally; keep coach unchanged and keep Ben unchanged.",revision:source},{
    env:{CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"test"},
    fetchImpl:async(_url,init)=>{calls++;const name=JSON.parse(init.body).response_format.json_schema.name;
      return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(name==="sharing_policy"?{method:bad.method}:{purchases:{tickets:{role:"unspecified",quote:""},coach:{role:"keep",quote:"keep coach unchanged"}},people:{asha:{role:"unspecified",quote:""},ben:{role:"keep",quote:"keep Ben unchanged"},chen:{role:"unspecified",quote:""}}})}}]}));}
  });
  assert.equal(result.status,422);assert.deepEqual(result.body.modelInterpretation,bad);assert.equal(calls,2);
  assert.match(result.body.error,/Keeping Ben.*\$60.00.*\$100.00/);
  const {calculateReviewedSuggestion}=await import("../server/ai-suggest.mjs");
  const corrected=calculateReviewedSuggestion({revision:source,preference:{...bad,fixedPeople:[]}});
  assert.equal(corrected.status,200);assert.equal(corrected.body.adjustedByUser,true);
  assert.deepEqual(corrected.body.changes.map(row=>row.afterMinor),[8000,6000,8000]);
  assert.equal(calls,2);assert.deepEqual(result.body.modelInterpretation,bad);assert.equal(JSON.stringify(source),before);
});

test.skip("explicit thinking control reproduces the received provider request and unset preserves ordinary requests",async()=>{
  const {readFile}=await import("node:fs/promises");
  const retained=JSON.parse(await readFile(new URL("../docs/evidence/model-negotiation/independent04/qwen35-9b/first-results/results.json",import.meta.url),"utf8"));
  const original=retained.results[0],calls=retained.calls.filter(call=>call.caseIndex===0);
  for(const thinking of [undefined,"false"]){
    let index=0;
    const env={CLEARINGHOUSE_AI_BASE_URL:retained.provider.baseUrl,CLEARINGHOUSE_AI_MODEL:retained.provider.model,
      ...(thinking===undefined?{}:{CLEARINGHOUSE_AI_ENABLE_THINKING:thinking})};
    const result=await produceAiSuggestion(original.input,{env,fetchImpl:async(_url,init)=>{
      const expected=calls[index++];
      assert.deepEqual(JSON.parse(init.body),thinking===undefined?expected.semanticRequest:expected.providerRequest);
      return new Response(expected.raw,{status:expected.status});
    }});
    assert.equal(index,2);assert.equal(result.status,200);
    assert.deepEqual(result.body.candidate,original.result.body.candidate);
    assert.deepEqual(result.body.modelInterpretation,original.result.body.modelInterpretation);
  }
});
test("invalid thinking configuration is rejected before a provider request",async()=>{
  const {aiConfigurationStatus}=await import("../server/ai-suggest.mjs");
  for(const value of ["off","",false,"FALSE"]){
    const env={CLEARINGHOUSE_AI_BASE_URL:"http://127.0.0.1:11434/v1",CLEARINGHOUSE_AI_MODEL:"local",CLEARINGHOUSE_AI_ENABLE_THINKING:value};
    assert.deepEqual(aiConfigurationStatus(env),{configured:false});
    const result=await produceAiSuggestion({goal:"Respect the limits",revision:revision()},{env,fetchImpl:()=>{throw Error("must not call")}});
    assert.equal(result.status,503);
  }
});
