import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.js";

const jsonResponse = (message: unknown) => Response.json({ choices: [{ message }] });
const validEnv = { OPENAI_API_KEY: "test-key" };

const postAgent = (app: ReturnType<typeof createApp>, body: string | object) =>
  app.request("/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

test("GET /health does not call a model provider", async () => {
  const app = createApp({ fetchImpl: async () => { throw new Error("should not fetch"); } });
  const response = await app.request("/health");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("POST /agent validates JSON and message input", async () => {
  const app = createApp({ env: validEnv, fetchImpl: async () => { throw new Error("should not fetch"); } });
  assert.equal((await postAgent(app, "not-json")).status, 400);
  assert.equal((await postAgent(app, { message: "  " })).status, 400);
  assert.equal((await postAgent(app, { message: 123 })).status, 400);
});

test("POST /agent rejects oversized request bodies", async () => {
  const app = createApp({ env: validEnv, fetchImpl: async () => { throw new Error("should not fetch"); } });
  const response = await postAgent(app, { message: "x".repeat(17_000) });
  assert.equal(response.status, 413);
});

test("POST /agent reports missing API configuration without calling a provider", async () => {
  const app = createApp({ fetchImpl: async () => { throw new Error("should not fetch"); } });
  const response = await postAgent(app, { message: "hello" });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "OPENAI_API_KEY is not configured." });
});

test("POST /agent returns a plain assistant reply", async () => {
  let requestUrl = "";
  const app = createApp({
    env: validEnv,
    fetchImpl: async (input) => {
      requestUrl = String(input);
      return jsonResponse({ role: "assistant", content: "Hello!" });
    },
  });
  const response = await postAgent(app, { message: "hello" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "Hello!" });
  assert.equal(requestUrl, "https://api.openai.com/v1/chat/completions");
});

test("agent executes the calculator and time tools before returning a reply", async () => {
  let requestCount = 0;
  let secondRequest: { messages: Array<{ role: string; content?: string; tool_call_id?: string }> } | undefined;
  const app = createApp({
    env: { ...validEnv, OPENAI_BASE_URL: "https://provider.example/v1/" },
    fetchImpl: async (input, init) => {
      assert.equal(String(input), "https://provider.example/v1/chat/completions");
      requestCount += 1;
      if (requestCount === 1) {
        return jsonResponse({
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "calc-1", type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression: "(2 + 3) * 4 / 2" }) } },
            { id: "time-1", type: "function", function: { name: "get_current_time", arguments: JSON.stringify({ timeZone: "Asia/Taipei" }) } },
          ],
        });
      }
      secondRequest = JSON.parse(String(init?.body)) as typeof secondRequest;
      return jsonResponse({ role: "assistant", content: "The result is 10." });
    },
  });

  const response = await postAgent(app, { message: "Calculate it and tell me the time." });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { reply: "The result is 10." });
  assert.equal(requestCount, 2);
  const toolMessages = secondRequest?.messages.filter((message) => message.role === "tool") ?? [];
  assert.equal(toolMessages.length, 2);
  assert.deepEqual(JSON.parse(toolMessages[0].content ?? "{}"), { expression: "(2 + 3) * 4 / 2", result: 10 });
  assert.equal(JSON.parse(toolMessages[1].content ?? "{}").timeZone, "Asia/Taipei");
});

test("calculator rejects executable or malformed expressions without evaluating code", async () => {
  let toolResult: unknown;
  const app = createApp({
    env: validEnv,
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content?: string }> };
      if (request.messages.some((message) => message.role === "tool")) {
        const resultMessage = request.messages.find((message) => message.role === "tool");
        toolResult = JSON.parse(resultMessage?.content ?? "{}");
        return jsonResponse({ role: "assistant", content: "Done." });
      }
      return jsonResponse({
        role: "assistant",
        content: null,
        tool_calls: [{ id: "calc", type: "function", function: { name: "calculate", arguments: JSON.stringify({ expression: "process.exit()" }) } }],
      });
    },
  });
  const response = await postAgent(app, { message: "Calculate process.exit()." });
  assert.equal(response.status, 200);
  assert.deepEqual(toolResult, { error: "Expected a number." });
});

test("agent enforces the configured tool-call limit", async () => {
  const app = createApp({
    env: { ...validEnv, MAX_TOOL_CALLS: "1" },
    fetchImpl: async () => jsonResponse({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "1", type: "function", function: { name: "calculate", arguments: "{}" } },
        { id: "2", type: "function", function: { name: "calculate", arguments: "{}" } },
      ],
    }),
  });
  const response = await postAgent(app, { message: "Compute." });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Agent reached the tool-call limit." });
});

test("provider HTTP errors are translated to a gateway error", async () => {
  const app = createApp({ env: validEnv, fetchImpl: async () => new Response("unavailable", { status: 429 }) });
  const response = await postAgent(app, { message: "hello" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Model provider request failed.", status: 429 });
});

test("malformed provider responses do not crash the request", async () => {
  const app = createApp({ env: validEnv, fetchImpl: async () => Response.json({ choices: [{ message: { role: "system", content: "no" } }] }) });
  const response = await postAgent(app, { message: "hello" });
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: "Model provider returned an invalid response." });
});

test("provider timeouts return HTTP 504", async () => {
  const app = createApp({
    env: validEnv,
    fetchImpl: async () => { throw new DOMException("Timed out", "TimeoutError"); },
  });
  const response = await postAgent(app, { message: "hello" });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "Model provider request timed out." });
});
