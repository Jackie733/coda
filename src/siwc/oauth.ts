import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createLocalJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from "jose";
import {
  ensureSiwcCredentialStore,
  saveSiwcAccount,
  SIWC_PLAN_SCOPE,
  SIWC_REFRESH_SCOPE,
  SIWC_RESOURCE_SCOPE,
  type SiwcAccountRecord,
  type SiwcCredentialStore,
  resolveSiwcStorePath,
} from "./credential-store.js";
import { safeCliErrorText } from "../safe-cli-error.js";
import { isSafeSiwcRequestId, safeSiwcRequestId } from "./request-id.js";

export const SIWC_ISSUER = "https://auth.openai.com";
export const SIWC_DISCOVERY_URL = `${SIWC_ISSUER}/.well-known/openid-configuration`;
export const SIWC_AUTHORIZATION_ENDPOINT = `${SIWC_ISSUER}/api/accounts/authorize`;
export const SIWC_TOKEN_ENDPOINT = `${SIWC_ISSUER}/api/accounts/oauth/token`;
export const SIWC_RESOURCE = "https://api.openai.com/v1";
export const SIWC_CALLBACK_PATH = "/auth/callback";
export const SIWC_IDENTITY_SCOPES = Object.freeze(["openid", "profile", "email"]);
export const SIWC_PLAN_SCOPES = Object.freeze([
  "offline_access",
  "resource.invoke",
  "chatgpt.tokens.use.direct",
]);

export class SiwcAuthorizationError extends Error {
  readonly status?: number;
  readonly requestId?: string;
  readonly code?: string;
  readonly bodyShape?: string;
  readonly issuedClientId?: string;
  constructor(message: string, details: { status?: number; requestId?: string; code?: string; bodyShape?: string; issuedClientId?: string } = {}) {
    const diagnostics = [
      details.status === undefined ? null : `HTTP ${details.status}`,
      details.code ? `OAuth error=${details.code}` : null,
      details.bodyShape ? `response body shape=${details.bodyShape}` : null,
      details.requestId ? `request ID=${details.requestId}` : null,
    ].filter(Boolean);
    super(`${message}${diagnostics.length ? `\n诊断信息：${diagnostics.join("；")}` : ""}`);
    this.name = "SiwcAuthorizationError";
    this.status = details.status;
    this.requestId = details.requestId;
    this.code = details.code;
    this.bodyShape = details.bodyShape;
    this.issuedClientId = details.issuedClientId;
  }
}

export type OidcConfiguration = Readonly<{
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
}>;

type CallbackResult = Readonly<{ code: string; clientId: string }>;
type Listener = Readonly<{
  redirectUri: string;
  result: Promise<CallbackResult>;
  close: () => Promise<void>;
}>;

type IdentityClaims = JWTPayload & Readonly<{
  sub: string;
  email?: string;
  name?: string;
}>;

export type AuthorizationResult = Readonly<{
  account: SiwcAccountRecord;
  planUsageAuthorized: boolean;
  reusedClientId: boolean;
}>;

