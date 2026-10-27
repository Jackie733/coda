import type { Provider } from "../application.js";
import type { ModelRequest } from "../model-provider.js";
import { CredentialDurabilityUncertainError } from "./credential-store.js";

export const SIWC_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
export const SIWC_MODELS_ENDPOINT = "https://api.openai.com/v1/models";
export const SIWC_USAGE_URL = "https://chatgpt.com/settings/usage";

export type SiwcModel = Readonly<{ slug: string; displayName: string }>;
export type ResponseBodyShape = "error-object" | "detail-object" | "object" | "array" | "scalar" | "empty" | "unreadable";

export class SiwcProviderError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly bodyShape: ResponseBodyShape | null;
  constructor(input: Readonly<{
    message: string;
    status?: number | null;
    code?: string | null;
    param?: string | null;
    requestId?: string | null;
    bodyShape?: ResponseBodyShape | null;
  }>) {
    super(input.message);
    this.name = "SiwcProviderError";
    this.status = input.status ?? null;
    this.code = input.code ?? null;
    this.param = input.param ?? null;
    this.requestId = input.requestId ?? null;
    this.bodyShape = input.bodyShape ?? null;
  }

  toUserMessage(): string {
    const details = [
      this.status === null ? null : `HTTP ${this.status}`,
      this.code ? `error.code=${this.code}` : null,
      this.param ? `error.param=${this.param}` : null,
      this.bodyShape ? `response body shape=${this.bodyShape}` : null,
      this.requestId ? `request ID=${this.requestId}` : null,
    ].filter(Boolean);
    return `${this.message}${details.length ? `\n诊断信息：${details.join("；")}` : ""}`;
  }
}

export type SiwcResponsesProviderOptions = Readonly<{
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeRequestId(headers: Headers): string | null {
  const value = headers.get("openai-request-id") ?? headers.get("x-request-id");
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : null;
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : null;
}

function safeParam(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.\[\]-]{1,128}$/.test(value) ? value : null;
}

function errorDetails(body: unknown): Readonly<{ code: string | null; param: string | null }> {
  if (!isRecord(body)) return { code: null, param: null };
  const response = isRecord(body.response) ? body.response : null;
  const sources = [
    response && isRecord(response.error) ? response.error : null,
    isRecord(body.error) ? body.error : null,
    isRecord(body.detail) ? body.detail : null,
    body,
  ].filter((source): source is Record<string, unknown> => source !== null);
  return {
    code: sources.map((source) => safeCode(source.code)).find((value) => value !== null) ?? null,
    param: sources.map((source) => safeParam(source.param)).find((value) => value !== null) ?? null,
  };
}

function bodyShape(body: unknown): ResponseBodyShape {
  if (body === null || body === undefined) return "empty";
  if (Array.isArray(body)) return "array";
  if (!isRecord(body)) return "scalar";
  if (isRecord(body.error)) return "error-object";
  if (typeof body.detail === "string" || isRecord(body.detail)) return "detail-object";
  return "object";
}

