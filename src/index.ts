import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type AssistantMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: ToolCall[];
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

type CompletionResponse = {
  choices?: Array<{ message?: AssistantMessage }>;
};

const app = new Hono();
const maxTurns = 4;
const maxToolCalls = 8;

const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current time in an IANA time zone, such as Asia/Hong_Kong.",
      parameters: {
        type: "object",
        properties: {
          timeZone: {
            type: "string",
            description: "IANA time zone; defaults to UTC.",
          },
        },
        additionalProperties: false,
      },
    },
  },
];

function getCurrentTime(argumentsText: string): string {
  try {
    const parsed: unknown = JSON.parse(argumentsText || "{}");
    const args = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const timeZone = typeof args.timeZone === "string" ? args.timeZone : "UTC";
    const now = new Date();
    const localTime = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
    }).format(now);

    return JSON.stringify({ timeZone, iso: now.toISOString(), localTime });
  } catch {
    return JSON.stringify({ error: "Invalid arguments or time zone. Use a valid IANA time zone." });
  }
}

app.get("/health", (c) => c.json({ ok: true }));

app.post("/agent", async (c) => {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }

  const message = (body as Record<string, unknown>).message;
  if (typeof message !== "string" || !message.trim()) {
    return c.json({ error: 'A non-empty "message" string is required.' }, 400);
  }
  if (message.length > 4_000) {
    return c.json({ error: '"message" must be 4,000 characters or fewer.' }, 400);
  }
  if (!process.env.OPENAI_API_KEY) {
    return c.json({ error: "OPENAI_API_KEY is not configured." }, 503);
  }

  const baseUrl = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a concise assistant. Use get_current_time when the user asks for the current time or date. Do not claim you used a tool unless you did.",
    },
    { role: "user", content: message.trim() },
  ];
  let toolCallCount = 0;

  try {
    for (let turn = 0; turn < maxTurns; turn += 1) {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
          messages,
          tools,
          tool_choice: "auto",
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        return c.json({ error: "Model provider request failed.", status: response.status }, 502);
      }

      const completion = (await response.json()) as CompletionResponse;
      const assistantMessage = completion.choices?.[0]?.message;
      if (!assistantMessage) {
        return c.json({ error: "Model provider returned an empty response." }, 502);
      }

      messages.push(assistantMessage);
      const calls = assistantMessage.tool_calls ?? [];
      if (calls.length === 0) {
        return c.json({ reply: assistantMessage.content ?? "" });
      }

      toolCallCount += calls.length;
      if (toolCallCount > maxToolCalls) {
        return c.json({ error: "Agent reached the tool-call limit." }, 502);
      }

      for (const call of calls) {
        const result =
          call.function.name === "get_current_time"
            ? getCurrentTime(call.function.arguments)
            : JSON.stringify({ error: "Tool not available." });
        messages.push({ role: "tool", tool_call_id: call.id, content: result });
      }
    }

    return c.json({ error: "Agent reached the maximum number of turns." }, 502);
  } catch {
    return c.json({ error: "Agent request failed." }, 502);
  }
});

const port = Number(process.env.PORT || 3000);
serve({ fetch: app.fetch, port });
console.log(`Agent API listening on http://localhost:${port}`);