export type AuthorizationOptions = Readonly<{
  storePath?: string;
  existingClientId?: string;
  requestPlanUsage: boolean;
  promptConsent?: boolean;
  fetchImpl?: typeof fetch;
  openBrowser: (authorizationUrl: string) => Promise<void>;
  timeoutMs?: number;
}>;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const OAUTH_ERROR_CODES = new Set([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);
const OAUTH_BODY_SHAPES = new Set(["error-object", "object", "array", "scalar", "empty"]);

export function safeSiwcAuthorizationErrorText(error: SiwcAuthorizationError, fallback: string): string {
  const allowlistedLiterals: string[] = [];
  if (error.requestId && isSafeSiwcRequestId(error.requestId)) allowlistedLiterals.push(`request ID=${error.requestId}`);
  if (error.code && OAUTH_ERROR_CODES.has(error.code)) allowlistedLiterals.push(`OAuth error=${error.code}`);
  if (error.bodyShape && OAUTH_BODY_SHAPES.has(error.bodyShape)) allowlistedLiterals.push(`response body shape=${error.bodyShape}`);
  // Only this exact validated callback-issued field is public protocol data; all other message text stays scanned.
  if (error.code === "invalid_grant" && error.issuedClientId && isSafeIssuedClientIdForDisplay(error.issuedClientId) && error.message.includes(error.issuedClientId)) {
    allowlistedLiterals.push(error.issuedClientId);
  }
  return safeCliErrorText(error.message, fallback, allowlistedLiterals);
}

function oauthErrorCode(body: unknown): string | undefined {
  return record(body) && typeof body.error === "string" && OAUTH_ERROR_CODES.has(body.error)
    ? body.error
    : undefined;
}

function oauthBodyShape(body: unknown): string {
  if (body === null || body === undefined) return "empty";
  if (Array.isArray(body)) return "array";
  if (!record(body)) return "scalar";
  return typeof body.error === "string" ? "error-object" : "object";
}

export function isSafeIssuedClientId(value: string): boolean {
  return value !== "dynamic_agent_client" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

const ISSUED_CLIENT_ID_SECRET_PATTERNS = [
  /^(?:sk(?:[-_]|$)|sess(?:[-_]|$)|whsec_|github_pat_|gh[pousr]_|xox[baprs]-|api[_-]?key|client[_-]?secret|secret|credential|password|authorization[_-]?code|code[_-]?verifier)/i,
  /^(?:bearer|token|access[_-]?token|refresh[_-]?token|id[_-]?token)/i,
  /(?:^|[._:-])(?:bearer|token|jwt|secret|credential|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|authorization[_-]?code|code[_-]?verifier|password)(?:$|[._:-])/i,
  /^eyJ[A-Za-z0-9_-]{8,}\./,
  /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/,
] as const;

/** Apply credential checks only before displaying an otherwise protocol-valid issued ID. */
function isSafeIssuedClientIdForDisplay(value: string): boolean {
  return isSafeIssuedClientId(value) && !ISSUED_CLIENT_ID_SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function tokenExchangeFailureMessage(code: string | undefined, clientId: string, requestPlanUsage: boolean): string {
  if (code === "invalid_grant") {
    if (isSafeIssuedClientIdForDisplay(clientId)) {
      const planUsageOption = requestPlanUsage ? " --plan-usage" : "";
      return `OpenAI 拒绝了本次授权码 (invalid_grant)；请丢弃本次 authorization code，不要再次提交或复用该 code。该尝试关联的 issued client ID 为 ${clientId}。请用全新授权尝试：\`npm run siwc -- login${planUsageOption} --client-id ${clientId}\`。此命令会复用该 issued ID，不会再次使用 dynamic_agent_client 注册。令牌未保存。`;
    }
    return "OpenAI 拒绝了本次授权码 (invalid_grant)；本次 authorization code 已丢弃且不会重试。回调签发的 client ID 命中终端凭据安全筛查，因此已隐藏该 ID，未显示 fresh-auth 命令。请勿复用该 code，也不要再次使用 dynamic_agent_client 注册。只有在能从可信来源安全确认同一 issued client ID 后，才可开始全新授权；若无法确认，请停止并寻求项目维护者协助。令牌未保存。";
  }
  if (code === "invalid_client") {
    return "OpenAI 拒绝了 SIWC 客户端配置 (invalid_client)；检查并修正官方 client ID/客户端配置后再开始新的授权，不要盲目重试。令牌未保存。";
  }
  return "SIWC token 交换失败；授权码未重试，令牌未保存。";
}

function formBody(entries: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) body.set(key, value);
  return body;
}

export function createPkceValues(): Readonly<{ state: string; nonce: string; verifier: string; challenge: string }> {
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return Object.freeze({ state, nonce, verifier, challenge });
}

export function buildSiwcAuthorizationUrl(input: Readonly<{
  clientId: string;
  hostId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  codeChallenge: string;
  requestPlanUsage: boolean;
  existingAccount?: Pick<SiwcAccountRecord, "idToken" | "email">;
  promptConsent?: boolean;
}>): string {
  const url = new URL(SIWC_AUTHORIZATION_ENDPOINT);
  const isNewRegistration = input.clientId === "dynamic_agent_client";
  const scopes = input.requestPlanUsage
    ? [...SIWC_IDENTITY_SCOPES, ...SIWC_PLAN_SCOPES]
    : [...SIWC_IDENTITY_SCOPES];
  url.search = new URLSearchParams({
    client_id: input.clientId,
    ...(isNewRegistration ? { agent_name_hint: "Coda" } : {}),
    ext_agent_host_id: input.hostId,
    response_type: "code",
    redirect_uri: input.redirectUri,
    scope: scopes.join(" "),
    resource: SIWC_RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: "S256",
    code_challenge: input.codeChallenge,
    ...(input.existingAccount?.idToken ? { id_token_hint: input.existingAccount.idToken } : {}),
    ...(input.existingAccount?.email ? { login_hint: input.existingAccount.email } : {}),
    ...(input.promptConsent ? { prompt: "consent" } : {}),
  }).toString();
  return url.toString();
}

function oneQueryValue(url: URL, key: string): string | null {
  const values = url.searchParams.getAll(key);
  if (values.length > 1) throw new SiwcAuthorizationError("SIWC 回调参数重复；请重新开始登录。");
  return values[0] ?? null;
}

function equalState(received: string | null, expected: string): boolean {
  if (received === null) return false;
  const left = Buffer.from(received, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function startLoopbackListener(
  state: string,
  expectedClientId: string | null,
  timeoutMs: number,
): Promise<Listener> {
  let resolveResult!: (result: CallbackResult) => void;
  let rejectResult!: (error: unknown) => void;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  void result.catch(() => undefined);
  const finish = (callback: () => void) => {
    if (settled) return;
    settled = true;
    if (timeout) clearTimeout(timeout);
    callback();
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== SIWC_CALLBACK_PATH) {
      response.writeHead(404, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Not found.");
      return;
    }
    let returnedState: string | null;
    let oauthError: string | null;
    let code: string | null;
    let returnedClientId: string | null;
    try {
      returnedState = oneQueryValue(url, "state");
      oauthError = oneQueryValue(url, "error");
      code = oneQueryValue(url, "code");
      returnedClientId = oneQueryValue(url, "client_id");
    } catch {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in could not be verified. You may close this window.");
      finish(() => rejectResult(new SiwcAuthorizationError("SIWC 回调参数无效；未兑换授权码。")));
      return;
    }

    if (!equalState(returnedState, state)) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in could not be verified. You may close this window.");
      return;
    }
    if (oauthError) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in was not completed. You may close this window.");
      finish(() => rejectResult(new SiwcAuthorizationError(
        oauthError === "access_denied" ? "用户拒绝了 SIWC 授权；未发起推理。" : "SIWC 授权未完成；未发起推理。",
      )));
      return;
    }
    if (!code || !code.trim()) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in could not be verified. You may close this window.");
      finish(() => rejectResult(new SiwcAuthorizationError("SIWC 回调缺少授权码；未发起推理。")));
      return;
    }
    if (expectedClientId === null && (!returnedClientId || !isSafeIssuedClientId(returnedClientId))) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Registration could not be verified. You may close this window.");
      finish(() => rejectResult(new SiwcAuthorizationError("首次 SIWC 注册回调缺少有效签发的 client ID；未兑换授权码。")));
      return;
    }
    if (expectedClientId !== null && returnedClientId !== null && returnedClientId !== expectedClientId) {
      response.writeHead(400, { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" }).end("Account registration did not match. You may close this window.");
      finish(() => rejectResult(new SiwcAuthorizationError("SIWC 回调 client ID 与所选账户不匹配；未兑换授权码。")));
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
    }).end("Sign in with ChatGPT is complete. You may close this window and return to Coda.");
    finish(() => resolveResult({ code, clientId: expectedClientId ?? returnedClientId! }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  }).catch(() => {
    throw new SiwcAuthorizationError("无法在 127.0.0.1 启动 SIWC 回调监听器；未打开浏览器。 ");
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new SiwcAuthorizationError("无法确定 SIWC 回环回调端口；未打开浏览器。");
  }
  timeout = setTimeout(() => {
    finish(() => rejectResult(new SiwcAuthorizationError("SIWC 登录等待超时；未发起推理。")));
  }, timeoutMs);
  timeout.unref();

  return Object.freeze({
    redirectUri: `http://127.0.0.1:${address.port}${SIWC_CALLBACK_PATH}`,
    result,
    close: async () => {
      if (timeout) clearTimeout(timeout);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  });
}

export async function readSiwcOidcConfiguration(fetchImpl: typeof fetch = fetch): Promise<OidcConfiguration> {
  let response: Response;
  try {
    response = await fetchImpl(SIWC_DISCOVERY_URL, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new SiwcAuthorizationError("无法读取 OpenAI 官方 OIDC 配置；请检查网络后重试。");
  }
  if (!response.ok) throw new SiwcAuthorizationError("无法读取 OpenAI 官方 OIDC 配置。", { status: response.status, requestId: safeSiwcRequestId(response.headers) ?? undefined });
  const metadata: unknown = await response.json().catch(() => null);
  if (!record(metadata)) throw new SiwcAuthorizationError("OpenAI 官方 OIDC 配置格式无效。");
  const endpoints = {
    issuer: metadata.issuer,
    authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint,
    revocation_endpoint: metadata.revocation_endpoint,
    jwks_uri: metadata.jwks_uri,
  };
  if (
    endpoints.issuer !== SIWC_ISSUER ||
    endpoints.authorization_endpoint !== SIWC_AUTHORIZATION_ENDPOINT ||
    endpoints.token_endpoint !== SIWC_TOKEN_ENDPOINT ||
    typeof endpoints.revocation_endpoint !== "string" ||
    !endpoints.revocation_endpoint.startsWith(`${SIWC_ISSUER}/`) ||
    typeof endpoints.jwks_uri !== "string" ||
    !endpoints.jwks_uri.startsWith(`${SIWC_ISSUER}/`)
  ) {
    throw new SiwcAuthorizationError("OpenAI OIDC 元数据与官方 SIWC 端点不匹配；已拒绝继续。");
  }
  return endpoints as OidcConfiguration;
}

export async function verifySiwcIdToken(input: Readonly<{
  idToken: string;
  clientId: string;
  nonce?: string;
  expectedSubject?: string;
  fetchImpl?: typeof fetch;
}>): Promise<IdentityClaims> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const configuration = await readSiwcOidcConfiguration(fetchImpl);
  let jwksResponse: Response;
  try {
    jwksResponse = await fetchImpl(configuration.jwks_uri, {
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new SiwcAuthorizationError("无法读取 OpenAI 官方 JWKS；未保存或使用本次令牌。");
  }
  if (!jwksResponse.ok) {
    throw new SiwcAuthorizationError("无法读取 OpenAI 官方 JWKS。", { status: jwksResponse.status, requestId: safeSiwcRequestId(jwksResponse.headers) ?? undefined });
  }
  const jwksValue: unknown = await jwksResponse.json().catch(() => null);
  if (!record(jwksValue) || !Array.isArray(jwksValue.keys)) {
    throw new SiwcAuthorizationError("OpenAI 官方 JWKS 格式无效；未保存或使用本次令牌。");
  }
  let payload: JWTPayload;
  try {
    const keySet = createLocalJWKSet(jwksValue as unknown as JSONWebKeySet);
    const verified = await jwtVerify(input.idToken, keySet, {
      issuer: configuration.issuer,
      audience: input.clientId,
      algorithms: ["RS256"],
      requiredClaims: ["sub", "exp", "iat"],
      clockTolerance: 5,
    });
    payload = verified.payload;
  } catch {
    throw new SiwcAuthorizationError("SIWC ID token 的签名、issuer、audience 或有效期校验失败；未保存或使用本次令牌。");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new SiwcAuthorizationError("SIWC ID token 缺少有效 subject；未保存或使用本次令牌。");
  }
  if (input.nonce !== undefined && payload.nonce !== input.nonce) {
    throw new SiwcAuthorizationError("SIWC ID token nonce 不匹配；未保存或使用本次令牌。");
  }
  if (input.expectedSubject !== undefined && payload.sub !== input.expectedSubject) {
    throw new SiwcAuthorizationError("SIWC 账户身份与所选账户不匹配；未覆盖任何已保存凭据。");
  }
  return payload as IdentityClaims;
}

function parseScopes(value: unknown): readonly string[] {
  if (typeof value !== "string") return Object.freeze([]);
  return Object.freeze([...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))]);
}

function validExpiresIn(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 31 * 24 * 60 * 60
    ? value
    : null;
}

export async function runSiwcAuthorization(options: AuthorizationOptions): Promise<AuthorizationResult> {
  const storePath = options.storePath ?? resolveSiwcStorePath();
  const fetchImpl = options.fetchImpl ?? fetch;
  const store: SiwcCredentialStore = await ensureSiwcCredentialStore(storePath);
  const requestedClientId = options.existingClientId;
  const existing = options.existingClientId
    ? store.accounts.find((account) => account.clientId === options.existingClientId)
    : undefined;
  if (requestedClientId && !existing && !isSafeIssuedClientId(requestedClientId)) {
    throw new SiwcAuthorizationError("未知 SIWC client ID 格式无效；只可显式复用 OpenAI 官方回调签发的 client ID。");
  }
  const clientId = existing?.clientId ?? requestedClientId ?? "dynamic_agent_client";
  const pkce = createPkceValues();
  const listener = await startLoopbackListener(pkce.state, clientId === "dynamic_agent_client" ? null : clientId, options.timeoutMs ?? 5 * 60_000);
  try {
    const authorizationUrl = buildSiwcAuthorizationUrl({
      clientId,
      hostId: store.hostId,
      redirectUri: listener.redirectUri,
      state: pkce.state,
      nonce: pkce.nonce,
      codeChallenge: pkce.challenge,
      requestPlanUsage: options.requestPlanUsage,
      ...(existing ? { existingAccount: { idToken: existing.idToken, email: existing.email } } : {}),
      ...(options.promptConsent ? { promptConsent: true } : {}),
    });
    try {
      await options.openBrowser(authorizationUrl);
    } catch {
      throw new SiwcAuthorizationError("无法打开系统浏览器；SIWC 登录已停止，未兑换授权码。");
    }
    const callback = await listener.result;
    const tokenResponse = await fetchImpl(SIWC_TOKEN_ENDPOINT, {
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: formBody({
        grant_type: "authorization_code",
        code: callback.code,
        client_id: callback.clientId,
        code_verifier: pkce.verifier,
        redirect_uri: listener.redirectUri,
        resource: SIWC_RESOURCE,
      }),
      signal: AbortSignal.timeout(20_000),
    }).catch(() => {
      throw new SiwcAuthorizationError("SIWC token 交换失败；授权码未重试，令牌未保存。");
    });
    if (!tokenResponse.ok) {
      const errorBody: unknown = await tokenResponse.json().catch(() => null);
      const code = oauthErrorCode(errorBody);
      throw new SiwcAuthorizationError(tokenExchangeFailureMessage(code, callback.clientId, options.requestPlanUsage), {
        status: tokenResponse.status,
        requestId: safeSiwcRequestId(tokenResponse.headers) ?? undefined,
        code,
        bodyShape: oauthBodyShape(errorBody),
        ...(code === "invalid_grant" && isSafeIssuedClientIdForDisplay(callback.clientId) ? { issuedClientId: callback.clientId } : {}),
      });
    }
    const tokens: unknown = await tokenResponse.json().catch(() => null);
    if (!record(tokens)) throw new SiwcAuthorizationError("SIWC token 响应格式无效；令牌未保存。");
    if (typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" || typeof tokens.id_token !== "string" || !tokens.id_token) {
      throw new SiwcAuthorizationError("SIWC token 响应缺少有效 Bearer token 或 ID token；令牌未保存。");
    }
    const scopes = parseScopes(tokens.scope);
    const expiresIn = validExpiresIn(tokens.expires_in);
    const accessToken = typeof tokens.access_token === "string" && tokens.access_token ? tokens.access_token : null;
    const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : null;
    if (options.requestPlanUsage && scopes.includes(SIWC_PLAN_SCOPE) && scopes.includes(SIWC_RESOURCE_SCOPE) && (!accessToken || !expiresIn)) {
      throw new SiwcAuthorizationError("SIWC 已授予 plan-use scope，但 token 响应缺少有效 access token 或过期时间；未保存或推理。");
    }
    if (scopes.includes(SIWC_REFRESH_SCOPE) && !refreshToken) {
      throw new SiwcAuthorizationError("SIWC 授予 offline_access 但未返回 refresh token；为避免无法安全续期，本次凭据未保存。");
    }
    const claims = await verifySiwcIdToken({
      idToken: tokens.id_token,
      clientId: callback.clientId,
      nonce: pkce.nonce,
      ...(existing ? { expectedSubject: existing.subject } : {}),
      fetchImpl,
    });
    const grantedPlanUsage = scopes.includes(SIWC_PLAN_SCOPE) && scopes.includes(SIWC_RESOURCE_SCOPE);
    const planUsageWelcomeSeen = grantedPlanUsage || Boolean(existing?.planUsageWelcomeSeen) || Boolean(
      existing?.scopes.includes(SIWC_PLAN_SCOPE) && existing.scopes.includes(SIWC_RESOURCE_SCOPE),
    );
    if (grantedPlanUsage && !accessToken) {
      throw new SiwcAuthorizationError("SIWC plan-use 权限已授予但没有 access token；未推理。");
    }
    const account: SiwcAccountRecord = Object.freeze({
      clientId: callback.clientId,
      issuer: SIWC_ISSUER,
      subject: claims.sub,
      ...(typeof claims.email === "string" ? { email: claims.email } : {}),
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      planUsageWelcomeSeen,
      idToken: tokens.id_token,
      accessToken,
      refreshToken,
      scopes,
      expiresAt: expiresIn === null ? null : Date.now() + expiresIn * 1_000,
      updatedAt: new Date().toISOString(),
    });
    await saveSiwcAccount(storePath, account, existing?.subject);
    return Object.freeze({ account, planUsageAuthorized: grantedPlanUsage, reusedClientId: clientId !== "dynamic_agent_client" });
  } finally {
    await listener.close();
  }
}

export function hasSiwcPlanUsageScope(account: SiwcAccountRecord): boolean {
  return account.scopes.includes(SIWC_PLAN_SCOPE) && account.scopes.includes(SIWC_RESOURCE_SCOPE);
}

export function siwcOfflineScopeWasGranted(account: SiwcAccountRecord): boolean {
  return account.scopes.includes(SIWC_REFRESH_SCOPE);
}
