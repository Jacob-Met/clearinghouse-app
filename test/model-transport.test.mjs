import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelFetch, modelProxyUrl } from "../server/model-transport.mjs";
import { aiConfigurationStatus } from "../server/ai-suggest.mjs";

const listen = server => new Promise((resolve,reject) => {
  server.once("error",reject);server.listen(0,"127.0.0.1",()=>resolve(server.address().port));
});
const close = server => new Promise(resolve => {server.closeAllConnections?.();server.close(resolve);});

test("model proxy is optional, explicit and separate from global transports", () => {
  const original=()=>{};assert.equal(createModelFetch({fetchImpl:original}),original);
  assert.equal(modelProxyUrl("http://127.0.0.1:1055"),"http://127.0.0.1:1055/");
  for(const proxy of ["http://127.0.0.1", "http://localhost:1055", "",false,"socks5://127.0.0.1:1055","http://remote.test:1055","http://user:pass@localhost:1055","http://localhost:1055/path"]){
    assert.throws(()=>modelProxyUrl(proxy));
    assert.equal(aiConfigurationStatus({CLEARINGHOUSE_AI_BASE_URL:"https://model.test/v1",CLEARINGHOUSE_AI_MODEL:"test",CLEARINGHOUSE_AI_HTTP_PROXY:proxy}).configured,false);
  }
});

test("model HTTP proxy preserves the request and leaves global agents alone", async () => {
  const globalHttp=http.globalAgent,globalHttps=https.globalAgent,originalFetch=globalThis.fetch;
  let received;
  const proxy=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received={method:req.method,url:req.url,authorization:req.headers.authorization,body:Buffer.concat(chunks).toString()};
    res.writeHead(200,{"Content-Type":"application/json"});res.end('{"choices":[]}');
  });
  const port=await listen(proxy);
  try {
    const body=JSON.stringify({model:"local-reference",chat_template_kwargs:{enable_thinking:false}});
    const modelFetch=createModelFetch({proxyUrl:"http://127.0.0.1:"+port,fetchImpl:()=>{throw Error("Unexpected ordinary fetch");}});
    const result=await modelFetch("http://model.invalid:11543/v1/chat/completions",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer test-model-key"},body});
    assert.equal(result.status,200);assert.deepEqual(await result.json(),{choices:[]});
    assert.deepEqual(received,{method:"POST",url:"http://model.invalid:11543/v1/chat/completions",authorization:"Bearer test-model-key",body});
    assert.equal(http.globalAgent,globalHttp);assert.equal(https.globalAgent,globalHttps);assert.equal(globalThis.fetch,originalFetch);
  } finally {await close(proxy);}
});

test("model HTTPS uses CONNECT with normal trust and hostname verification", async () => {
  const dir=await mkdtemp(join(tmpdir(),"clearinghouse-model-tls-"));
  const key=join(dir,"key.pem"),cert=join(dir,"cert.pem"),sockets=new Set();
  let origin,proxy;
  try {
    execFileSync("openssl",["req","-x509","-newkey","ec","-pkeyopt","ec_paramgen_curve:P-256","-nodes","-keyout",key,"-out",cert,"-subj","/CN=model.test","-addext","subjectAltName=DNS:model.test","-days","1"],{stdio:"ignore"});
    let receivedBody,connects=0;
    origin=https.createServer({key:await readFile(key),cert:await readFile(cert)},async(req,res)=>{
      const chunks=[];for await(const c of req)chunks.push(c);receivedBody=Buffer.concat(chunks).toString();
      res.writeHead(200,{"Content-Type":"application/json"});res.end('{"ok":true}');
    });
    const originPort=await listen(origin);
    proxy=http.createServer();
    proxy.on("connect",(req,client,head)=>{
      connects++;sockets.add(client);client.on("close",()=>sockets.delete(client));client.on("error",()=>{});
      const upstream=net.connect(originPort,"127.0.0.1",()=>{
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");if(head.length)upstream.write(head);client.pipe(upstream);upstream.pipe(client);
      });
      sockets.add(upstream);upstream.on("close",()=>sockets.delete(upstream));upstream.on("error",()=>client.destroy());
      client.on("close",()=>upstream.destroy());
    });
    const proxyPort=await listen(proxy);
    const moduleUrl=new URL("../server/model-transport.mjs",import.meta.url).href;
    const body=JSON.stringify({model:"local-reference",chat_template_kwargs:{enable_thinking:false}});
    const run=async(trusted,hostname)=>{
      const env={...process.env};delete env.NODE_TLS_REJECT_UNAUTHORIZED;delete env.NODE_EXTRA_CA_CERTS;
      if(trusted)env.NODE_EXTRA_CA_CERTS=cert;
      const source='import {createModelFetch} from '+JSON.stringify(moduleUrl)+';try{const r=await createModelFetch({proxyUrl:'+JSON.stringify("http://127.0.0.1:"+proxyPort)+'})('+JSON.stringify("https://"+hostname+":"+originPort+"/v1/chat/completions")+',{method:"POST",body:'+JSON.stringify(body)+',signal:AbortSignal.timeout(4000)});console.log(await r.text());}catch(e){console.error(e.code||e.message);process.exitCode=1;}';
      const child=spawn(process.execPath,["--input-type=module","-e",source],{env,stdio:["ignore","pipe","pipe"]});
      let stdout="",stderr="";child.stdout.on("data",c=>stdout+=c);child.stderr.on("data",c=>stderr+=c);
      return await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",exit=>resolve({exit,stdout,stderr}));});
    };
    const untrusted=await run(false,"model.test");assert.equal(untrusted.exit,1);assert.match(untrusted.stderr,/CERT|SELF_SIGNED/);
    const trusted=await run(true,"model.test");assert.equal(trusted.exit,0,trusted.stderr);assert.deepEqual(JSON.parse(trusted.stdout),{ok:true});assert.equal(receivedBody,body);
    const wrongHost=await run(true,"wrong.test");assert.equal(wrongHost.exit,1);assert.match(wrongHost.stderr,/ALTNAME|HOSTNAME/);
    assert.equal(connects,3);
  } finally {
    for(const socket of sockets)socket.destroy();
    if(proxy)await close(proxy);if(origin)await close(origin);
    await rm(dir,{recursive:true,force:true});
  }
});

test("model proxy honours cancellation and bounds response buffering", async () => {
  const proxy=http.createServer((req,res)=>{
    if(req.url.includes("/large")){res.writeHead(200);res.end("x".repeat(80001));}
  });
  const port=await listen(proxy);
  try{
    const modelFetch=createModelFetch({proxyUrl:"http://127.0.0.1:"+port});
    await assert.rejects(modelFetch("http://model.invalid/wait",{signal:AbortSignal.timeout(100)}),error=>error.name==="AbortError");
    await assert.rejects(modelFetch("http://model.invalid/large",{signal:AbortSignal.timeout(1000)}));
  }finally{await close(proxy);}
});
