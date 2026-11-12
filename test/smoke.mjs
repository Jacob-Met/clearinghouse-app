import assert from "node:assert/strict";
import { once } from "node:events";
import { server } from "../server.mjs";
import { createProject, exportProject, importProject, replayProject } from "../app/core.mjs";
import { creation } from "./fixtures.mjs";

server.listen(0, "127.0.0.1"); await once(server, "listening");
try {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /Group Change Desk/);
  assert.match(html, /id="save-draft"[^>]*type="submit"/);
  assert.match(html, /id="share-review"/);
  assert.match(html, /id="shared-responses"/);
  const plan = html.indexOf('class="panel ledger-plan"');
  const handoff = html.indexOf('class="handoff-flow"');
  assert.ok(plan > 0 && handoff > plan, "Obligation plan must precede recipient/payment handoff");
  assert.ok(html.indexOf('id="change-panel"') > plan && html.indexOf('id="change-panel"') < handoff, "Draft editor must be next to the plan");
  const pending=[new URL("/app.mjs",response.url)], seen=new Set();
  while(pending.length){
    const url=pending.pop();
    if(seen.has(url.href))continue;
    seen.add(url.href);
    const moduleResponse=await fetch(url);
    assert.equal(moduleResponse.status,200,"Browser module must be served: "+url.pathname);
    assert.match(moduleResponse.headers.get("content-type"),/javascript/);
    const source=await moduleResponse.text();
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*)["'](\.[^"']+)["']/g))
      pending.push(new URL(match[1],url));
  }
  const project = createProject(creation());
  assert.equal(replayProject(importProject(exportProject(project))).evaluation.totalMinor, 22000);
  console.log(JSON.stringify({ launched: true, route: "/", sampleTotalMinor: 22000, importRecomputed: true, paymentExecution: "not-exercised" }));
} finally { await new Promise(resolve => server.close(resolve)); }