function messageForCode(code: string | null, param: string | null, status?: number): string | null {
  const httpStatus = status === undefined ? "" : ` (HTTP ${status})`;
  if (code === "subscription_sharing_usage_limit_exceeded") {
    return `A ChatGPT plan or app-specific usage limit was reached${httpStatus}. This code cannot distinguish an app-specific limit from a shared plan limit and does not indicate a reset time. Pause plan requests and review the applicable limit at ${SIWC_USAGE_URL}; no API-key fallback was used.`;
  }
  if (code === "subscription_sharing_usage_unavailable") {
    return `ChatGPT plan usage availability could not be checked${httpStatus}; preserve credentials and retry later with bounded backoff. No API-key fallback was used.`;
  }
  if (code === "subscription_sharing_user_unavailable") {
    return `ChatGPT user or workspace information is temporarily unavailable${httpStatus}; preserve credentials and retry later with bounded backoff. No API-key fallback was used.`;
  }
  if (code === "subscription_sharing_user_not_eligible") {
    return `ChatGPT plan usage is unavailable for the selected user, workspace, or policy${httpStatus}; do not repeat this request or loop through OAuth. No API-key fallback was used.`;
  }
  if (code === "subscription_sharing_unsupported_capability" || code === "unsupported_parameter" || code === "unsupported_capability" || code === "unsupported_value") {
    return `OpenAI rejected an unsupported SIWC capability${param ? ` (error.param=${param})` : "; inspect error.param"}${httpStatus}; remove or revise the unsupported input, tool, execution feature, model, or service-tier override, then retry with a changed request. Do not resend the same body; no API-key fallback was used.`;
  }
  if (code === "subscription_sharing_route_not_supported") {
    return `The SIWC route is not supported${httpStatus}; verify the method and URL. This integration only allows POST ${SIWC_RESPONSES_ENDPOINT}; do not switch to another route or client type. No API-key fallback was used.`;
  }
  if (code === "subscription_sharing_invalid_user") {
    return `The ChatGPT subscriber context could not be validated${httpStatus}; preserve the request ID and diagnose the credential/account state. Sign in again only after confirmed revocation or a terminal refresh failure; no API-key fallback was used.`;
  }
  if (code === "chatpass_v2_scope_not_authorized" || code === "chatpass_v2_invalid_authorization_context") {
    return `The signed SIWC permission context does not authorize this operation${httpStatus}; check the issued client and grant configuration. Do not blindly retry or change billing mode; no API-key fallback was used.`;
  }
  return null;
}

function messageForStatus(status: number, code: string | null, param: string | null): string {
  const mapped = messageForCode(code, param, status);
  if (mapped) return mapped;
  if (status === 401) return "SIWC direct admission rejected the signed identity or permission (HTTP 401); check the selected account and granted scopes, and preserve the request ID for diagnosis. No API-key fallback was used.";
  if (status === 403) return "SIWC direct admission was blocked by a policy, permission, or serving-region check (HTTP 403); verify account/client configuration and preserve the request ID. No API-key fallback was used.";
  if (status === 503) return "SIWC direct routing or admission is temporarily unavailable (HTTP 503); preserve credentials and retry later with bounded backoff. No API-key fallback was used.";
  if (param) {
    return `OpenAI rejected Responses parameter ${param}${code ? ` (${code})` : ""} (HTTP ${status}); check the documented SIWC request fields and selected model. No API-key fallback was used.`;
  }
  return `SIWC Responses API request failed (HTTP ${status}); no API-key fallback was used.`;
}

function validateResponsesRequest(request: ModelRequest): void {
  if (request.endpoint !== SIWC_RESPONSES_ENDPOINT) {
    throw new SiwcProviderError({ message: "SIWC provider only allows the official public Responses endpoint." });
  }
  let body: unknown;
  try { body = JSON.parse(request.serializedBody); } catch {
    throw new SiwcProviderError({ message: "SIWC Responses request preview is not valid JSON." });
  }
  if (!isRecord(body)) throw new SiwcProviderError({ message: "SIWC Responses request must be a JSON object." });
  const allowedFields = new Set(["model", "instructions", "input", "text", "store", "stream"]);
  const unsupportedField = Object.keys(body).find((key) => !allowedFields.has(key));
  if (unsupportedField) {
    const field = safeParam(unsupportedField);
    throw new SiwcProviderError({ message: `SIWC Responses request contains a field unsupported by the current plan-usage preview${field ? ` (${field})` : ""}; remove that field before retrying.` });
  }
  if (typeof body.model !== "string" || !body.model || body.store !== false || body.stream !== true ||
      !Array.isArray(body.input) || body.input.length === 0 || typeof body.instructions !== "string" || !body.instructions ||
      !isRecord(body.text) || !isRecord(body.text.format) || body.text.format.type !== "json_schema" ||
      body.text.format.strict !== true || typeof body.text.format.name !== "string" || !body.text.format.name ||
      !isRecord(body.text.format.schema)) {
    throw new SiwcProviderError({ message: "SIWC Responses request must use instructions, input, strict JSON schema, store:false, and stream:true." });
  }
  for (const item of body.input) {
    if (!isRecord(item)) {
      throw new SiwcProviderError({ message: "The current SIWC preview accepts only plain user input; explicit system or unsupported input types are rejected." });
    }
    const unsupportedInputField = Object.keys(item).find((key) => key !== "role" && key !== "content");
    if (unsupportedInputField) {
      const field = safeParam(unsupportedInputField);
      throw new SiwcProviderError({ message: `The current SIWC preview rejects unsupported input field${field ? ` ${field}` : ""}; use plain user text only.` });
    }
    if (item.role !== "user" || typeof item.content !== "string" || !item.content) {
      throw new SiwcProviderError({ message: "The current SIWC preview accepts only plain user input; explicit system or unsupported input types are rejected." });
    }
  }
}

