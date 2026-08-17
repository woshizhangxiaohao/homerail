import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let sequence = 0;
let activeSession = "";
let activeMessage = "";
let activePrompt = [];

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function event(sessionId, type, data) {
  write({
    jsonrpc: "2.0",
    method: "session.event",
    params: { sessionId, event: { type, seq: sequence++, time: Date.now(), data } },
  });
}

function status(sessionId, value) {
  write({ jsonrpc: "2.0", method: "session.status", params: { sessionId, status: value } });
}

function finish(reason = "completed") {
  const sessionId = activeSession;
  event(sessionId, "assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "reasoning-delta", index: 0, text: "checking" },
  });
  event(sessionId, "tool/call", {
    turn: 1,
    step: 1,
    callId: "call-1",
    name: "mcp__homerail__handoff",
    arguments: JSON.stringify({ port: "done", content: "ok" }),
  });
  event(sessionId, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      id: "tool-result-1",
      role: "user",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        content: [{ type: "text", text: "accepted" }],
        isError: false,
      }],
      source: { kind: "tool", callId: "call-1" },
    },
  });
  event(sessionId, "assistant/chunk", {
    turn: 1,
    step: 1,
    chunk: { type: "text-delta", index: 1, text: "finished" },
  });
  event(sessionId, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "finished" }],
      source: { kind: "model", provider: "deepseek-official", model: "test-model" },
    },
    usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2 },
  });
  event(sessionId, "turn/end", { turn: 1, reason });
  status(sessionId, "idle");
}

function startPrompt(params) {
  activeSession = String(params.sessionId);
  activeMessage = `message-${Date.now()}`;
  activePrompt = Array.isArray(params.contentBlocks) ? params.contentBlocks : [];
  return activeMessage;
}

lines.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (process.env.DSH_FAKE_RECORD_FILE) {
      appendFileSync(process.env.DSH_FAKE_RECORD_FILE, `${JSON.stringify({
        params: request.params,
        cordisConfig: process.env.DSH_CORDIS_CONFIG,
        baseUrl: process.env.DEEPSEEK_BASE_URL,
        reasoningEffort: process.env.DSH_REASONING_EFFORT,
        managerToken: process.env.HOMERAIL_WORKER_TOKEN,
      })}\n`);
    }
    response(request.id, { serverInfo: { name: "deepseek-harness-sdk-runtime", version: "fake" } });
    return;
  }
  if (request.method === "session/prompt") {
    const messageId = startPrompt(request.params);
    response(request.id, { messageId });
    event(activeSession, "agent/inbox/spliced", {
      target: "next-turn",
      start: 0,
      inserted: [{ id: messageId, role: "user", content: activePrompt, source: { kind: "user" } }],
    });
    status(activeSession, "running");
    if (process.env.DSH_FAKE_READY_FILE) appendFileSync(process.env.DSH_FAKE_READY_FILE, "ready\n");
    if (!process.env.DSH_FAKE_WAIT_FOR) {
      finish(process.env.DSH_FAKE_TURN_ERROR
        ? {
            kind: "error",
            error: {
              code: "UPSTREAM_REJECTED",
              message: process.env.DSH_FAKE_TURN_ERROR,
              status: 502,
            },
          }
        : "completed");
    }
    return;
  }
  if (request.method === "session/steer") {
    response(request.id, { messageId: "steer-1" });
    if (process.env.DSH_FAKE_WAIT_FOR === "steer") finish();
    return;
  }
  if (request.method === "session/cancel") {
    response(request.id, { accepted: true });
    if (process.env.DSH_FAKE_WAIT_FOR === "cancel") finish("cancelled");
    return;
  }
  if (request.method === "shutdown") {
    response(request.id, {});
    setImmediate(() => process.exit(0));
    return;
  }
  write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unknown method" } });
});
