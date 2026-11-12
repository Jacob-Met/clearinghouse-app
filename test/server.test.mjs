import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { server } from "../server.mjs";

test("server exact allowlist, methods, and safety headers", async () => {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const path of ["/", "/app.mjs", "/controller.mjs", "/core.mjs", "/ui-utils.mjs", "/change-brief.mjs", "/ai-negotiation.mjs", "/styles.css"]) {
      const response = await fetch(base + path); assert.equal(response.status, 200); assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/); assert.ok((await response.arrayBuffer()).byteLength > 20);
    }
    // Follow the dependencies the browser actually receives, rather than a second allowlist.
    const pending = [new URL("/", base)];
    const visited = new Set();
    while (pending.length) {
      const url = pending.shift();
      if (visited.has(url.href)) continue;
      visited.add(url.href);
      const response = await fetch(url);
      assert.equal(response.status, 200, `Browser dependency is served: ${url.pathname}`);
      const contentType = response.headers.get("content-type") || "";
      const source = await response.text();
      let references = [];
      if (contentType.includes("text/html")) {
        references = [...source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
      } else if (contentType.includes("javascript")) {
        references = [...source.matchAll(/^\s*(?:import|export)\s+(?:[^;\n]*?\sfrom\s*)?["']([^"']+)["']/gm)].map(match => match[1]);
      } else if (contentType.includes("text/css")) {
        references = [...source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/g)].map(match => match[1]);
      }
      for (const reference of references) {
        if (/^(?:data:|https?:|#)/.test(reference)) continue;
        pending.push(new URL(reference, url));
      }
    }
    assert.ok(visited.has(new URL("/participant-colors.mjs", base).href), "Real app graph includes participant colors");
    const foreign = await fetch(base + "/api/paypal-sandbox", {method:"POST",headers:{"Content-Type":"application/json",Origin:"https://untrusted.example"},body:"{}"});
    assert.equal(foreign.status,403);
    const malformed = await fetch(base + "/api/paypal-sandbox", {method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({project:"not-json"})});
    assert.equal(malformed.status,400);
    assert.equal((await malformed.json()).ok,false);
    const invalidEnvelope = await fetch(base + "/api/paypal-sandbox",{method:"POST",headers:{"Content-Type":"application/json",Origin:base},body:JSON.stringify({project:"",amount:"100.00"})});
    assert.equal(invalidEnvelope.status,400);
    assert.equal((await fetch(base + "/api/paypal-sandbox")).status,404);
    assert.equal((await fetch(base + "/missing.mjs")).status, 404);
    assert.equal((await fetch(base + "/../package.json")).status, 404);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 404);
    const head = await fetch(base + "/", { method: "HEAD" }); assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