function eventText(body: Record<string, unknown>): string {
  const response = body.response;
  if (!isRecord(response) || !Array.isArray(response.output)) return "";
  const parts: string[] = [];
  for (const item of response.output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (isRecord(content) && content.type === "output_text" && typeof content.text === "string") {
        parts.push(content.text);
      }
    }
  }
  return parts.join("");
}

function streamFailure(body: Record<string, unknown>, requestId: string | null, status = 200): SiwcProviderError {
  const { code, param } = errorDetails(body);
  const message = messageForCode(code, param, status) ??
    `SIWC Responses stream ended with ${body.type === "response.incomplete" ? "response.incomplete" : "a provider error"}${code ? ` (${code})` : ""}${param ? ` for parameter ${param}` : ""}; no API-key fallback was used.`;
  return new SiwcProviderError({ message, status, code, param, requestId });
}

type ParsedEvent = Readonly<{ type: string; body: Record<string, unknown> }>;

function parseEventBlock(block: string): ParsedEvent | null {
  let eventName = "";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) eventName = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  const serialized = data.join("\n");
  if (serialized === "[DONE]") return { type: "done", body: {} };
  let parsed: unknown;
  try { parsed = JSON.parse(serialized); } catch {
    throw new SiwcProviderError({ message: "SIWC Responses stream contained an invalid event; inference was not marked successful." });
  }
  if (!isRecord(parsed)) throw new SiwcProviderError({ message: "SIWC Responses stream event was not an object; inference was not marked successful." });
  const type = typeof parsed.type === "string" ? parsed.type : eventName;
  return type ? { type, body: parsed } : null;
}

async function consumeCompletedStream(response: Response, fetchRequestId: string | null): Promise<string> {
  if (!response.body) throw new SiwcProviderError({ message: "SIWC Responses API returned no stream; response.completed was not received.", status: response.status, requestId: fetchRequestId });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let pendingCarriageReturn = false;
  let output = "";
  let sawDelta = false;
  let completed = false;
  const consumeBlock = (block: string) => {
    const event = parseEventBlock(block);
    if (!event) return;
    if (event.type === "response.output_text.delta") {
      if (typeof event.body.delta === "string") {
        output += event.body.delta;
        sawDelta = true;
      }
      return;
    }
    if (event.type === "response.completed") {
      completed = true;
      if (!sawDelta) output = eventText(event.body);
      return;
    }
    if (event.type === "response.failed" || event.type === "response.incomplete" || event.type === "error") {
      throw streamFailure(event.body, fetchRequestId, response.status);
    }
  };
  const appendDecodedText = (decoded: string) => {
    if (pendingCarriageReturn) {
      if (decoded.length === 0) return;
      buffer += "\n";
      if (decoded.startsWith("\n")) decoded = decoded.slice(1);
      pendingCarriageReturn = false;
    }
    const endsWithCarriageReturn = decoded.endsWith("\r");
    if (endsWithCarriageReturn) decoded = decoded.slice(0, -1);
    buffer += decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (endsWithCarriageReturn) pendingCarriageReturn = true;
  };
  try {
    while (!completed) {
      const { value, done } = await reader.read();
      if (done) break;
      appendDecodedText(decoder.decode(value, { stream: true }));
      while (true) {
        const separator = buffer.indexOf("\n\n");
        if (separator < 0) break;
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        consumeBlock(block);
        if (completed) break;
      }
    }
    if (!completed) {
      appendDecodedText(decoder.decode());
      if (pendingCarriageReturn) {
        buffer += "\n";
        pendingCarriageReturn = false;
      }
      if (buffer.trim()) consumeBlock(buffer);
    }
  } catch (error) {
    if (error instanceof SiwcProviderError) throw error;
    throw new SiwcProviderError({ message: "SIWC Responses stream was interrupted; response.completed was not received.", requestId: fetchRequestId });
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!completed) throw new SiwcProviderError({ message: "SIWC Responses stream ended without response.completed; inference was not successful.", requestId: fetchRequestId });
  return output;
}

