import { bodyLimit } from "hono/body-limit";
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

type AppOptions = {
  env?: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
};

type AgentSettings = {
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  maxToolCalls: number;
  maxMessageLength: number;
  timeoutMs: number;
};

const MAX_BODY_SIZE = 16 * 1024;

const tools = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "Get the current time in an IANA time zone, such as Asia/Taipei.",
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
  {
    type: "function",
    function: {
      name: "calculate",
      description: "Evaluate a basic arithmetic expression using +, -, *, /, and parentheses.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description: "Arithmetic expression, for example (12 + 8) / 4.",
          },
        },
        required: ["expression"],
        additionalProperties: false,
      },
    },
  },
];

function readInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function settingsFrom(env: Readonly<Record<string, string | undefined>>): AgentSettings {
  return {
    apiKey: env.OPENAI_API_KEY,
    baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
    model: env.OPENAI_MODEL || "gpt-4.1-mini",
    maxTurns: readInteger(env, "MAX_AGENT_TURNS", 4, 1, 12),
    maxToolCalls: readInteger(env, "MAX_TOOL_CALLS", 8, 1, 32),
    maxMessageLength: readInteger(env, "MAX_MESSAGE_LENGTH", 4_000, 1, 16_000),
    timeoutMs: readInteger(env, "OPENAI_TIMEOUT_MS", 30_000, 1_000, 120_000),
  };
}

function parseArguments(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getCurrentTime(argumentsText: string): string {
  const args = parseArguments(argumentsText);
  if (!args || Object.keys(args).some((key) => key !== "timeZone")) {
    return JSON.stringify({ error: "Invalid arguments." });
  }
  if (args.timeZone !== undefined && typeof args.timeZone !== "string") {
    return JSON.stringify({ error: "timeZone must be a string." });
  }

  const timeZone = (args.timeZone as string | undefined) || "UTC";
  try {
    const now = new Date();
    const localTime = new Intl.DateTimeFormat("zh-TW", {
      dateStyle: "full",
      timeStyle: "long",
      timeZone,
    }).format(now);
    return JSON.stringify({ timeZone, iso: now.toISOString(), localTime });
  } catch {
    return JSON.stringify({ error: "Invalid time zone. Use a valid IANA time zone." });
  }
}

class ArithmeticParser {
  private index = 0;
  private depth = 0;

  constructor(private readonly expression: string) {}

  parse(): number {
    const result = this.parseExpression();
    this.skipWhitespace();
    if (this.index !== this.expression.length || !Number.isFinite(result)) {
      throw new Error("Invalid arithmetic expression.");
    }
    return result;
  }

  private parseExpression(): number {
    let value = this.parseTerm();
    while (true) {
      this.skipWhitespace();
      const operator = this.expression[this.index];
      if (operator !== "+" && operator !== "-") return value;
      this.index += 1;
      const right = this.parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parseUnary();
    while (true) {
      this.skipWhitespace();
      const operator = this.expression[this.index];
      if (operator !== "*" && operator !== "/") return value;
      this.index += 1;
      const right = this.parseUnary();
      if (operator === "/" && right === 0) throw new Error("Division by zero.");
      value = operator === "*" ? value * right : value / right;
    }
  }

  private parseUnary(): number {
    this.skipWhitespace();
    const operator = this.expression[this.index];
    if (operator === "+" || operator === "-") {
      this.index += 1;
      const value = this.parseUnary();
      return operator === "-" ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.skipWhitespace();
    if (this.expression[this.index] === "(") {
      this.depth += 1;
      if (this.depth > 32) throw new Error("Expression is too deeply nested.");
      this.index += 1;
      const value = this.parseExpression();
      this.skipWhitespace();
      if (this.expression[this.index] !== ")") throw new Error("Unmatched parenthesis.");
      this.index += 1;
      this.depth -= 1;
      return value;
    }

    const match = this.expression.slice(this.index).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);
    if (!match) throw new Error("Expected a number.");
    this.index += match[0].length;
    return Number(match[0]);
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.expression[this.index] ?? "")) this.index += 1;
  }
}

