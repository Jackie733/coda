import type { Provider } from "./application.js";

export type ModelRequest = Readonly<{
  endpoint: string;
  serializedBody: string;
}>;

export type Environment = Readonly<Record<string, string | undefined>>;

export type ModelProviderOptions = Readonly<{
  env: Environment;
  fetchImpl?: typeof fetch;
}>;

export function createOpenAICompatibleProvider(
  options: ModelProviderOptions,
): Provider<ModelRequest, Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  return Object.freeze({
    async send(request: ModelRequest): Promise<Response> {
      // Resolve credentials only inside send(), which is reached after application approval.
      const apiKey = options.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("已确认，但未发送：进程环境中没有 OPENAI_API_KEY。");
      return fetchImpl(request.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: request.serializedBody,
        signal: AbortSignal.timeout(30_000),
      });
    },
  });
}
