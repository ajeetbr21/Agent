// Non-destructive delivery check against the ALREADY-RUNNING local bridge (the IDE's bridge that a
// real browser tab is paired to). It confirms the live bridge forwards a real, framed codebase-index
// chunk to the connected browser. It inserts (does NOT submit — autoSubmit:false) so it won't post to
// the provider or consume the session; you can just clear the chat input afterward.
//
// Run: node scripts/verify-live-bridge.mjs [port] [token]
//   The token is the IDE's pairing token ("LeechCode: Copy Bridge Pairing Token"); it may also be
//   supplied via the WEBCHAT_BRIDGE_TOKEN environment variable to keep it out of shell history.

import { planIndexChunks } from "../dist/prompt/indexChunker.js";

const port = Number(process.argv[2] || 53451);
const token = process.argv[3] || process.env.WEBCHAT_BRIDGE_TOKEN || "";
if (!token) {
  console.error("\n❌ Pass the pairing token as the 2nd argument or set WEBCHAT_BRIDGE_TOKEN.");
  console.error("   Copy it in the editor with \"LeechCode: Copy Bridge Pairing Token\".\n");
  process.exit(1);
}
const base = `http://127.0.0.1:${port}`;

async function main() {
  const headers = { "x-webchat-token": token };
  const health = await fetch(`${base}/health`, { headers }).then((r) => r.json());
  if (health.authenticated !== true) throw new Error("bridge rejected the pairing token");
  console.log(`\nBridge health: running=${health.running} port=${health.port} browsers=${health.browserClients?.length ?? 0}`);
  if (!health.running) throw new Error("bridge is not running");
  if (!health.browserClients?.length) throw new Error("no browser is paired to the bridge");

  // Build a real, small, framed chunk so the browser receives an authentic index message.
  const files = [
    { path: "WORKSPACE_FILE_TREE.txt", content: ["src/a.ts", "src/b.ts", "README.md"].join("\n") },
    { path: "src/a.ts", content: "export const a = () => 'hello from chunked index probe';\n".repeat(6) },
    { path: "src/b.ts", content: "export const b = 42;\n".repeat(6) }
  ];
  const plan = planIndexChunks(files, { maxChars: 1500, providerLabel: "live-probe" });
  const chunk = plan.chunks[0];
  console.log(`Planned ${plan.chunks.length} chunk(s); delivering part ${chunk.index}/${chunk.total} (${chunk.chars} chars) with autoSubmit:false.\n`);

  const res = await fetch(`${base}/prompt`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      providerId: health.browserClients[0]?.providerId || "chatgpt",
      chatUrl: "https://chatgpt.com/",
      prompt: chunk.text,
      promptNumber: 0,
      expectedAction: "submit",
      autoSubmit: false,
      chunkIndex: chunk.index,
      chunkTotal: chunk.total
    })
  });
  const body = await res.json();
  console.log(`POST /prompt -> HTTP ${res.status}, delivered to ${body.sent} browser client(s).`);
  if (res.status !== 200 || !(body.sent >= 1)) {
    throw new Error("bridge did not forward the chunk to a connected browser");
  }
  console.log("\n✅ Live bridge delivered a real framed index chunk to the connected browser.");
  console.log("   (Inserted into the chat input, not submitted — clear the box in your browser to discard.)\n");
}

main().catch((err) => {
  console.error("\n❌ Live-bridge check FAILED:", err?.message || err);
  process.exit(1);
});
