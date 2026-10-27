import {
  accountFromStore,
  clearSiwcAccountTokens,
  mutateSiwcCredentialStoreLocked,
  readSiwcCredentialStore,
  resolveSiwcStorePath,
  SIWC_PLAN_SCOPE,
  SIWC_REFRESH_SCOPE,
  SIWC_RESOURCE_SCOPE,
  type SiwcAccountRecord,
  type SiwcCredentialStore,
} from "./credential-store.js";
import { readSiwcOidcConfiguration, SIWC_RESOURCE, verifySiwcIdToken } from "./oauth.js";

const EXPIRY_SKEW_MS = 60_000;
const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(value) ? value : null;
}

function tokenErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const error = body.error;
  if (typeof error === "string") return safeCode(error);
  if (isRecord(error)) return safeCode(error.code);
  return safeCode(body.code);
}

function safeRequestId(headers: Headers): string | undefined {
  const value = headers.get("openai-request-id") ?? headers.get("x-request-id");
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

function parseScopes(value: unknown, fallback: readonly string[]): readonly string[] {
  if (typeof value !== "string") return Object.freeze([...fallback]);
  return Object.freeze([...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))]);
}

function refreshedRecord(account: SiwcAccountRecord, tokens: Record<string, unknown>, idToken: string | null): SiwcAccountRecord | null {
  const accessToken = typeof tokens.access_token === "string" && tokens.access_token ? tokens.access_token : null;
  const refreshToken = typeof tokens.refresh_token === "string" && tokens.refresh_token ? tokens.refresh_token : null;
  const expiresIn = tokens.expires_in;
  if (typeof tokens.token_type !== "string" || tokens.token_type.toLowerCase() !== "bearer" ||
      !accessToken || !refreshToken || typeof expiresIn !== "number" || !Number.isSafeInteger(expiresIn) || expiresIn <= 0 || expiresIn > 31 * 24 * 60 * 60) {
    return null;
  }
  const scopes = parseScopes(tokens.scope, account.scopes);
  return Object.freeze({
    ...account,
    idToken,
    accessToken,
    refreshToken,
    scopes,
    expiresAt: Date.now() + expiresIn * 1_000,
    updatedAt: new Date().toISOString(),
  });
}

function requirePlanScope(account: SiwcAccountRecord): void {
  if (!account.scopes.includes(SIWC_PLAN_SCOPE) || !account.scopes.includes(SIWC_RESOURCE_SCOPE)) {
    throw new Error("所选 ChatGPT 账户未明确授予 `chatgpt.tokens.use.direct` 与 `resource.invoke`；未发起 plan 推理。可运行 `npm run siwc -- login --plan-usage` 重新授权。API key 模式不会自动启用。");
  }
}