async function safeResponseBody(response: Response): Promise<Readonly<{ parsed: unknown; shape: ResponseBodyShape }>> {
  try {
    const text = await response.text();
    if (!text.trim()) return { parsed: null, shape: "empty" };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { parsed: null, shape: "unreadable" }; }
    return { parsed, shape: bodyShape(parsed) };
  } catch {
    return { parsed: null, shape: "unreadable" };
  }
}

export async function listSiwcModels(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<readonly SiwcModel[]> {
  if (!accessToken) throw new SiwcProviderError({ message: "所选 SIWC 账户没有 access token；请重新登录。" });
  let response: Response;
  try {
    response = await fetchImpl(SIWC_MODELS_ENDPOINT, {
      method: "GET",
      redirect: "error",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new SiwcProviderError({ message: "无法读取所选 SIWC 账户的当前模型目录；未发起推理。" });
  }
  if (!response.ok) {
    const body = await safeResponseBody(response);
    const { code, param } = errorDetails(body.parsed);
    throw new SiwcProviderError({
      message: messageForStatus(response.status, code, param),
      status: response.status,
      code,
      param,
      requestId: safeRequestId(response.headers),
      bodyShape: body.shape,
    });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new SiwcProviderError({ message: "SIWC 模型目录响应格式无效；未发起推理。", status: response.status, requestId: safeRequestId(response.headers) });
  }
  const models: SiwcModel[] = [];
  const seen = new Set<string>();
  for (const item of payload.models) {
    if (!isRecord(item) || item.visibility !== "list" || typeof item.slug !== "string" || !item.slug || typeof item.display_name !== "string" || !item.display_name) continue;
    if (seen.has(item.slug)) continue;
    seen.add(item.slug);
    models.push(Object.freeze({ slug: item.slug, displayName: item.display_name }));
  }
  return Object.freeze(models);
}

export function createSiwcResponsesProvider(options: SiwcResponsesProviderOptions): Provider<ModelRequest, Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return Object.freeze({
    async send(request: ModelRequest): Promise<Response> {
      validateResponsesRequest(request);
      let accessToken: string;
      try {
        accessToken = await options.getAccessToken();
      } catch (error) {
        if (error instanceof CredentialDurabilityUncertainError) {
          throw new SiwcProviderError({ message: "SIWC 凭据文件的新内容已原子替换到目标路径，但目录同步失败、崩溃持久性未确认；本次未发起推理。请运行 `npm run siwc -- status` 检查账户状态后再决定是否重试。" });
        }
        throw new SiwcProviderError({ message: "无法取得所选 SIWC 账户的授权；请检查本机账户状态或重新登录。未发起推理，也未输出凭据。" });
      }
      if (!accessToken) throw new SiwcProviderError({ message: "所选 SIWC 账户没有有效 access token；未发起推理。" });
      let response: Response;
      try {
        response = await fetchImpl(SIWC_RESPONSES_ENDPOINT, {
          method: "POST",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "text/event-stream",
            "Content-Type": "application/json",
          },
          body: request.serializedBody,
          signal: AbortSignal.timeout(120_000),
        });
      } catch {
        throw new SiwcProviderError({ message: "SIWC Responses API 网络请求失败；未尝试其他计费模式。" });
      }
      const requestId = safeRequestId(response.headers);
      if (!response.ok) {
        const body = await safeResponseBody(response);
        const { code, param } = errorDetails(body.parsed);
        throw new SiwcProviderError({
          message: messageForStatus(response.status, code, param),
          status: response.status,
          code,
          param,
          requestId,
          bodyShape: body.shape,
        });
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/event-stream")) {
        throw new SiwcProviderError({ message: "SIWC Responses API 未返回 SSE 流；response.completed 未收到。", status: response.status, requestId, bodyShape: "unreadable" });
      }
      const outputText = await consumeCompletedStream(response, requestId);
      return Response.json({ output_text: outputText }, { status: 200 });
    },
  });
}
