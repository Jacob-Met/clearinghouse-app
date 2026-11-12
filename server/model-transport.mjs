import http from "node:http";
import https from "node:https";

export function modelProxyUrl(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) throw new Error("Invalid model proxy");
  const proxy = new URL(value);
  if (proxy.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(proxy.hostname) ||
      !proxy.port || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash)
    throw new Error("The model proxy must be an existing loopback HTTP proxy");
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (!(major === 22 && minor >= 21 || major === 24 && minor >= 5 || major > 24))
    throw new Error("Model proxy support requires Node 22.21 or 24.5 or later");
  return proxy.href;
}

// Only model requests use these agents. Global fetch and payment requests retain
// their existing transport. Node's own agent handles CONNECT and TLS verification.
export function createModelFetch({ proxyUrl, fetchImpl = globalThis.fetch } = {}) {
  const proxy = modelProxyUrl(proxyUrl);
  if (proxy === undefined) return fetchImpl;
  return async (input, init = {}) => {
    const target = new URL(input);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
      throw new Error("Invalid model endpoint");
    if (init.body !== undefined && typeof init.body !== "string")
      throw new Error("Model transport requires a serialized request body");
    const secure = target.protocol === "https:";
    const transport = secure ? https : http;
    const agent = new transport.Agent({
      keepAlive: false,
      proxyEnv: secure ? { HTTPS_PROXY: proxy } : { HTTP_PROXY: proxy },
      ...(secure ? { rejectUnauthorized: true } : {})
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = transport.request(target, {
          method: init.method || "GET",
          headers: Object.fromEntries(new Headers(init.headers)),
          signal: init.signal,
          agent
        }, response => {
          const chunks = [];
          let size = 0;
          response.on("data", chunk => {
            size += chunk.length;
            if (size > 80000) {
              response.destroy(new Error("Model response exceeds its size limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("aborted", () => reject(new Error("Model response ended early")));
          response.on("end", () => {
            const status = response.statusCode;
            const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
            try { resolve(new Response(body, {status, headers: response.headers})); }
            catch (error) { reject(error); }
          });
        });
        request.on("error", reject);
        request.end(init.body);
      });
    } finally {
      agent.destroy();
    }
  };
}