export async function getSiwcAccessTokenForUsage(input: Readonly<{
  storePath?: string;
  clientId?: string;
  fetchImpl?: typeof fetch;
}> = {}): Promise<string> {
  const storePath = input.storePath ?? resolveSiwcStorePath();
  const fetchImpl = input.fetchImpl ?? fetch;
  const initialStore = await readSiwcCredentialStore(storePath);
  if (!initialStore) throw new Error("没有已保存的 SIWC 账户；请先运行 `npm run siwc -- login --plan-usage`。");
  const initialAccount = accountFromStore(initialStore, input.clientId);
  requirePlanScope(initialAccount);
  if (initialAccount.accessToken && initialAccount.expiresAt !== null && initialAccount.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
    return initialAccount.accessToken;
  }

  const result = await mutateSiwcCredentialStoreLocked(storePath, async (current) => {
    const account = accountFromStore(current, input.clientId ?? initialAccount.clientId);
    requirePlanScope(account);
    if (account.accessToken && account.expiresAt !== null && account.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return { store: current, result: Object.freeze({ accessToken: account.accessToken, failure: null as string | null }) };
    }
    if (!account.refreshToken || !account.scopes.includes(SIWC_REFRESH_SCOPE)) {
      const cleared = Object.freeze({
        ...current,
        accounts: Object.freeze(current.accounts.map((item) => item.clientId === account.clientId
          ? Object.freeze({ ...item, accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date().toISOString() })
          : item)),
      });
      return { store: cleared, result: Object.freeze({ accessToken: null, failure: "SIWC access token 已过期且没有可用 offline_access refresh token；请重新授权。" }) };
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: account.clientId,
      refresh_token: account.refreshToken,
      resource: SIWC_RESOURCE,
    });
    let response: Response;
    try {
      response = await fetchImpl("https://auth.openai.com/api/accounts/oauth/token", {
        method: "POST",
        redirect: "error",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      return { store: current, result: Object.freeze({ accessToken: null, failure: "SIWC token 刷新遇到网络错误；凭据已保留，稍后可重试。" }) };
    }
    const tokenPayload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = tokenErrorCode(tokenPayload);
      if (code && TERMINAL_REFRESH_ERRORS.has(code)) {
        const cleared = Object.freeze({
          ...current,
          accounts: Object.freeze(current.accounts.map((item) => item.clientId === account.clientId
            ? Object.freeze({ ...item, accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date().toISOString() })
            : item)),
        });
        const requestId = safeRequestId(response.headers);
        return { store: cleared, result: Object.freeze({ accessToken: null, failure: `SIWC refresh token 已失效（${code}${requestId ? `；request ID ${requestId}` : ""}）；已清除不可用令牌，请重新登录。` }) };
      }
      const requestId = safeRequestId(response.headers);
      return { store: current, result: Object.freeze({ accessToken: null, failure: `SIWC token 刷新失败（HTTP ${response.status}${code ? `；${code}` : ""}${requestId ? `；request ID ${requestId}` : ""}）；凭据已保留。` }) };
    }
    if (!isRecord(tokenPayload)) {
      const cleared = Object.freeze({
        ...current,
        accounts: Object.freeze(current.accounts.map((item) => item.clientId === account.clientId
          ? Object.freeze({ ...item, accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date().toISOString() })
          : item)),
      });
      return { store: cleared, result: Object.freeze({ accessToken: null, failure: "SIWC refresh 响应格式无效；为避免复用可能已轮换的 refresh token，已清除 token，请重新登录。" }) };
    }

    let nextIdToken = account.idToken;
    if (typeof tokenPayload.id_token === "string" && tokenPayload.id_token) {
      const claims = await verifySiwcIdToken({
        idToken: tokenPayload.id_token,
        clientId: account.clientId,
        expectedSubject: account.subject,
        fetchImpl,
      });
      if (claims.sub !== account.subject) throw new Error("SIWC refresh 返回的账户身份与所选账户不匹配；已拒绝令牌。");
      nextIdToken = tokenPayload.id_token;
    }
    const nextAccount = refreshedRecord(account, tokenPayload, nextIdToken);
    if (!nextAccount) {
      const cleared = Object.freeze({
        ...current,
        accounts: Object.freeze(current.accounts.map((item) => item.clientId === account.clientId
          ? Object.freeze({ ...item, accessToken: null, refreshToken: null, expiresAt: null, updatedAt: new Date().toISOString() })
          : item)),
      });
      return { store: cleared, result: Object.freeze({ accessToken: null, failure: "SIWC refresh 缺少有效 Bearer token_type、access token、轮换后的 refresh token 或过期时间；已清除 token，请重新登录。" }) };
    }
    const nextStore: SiwcCredentialStore = Object.freeze({
      ...current,
      accounts: Object.freeze(current.accounts.map((item) => item.clientId === account.clientId ? nextAccount : item)),
    });
    if (!nextAccount.scopes.includes(SIWC_PLAN_SCOPE) || !nextAccount.scopes.includes(SIWC_RESOURCE_SCOPE)) {
      return { store: nextStore, result: Object.freeze({ accessToken: null, failure: "SIWC refresh 后未保留 plan-use 授权 scope；未发起推理。请重新确认账户授权。" }) };
    }
    return { store: nextStore, result: Object.freeze({ accessToken: nextAccount.accessToken, failure: null as string | null }) };
  });
  if (!result.accessToken) throw new Error(result.failure ?? "SIWC access token 不可用；未发起推理。");
  return result.accessToken;
}

export type LogoutResult = Readonly<{ remoteRevoked: boolean; hadRefreshToken: boolean }>;

export async function logoutSiwcAccount(input: Readonly<{
  storePath?: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
}>): Promise<LogoutResult> {
  const storePath = input.storePath ?? resolveSiwcStorePath();
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  return mutateSiwcCredentialStoreLocked(storePath, async (current) => {
    const account = accountFromStore(current, input.clientId);
    const refreshToken = account.refreshToken;
    let remoteRevoked = false;
    if (refreshToken) {
      try {
        const metadata = await readSiwcOidcConfiguration(fetchImpl);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let response: Response;
          try {
            response = await fetchImpl(metadata.revocation_endpoint, {
              method: "POST",
              redirect: "error",
              headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                token: refreshToken,
                token_type_hint: "refresh_token",
                client_id: account.clientId,
              }),
              signal: AbortSignal.timeout(15_000),
            });
          } catch {
            if (attempt < 2) {
              await sleep(100 * 2 ** attempt);
              continue;
            }
            break;
          }
          if (response.status === 200) {
            remoteRevoked = true;
            break;
          }
          if (response.status >= 500 && attempt < 2) {
            await sleep(100 * 2 ** attempt);
            continue;
          }
          break;
        }
      } catch {
        remoteRevoked = false;
      }
    }
    const cleared = clearSiwcAccountTokens(current, account.clientId);
    return { store: cleared, result: Object.freeze({ remoteRevoked, hadRefreshToken: Boolean(refreshToken) }) };
  });
}