function calculate(argumentsText: string): string {
  const args = parseArguments(argumentsText);
  if (
    !args ||
    Object.keys(args).some((key) => key !== "expression") ||
    typeof args.expression !== "string" ||
    !args.expression.trim() ||
    args.expression.length > 200
  ) {
    return JSON.stringify({ error: "Provide an arithmetic expression of at most 200 characters." });
  }

  try {
    const result = new ArithmeticParser(args.expression).parse();
    return JSON.stringify({ expression: args.expression, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid arithmetic expression.";
    return JSON.stringify({ error: message });
  }
}

function parseAssistantMessage(value: unknown): AssistantMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const message = value as Record<string, unknown>;
  if (
    message.role !== "assistant" ||
    (message.content !== null && typeof message.content !== "string")
  ) {
    return null;
  }

  if (message.tool_calls === undefined) {
    return { role: "assistant", content: message.content as string | null };
  }
  if (!Array.isArray(message.tool_calls)) return null;

  const calls: ToolCall[] = [];
  for (const value of message.tool_calls) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const call = value as Record<string, unknown>;
    if (
      typeof call.id !== "string" ||
      !call.id ||
      call.type !== "function" ||
      !call.function ||
      typeof call.function !== "object" ||
      Array.isArray(call.function)
    ) {
      return null;
    }
    const fn = call.function as Record<string, unknown>;
    if (typeof fn.name !== "string" || typeof fn.arguments !== "string") return null;
    calls.push({ id: call.id, type: "function", function: { name: fn.name, arguments: fn.arguments } });
  }
  return { role: "assistant", content: message.content as string | null, tool_calls: calls };
}

export function createApp(options: AppOptions = {}): Hono {
  const env = options.env ?? process.env;
  const settings = settingsFrom(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const app = new Hono();

  app.use("/agent", bodyLimit({
    maxSize: MAX_BODY_SIZE,
    onError: (c) => c.json({ error: "Request body exceeds the 16 KB limit." }, 413),
  }));

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
    if (message.length > settings.maxMessageLength) {
      return c.json({ error: `"message" must be ${settings.maxMessageLength} characters or fewer.` }, 400);
    }
    if (!settings.apiKey) {
      return c.json({ error: "OPENAI_API_KEY is not configured." }, 503);
    }

    const messages: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are a concise assistant. Use get_current_time for current time or date questions and calculate for arithmetic. Do not claim you used a tool unless you did.",
      },
      { role: "user", content: message.trim() },
    ];
    let toolCallCount = 0;

    try {
      for (let turn = 0; turn < settings.maxTurns; turn += 1) {
        const response = await fetchImpl(`${settings.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${settings.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: settings.model,
            messages,
            tools,
            tool_choice: "auto",
            temperature: 0.2,
          }),
          signal: AbortSignal.timeout(settings.timeoutMs),
        });

        if (!response.ok) {
          return c.json({ error: "Model provider request failed.", status: response.status }, 502);
        }

        const completion: unknown = await response.json().catch(() => null);
        const choices =
          completion && typeof completion === "object" && !Array.isArray(completion)
            ? (completion as Record<string, unknown>).choices
            : null;
        const firstChoice = Array.isArray(choices) ? choices[0] : null;
        const assistantMessage =
          firstChoice && typeof firstChoice === "object" && !Array.isArray(firstChoice)
            ? parseAssistantMessage((firstChoice as Record<string, unknown>).message)
            : null;
        if (!assistantMessage) {
          return c.json({ error: "Model provider returned an invalid response." }, 502);
        }

        messages.push(assistantMessage);
        const calls = assistantMessage.tool_calls ?? [];
        if (calls.length === 0) {
          return c.json({ reply: assistantMessage.content ?? "" });
        }

        toolCallCount += calls.length;
        if (toolCallCount > settings.maxToolCalls) {
          return c.json({ error: "Agent reached the tool-call limit." }, 502);
        }

        for (const call of calls) {
          const result =
            call.function.name === "get_current_time"
              ? getCurrentTime(call.function.arguments)
              : call.function.name === "calculate"
                ? calculate(call.function.arguments)
                : JSON.stringify({ error: "Tool not available." });
          messages.push({ role: "tool", tool_call_id: call.id, content: result });
        }
      }

      return c.json({ error: "Agent reached the maximum number of turns." }, 502);
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return c.json({ error: "Model provider request timed out." }, 504);
      }
      return c.json({ error: "Agent request failed." }, 502);
    }
  });

  return app;
}
