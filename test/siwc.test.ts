import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, open, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SignJWT, type JSONWebKeySet } from "jose";
import { runReadonlyCli } from "../src/readonly-cli.js";
import {
  accountFromStore,
  assertSiwcCredentialPlatform,
  CredentialDurabilityUncertainError,
  ensureSiwcCredentialStore,
  readSiwcCredentialStore,
  resolveSiwcStorePath,
  saveSiwcAccount,
  SIWC_PLAN_SCOPE,
  SIWC_REFRESH_SCOPE,
  SIWC_RESOURCE_SCOPE,
  type SiwcAccountRecord,
  writeSiwcCredentialStoreAtomically,
} from "../src/siwc/credential-store.js";
import {
  buildSiwcAuthorizationUrl,
  createPkceValues,
  runSiwcAuthorization,
  SIWC_AUTHORIZATION_ENDPOINT,
  SIWC_DISCOVERY_URL,
  SIWC_IDENTITY_SCOPES,
  SIWC_ISSUER,
  SIWC_PLAN_SCOPES,
  SIWC_RESOURCE,
  SIWC_TOKEN_ENDPOINT,
  verifySiwcIdToken,
} from "../src/siwc/oauth.js";
import {
  createSiwcResponsesProvider,
  listSiwcModels,
  SIWC_MODELS_ENDPOINT,
  SIWC_RESPONSES_ENDPOINT,
  SIWC_PLAN_USAGE_NOTICE,
  SIWC_USAGE_URL,
  SiwcProviderError,
} from "../src/siwc/responses-provider.js";
import { getSiwcAccessTokenForUsage, logoutSiwcAccount } from "../src/siwc/session.js";
import { readSiwcTuiStatus } from "../src/siwc/ui-status.js";
import { runSiwcCli } from "../src/siwc-cli.js";

const ISSUED_CLIENT_ID = "oaiapp_synthetic_client";
const CALLBACK_ACCESS_TOKEN = "synthetic-access-token-never-log";
const CALLBACK_REFRESH_TOKEN = "synthetic-refresh-token-never-log";
const FULL_SCOPES = [...SIWC_IDENTITY_SCOPES, ...SIWC_PLAN_SCOPES];
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...(keys.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
  kid: "synthetic-key-1",
  alg: "RS256",
  use: "sig",
};
const syntheticJwks = { keys: [publicJwk] } as unknown as JSONWebKeySet;

async function signedIdToken(input: Readonly<{
  nonce?: string;
  sub?: string;
  aud?: string;
  iss?: string;
  expired?: boolean;
}>): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: input.nonce ?? "synthetic-nonce", email: "fixture@example.invalid", name: "Synthetic User" })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic-key-1" })
    .setIssuer(input.iss ?? SIWC_ISSUER)
    .setAudience(input.aud ?? ISSUED_CLIENT_ID)
    .setSubject(input.sub ?? "synthetic-subject")
    .setIssuedAt(now)
    .setExpirationTime(input.expired ? now - 10 : now + 300)
    .sign(keys.privateKey);
}

function oidcMetadata(): object {
  return {
    issuer: SIWC_ISSUER,
    authorization_endpoint: SIWC_AUTHORIZATION_ENDPOINT,
    token_endpoint: SIWC_TOKEN_ENDPOINT,
    revocation_endpoint: `${SIWC_ISSUER}/api/accounts/oauth/revoke`,
    jwks_uri: `${SIWC_ISSUER}/.well-known/jwks.json`,
  };
}

async function withTemporaryStore<T>(callback: (storePath: string, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "coda-siwc-fixture-"));
  const storePath = path.join(root, "config", "coda", "siwc-credentials.json");
  try {
    return await callback(storePath, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function accountRecord(overrides: Partial<SiwcAccountRecord> = {}): SiwcAccountRecord {
  return Object.freeze({
    clientId: ISSUED_CLIENT_ID,
    issuer: SIWC_ISSUER,
    subject: "synthetic-subject",
    email: "fixture@example.invalid",
    name: "Synthetic User",
    idToken: "synthetic-id-token-never-log",
    accessToken: CALLBACK_ACCESS_TOKEN,
    refreshToken: CALLBACK_REFRESH_TOKEN,
    scopes: Object.freeze([...FULL_SCOPES]),
    expiresAt: Date.now() + 3_600_000,
    updatedAt: new Date().toISOString(),
    ...overrides,
  });
}

async function initializedStore(storePath: string, account = accountRecord()): Promise<void> {
  await ensureSiwcCredentialStore(storePath);
  await saveSiwcAccount(storePath, account);
}

function sseEvent(type: string, body: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`;
}

function responsesRequest(serializedBody?: string) {
  return Object.freeze({
    endpoint: SIWC_RESPONSES_ENDPOINT,
    serializedBody: serializedBody ?? JSON.stringify({
      model: "synthetic-current-slug",
      instructions: "synthetic instructions",
      input: [{ role: "user", content: "synthetic prompt" }],
      text: { format: { type: "json_schema", name: "synthetic", schema: { type: "object" }, strict: true } },
      store: false,
      stream: true,
    }),
  });
}

const syntheticSnapshot = {
  root: "/synthetic/repository",
  branch: "fixture-main",
  worktree: "clean" as const,
  context: 'File "src/main.ts"\n1 | export const greeting = "synthetic";\n',
  includedFiles: Object.freeze(["src/main.ts"]),
  skippedCandidateFiles: 0,
  contextBytes: 58,
};

function makeAuthorizationMocks(options: Readonly<{
  scopes?: readonly string[];
  tokenClaims?: Partial<Parameters<typeof signedIdToken>[0]>;
  denial?: boolean;
  callbackClientId?: string;
  callbackCode?: string;
  omitCallbackClientId?: boolean;
  callbackExpectedStatus?: number;
  tokenError?: Readonly<{ code: string; status?: number; requestId?: string; description?: string }>;
}> = {}) {
  let authorizationUrl: URL | undefined;
  let tokenExchangeCount = 0;
  let capturedTokenBody: URLSearchParams | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === SIWC_DISCOVERY_URL) return Response.json(oidcMetadata());
    if (url === `${SIWC_ISSUER}/.well-known/jwks.json`) return Response.json(syntheticJwks);
    if (url === SIWC_TOKEN_ENDPOINT) {
      tokenExchangeCount += 1;
      capturedTokenBody = new URLSearchParams(String(init?.body ?? ""));
      if (options.tokenError) {
        return Response.json({
          error: options.tokenError.code,
          ...(options.tokenError.description ? { error_description: options.tokenError.description } : {}),
        }, {
          status: options.tokenError.status ?? 400,
          headers: options.tokenError.requestId ? { "openai-request-id": options.tokenError.requestId } : undefined,
        });
      }
      const idToken = await signedIdToken({
        nonce: authorizationUrl?.searchParams.get("nonce") ?? "missing-synthetic-nonce",
        ...options.tokenClaims,
      });
      return Response.json({
        token_type: "Bearer",
        id_token: idToken,
        access_token: CALLBACK_ACCESS_TOKEN,
        refresh_token: CALLBACK_REFRESH_TOKEN,
        expires_in: 3600,
        scope: (options.scopes ?? FULL_SCOPES).join(" "),
      });
    }
    throw new Error(`Unexpected synthetic fetch target: ${url}`);
  };
  const openBrowser = async (value: string) => {
    authorizationUrl = new URL(value);
    const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
    assert.ok(redirectUri);
    assert.equal(new URL(redirectUri).hostname, "127.0.0.1");
    assert.equal(new URL(redirectUri).pathname, "/auth/callback");
    if (options.denial) {
      const denied = await fetch(`${redirectUri}?error=access_denied&state=${encodeURIComponent(authorizationUrl.searchParams.get("state") ?? "")}`);
      assert.equal(denied.status, 400);
      return;
    }
    const callbackClientId = options.callbackClientId ?? ISSUED_CLIENT_ID;
    const invalidState = await fetch(`${redirectUri}?code=synthetic-attacker-code&state=wrong-state&client_id=${callbackClientId}`);
    assert.equal(invalidState.status, 400);
    const callback = new URL(redirectUri);
    callback.searchParams.set("code", options.callbackCode ?? "synthetic-authorization-code");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    if (!options.omitCallbackClientId) callback.searchParams.set("client_id", callbackClientId);
    const completed = await fetch(callback);
    assert.equal(completed.status, options.callbackExpectedStatus ?? 200);
  };
  return {
    fetchImpl,
    openBrowser,
    getAuthorizationUrl: () => authorizationUrl,
    getTokenExchangeCount: () => tokenExchangeCount,
    getTokenBody: () => capturedTokenBody,
  };
}

test("SIWC docs state this project's local-only support and link the official interest form", async () => {
  const documents = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../SECURITY.md", import.meta.url), "utf8"),
  ]);
  for (const document of documents) {
    assert.match(document, /当前 Coda 的 SIWC provider 仅支持在用户控制的本机运行/);
    assert.match(document, /不提供远端 hosted mode/);
    assert.match(document, /不是对所有用户控制的远端 runtime 作出的禁止判断/);
    assert.match(document, /填写 \[SIWC interest form\]\(https:\/\/openai\.com\/form\/sign-in-with-chatgpt-interest\/\)/);
    assert.doesNotMatch(document, /必须先取得 OpenAI 要求的批准|任何付费或远程托管版本必须先满足 OpenAI 的 SIWC 审批要求/);
  }
});

test("SIWC credential storage fails closed when Windows ACL support is unavailable", () => {
  assert.throws(() => assertSiwcCredentialPlatform("win32"), /Windows.*owner-only ACL/);
  assert.doesNotThrow(() => assertSiwcCredentialPlatform("linux"));
  assert.doesNotThrow(() => assertSiwcCredentialPlatform("darwin"));
});

if (process.platform !== "win32") {
test("first plan-use login discloses consumption, sharing, and direct data flow before opening authorization", async () => {
  await withTemporaryStore(async (_storePath, root) => {
    const mocks = makeAuthorizationMocks();
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    let disclosureWasVisibleBeforeBrowser = false;
    const exitCode = await runSiwcCli({
      argv: ["login", "--plan-usage"],
      env: { XDG_CONFIG_HOME: path.join(root, "config") },
      stdout: output,
      fetchImpl: mocks.fetchImpl,
      openBrowser: async (url) => {
        disclosureWasVisibleBeforeBrowser = /首次启用 ChatGPT plan 的欢迎说明/.test(output.value) &&
          output.value.includes(SIWC_PLAN_USAGE_NOTICE) &&
          /本机运行的 Coda 进程会接收 OpenAI 官方 OAuth 回调/.test(output.value) &&
          /将凭据保存在你控制的本机配置目录/.test(output.value) &&
          /凭据不会发送到 Coda 远端服务/.test(output.value) &&
          /后续获准推理时，题目与所选仓库上下文由本机直接发送到 OpenAI 官方 Responses API，不经 Coda 远端代理/.test(output.value) &&
          output.value.includes(SIWC_USAGE_URL);
        await mocks.openBrowser(url);
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(mocks.getAuthorizationUrl()?.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(disclosureWasVisibleBeforeBrowser, true);
    assert.match(output.value, /Plus 的五小时 Work\/Codex 限额跨适用应用共享/);
    assert.match(output.value, /Pro 100\/200\/500 当前没有这项五小时限额/);
    assert.match(output.value, /本 CLI 无法识别账户方案/);
    assert.match(output.value, /app-specific limit/);
    assert.match(output.value, /会消耗本人 ChatGPT plan\/credits/);
    assert.match(output.value, /本机运行的 Coda 进程会接收 OpenAI 官方 OAuth 回调/);
    assert.match(output.value, /将凭据保存在你控制的本机配置目录/);
    assert.match(output.value, /凭据不会发送到 Coda 远端服务/);
    assert.match(output.value, /后续获准推理时，题目与所选仓库上下文由本机直接发送到 OpenAI 官方 Responses API，不经 Coda 远端代理/);
    assert.match(output.value, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const savedStore = await readSiwcCredentialStore(_storePath);
    assert.equal(accountFromStore(savedStore!, ISSUED_CLIENT_ID).planUsageWelcomeSeen, true);
  });
});

test("an already-enabled plan account does not repeat the welcome after logout and re-login", async () => {
  await withTemporaryStore(async (storePath, root) => {
    await initializedStore(storePath, accountRecord({ planUsageWelcomeSeen: true }));
    const logout = await logoutSiwcAccount({
      storePath,
      clientId: ISSUED_CLIENT_ID,
      fetchImpl: async () => { throw new Error("synthetic offline revoke"); },
      delay: async () => undefined,
    });
    assert.equal(logout.remoteRevoked, false);
    const afterLogout = await readSiwcCredentialStore(storePath);
    const loggedOutAccount = accountFromStore(afterLogout!, ISSUED_CLIENT_ID);
    assert.equal(loggedOutAccount.planUsageWelcomeSeen, true);
    assert.deepEqual(loggedOutAccount.scopes, []);

    const mocks = makeAuthorizationMocks();
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    let welcomeShownBeforeBrowser = false;
    let privacyDisclosureBeforeBrowser = false;
    const exitCode = await runSiwcCli({
      argv: ["login", "--plan-usage"],
      env: { XDG_CONFIG_HOME: path.join(root, "config") },
      stdout: output,
      fetchImpl: mocks.fetchImpl,
      openBrowser: async (url) => {
        welcomeShownBeforeBrowser = /首次启用 ChatGPT plan 的欢迎说明/.test(output.value);
        privacyDisclosureBeforeBrowser = /本机运行的 Coda 进程会接收 OAuth 回调/.test(output.value) &&
          /凭据不会发送到 Coda 远端服务/.test(output.value) &&
          /由本机直接发送到 OpenAI 官方 Responses API，不经 Coda 远端代理/.test(output.value);
        await mocks.openBrowser(url);
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(mocks.getAuthorizationUrl()?.searchParams.get("client_id"), ISSUED_CLIENT_ID);
    assert.equal(welcomeShownBeforeBrowser, false);
    assert.equal(privacyDisclosureBeforeBrowser, true);
    assert.ok(output.value.includes(SIWC_PLAN_USAGE_NOTICE));
    assert.match(output.value, /此前已启用 ChatGPT plan usage 账户的重新登录/);
    assert.doesNotMatch(output.value, /首次启用 ChatGPT plan 的欢迎说明/);
    const afterLogin = await readSiwcCredentialStore(storePath);
    assert.equal(accountFromStore(afterLogin!, ISSUED_CLIENT_ID).planUsageWelcomeSeen, true);
  });
});

test("legacy account records infer first plan welcome from scopes without a persisted marker", async () => {
  const legacyCases = [
    { name: "previously plan-authorized legacy record", account: accountRecord(), expectedWelcome: false },
    { name: "identity-only legacy record", account: accountRecord({ scopes: Object.freeze([...SIWC_IDENTITY_SCOPES]) }), expectedWelcome: true },
  ] as const;
  for (const item of legacyCases) {
    await withTemporaryStore(async (storePath, root) => {
      await initializedStore(storePath, item.account);
      const legacyJson = await readFile(storePath, "utf8");
      assert.doesNotMatch(legacyJson, /planUsageWelcomeSeen/);
      const legacyStore = await readSiwcCredentialStore(storePath);
      assert.equal(accountFromStore(legacyStore!, ISSUED_CLIENT_ID).planUsageWelcomeSeen, undefined);

      const mocks = makeAuthorizationMocks();
      const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
      let welcomeShownBeforeBrowser = false;
      const exitCode = await runSiwcCli({
        argv: ["login", "--client-id", ISSUED_CLIENT_ID, "--plan-usage"],
        env: { XDG_CONFIG_HOME: path.join(root, "config") },
        stdout: output,
        fetchImpl: mocks.fetchImpl,
        openBrowser: async (url) => {
          welcomeShownBeforeBrowser = /首次启用 ChatGPT plan 的欢迎说明/.test(output.value);
          await mocks.openBrowser(url);
        },
      });
      assert.equal(exitCode, 0, item.name);
      assert.equal(welcomeShownBeforeBrowser, item.expectedWelcome, item.name);
      if (item.expectedWelcome) assert.match(output.value, /首次启用 ChatGPT plan 的欢迎说明/);
      else assert.match(output.value, /此前已启用 ChatGPT plan usage 账户的重新登录/);
      const updated = await readSiwcCredentialStore(storePath);
      assert.equal(accountFromStore(updated!, ISSUED_CLIENT_ID).planUsageWelcomeSeen, true);
    });
  }
});

test("default login refuses to guess when multiple accounts exist without an active selection", async () => {
  await withTemporaryStore(async (storePath, root) => {
    await initializedStore(storePath, accountRecord());
    await saveSiwcAccount(storePath, accountRecord({
      clientId: "oaiapp_synthetic_second_client",
      subject: "synthetic-second-subject",
      email: "second@example.invalid",
      idToken: "synthetic-second-id-token-never-log",
      accessToken: "synthetic-second-access-token-never-log",
      refreshToken: "synthetic-second-refresh-token-never-log",
    }));
    await logoutSiwcAccount({
      storePath,
      clientId: "oaiapp_synthetic_second_client",
      fetchImpl: async () => { throw new Error("synthetic offline revoke"); },
      delay: async () => undefined,
    });

    let networkCalls = 0;
    let browserOpened = false;
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    const exitCode = await runSiwcCli({
      argv: ["login", "--plan-usage"],
      env: { XDG_CONFIG_HOME: path.join(root, "config") },
      stdout: output,
      fetchImpl: async () => { networkCalls += 1; throw new Error("OAuth must not start"); },
      openBrowser: async () => { browserOpened = true; },
    });
    assert.equal(exitCode, 1);
    assert.match(output.value, /多个 SIWC 账户且当前未选择账户/);
    assert.match(output.value, /--client-id <issued-client-id>/);
    assert.equal(networkCalls, 0);
    assert.equal(browserOpened, false);
  });
});

test("default login reuses the explicitly selected active issued client ID without dynamic registration or repeat welcome", async () => {
  await withTemporaryStore(async (storePath, root) => {
    await initializedStore(storePath, accountRecord({ planUsageWelcomeSeen: true }));
    await saveSiwcAccount(storePath, accountRecord({
      clientId: "oaiapp_synthetic_second_client",
      subject: "synthetic-second-subject",
      email: "second@example.invalid",
      idToken: "synthetic-second-id-token-never-log",
      accessToken: "synthetic-second-access-token-never-log",
      refreshToken: "synthetic-second-refresh-token-never-log",
      planUsageWelcomeSeen: true,
    }));
    const env = { XDG_CONFIG_HOME: path.join(root, "config") };
    const selectOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    assert.equal(await runSiwcCli({ argv: ["select", ISSUED_CLIENT_ID], env, stdout: selectOutput }), 0);
    assert.match(selectOutput.value, /活动 SIWC 账户已切换/);

    const mocks = makeAuthorizationMocks();
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    let welcomeShownBeforeBrowser = false;
    const exitCode = await runSiwcCli({
      argv: ["login", "--plan-usage"],
      env,
      stdout: output,
      fetchImpl: mocks.fetchImpl,
      openBrowser: async (url) => {
        welcomeShownBeforeBrowser = /首次启用 ChatGPT plan 的欢迎说明/.test(output.value);
        await mocks.openBrowser(url);
      },
    });
    assert.equal(exitCode, 0);
    const authorizationUrl = mocks.getAuthorizationUrl();
    assert.ok(authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get("client_id"), ISSUED_CLIENT_ID);
    assert.equal(authorizationUrl.searchParams.has("agent_name_hint"), false);
    assert.equal(welcomeShownBeforeBrowser, false);
    assert.match(output.value, /此前已启用 ChatGPT plan usage 账户的重新登录/);
    assert.doesNotMatch(output.value, /首次启用 ChatGPT plan 的欢迎说明/);
    const stored = await readSiwcCredentialStore(storePath);
    assert.equal(stored?.activeClientId, ISSUED_CLIENT_ID);
    assert.equal(stored?.accounts.length, 2);
    assert.equal(mocks.getTokenExchangeCount(), 1);
  });
});

test("identity-only login discloses OAuth data handling before opening authorization", async () => {
  await withTemporaryStore(async (_storePath, root) => {
    const mocks = makeAuthorizationMocks({ scopes: SIWC_IDENTITY_SCOPES });
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    let noticeShownBeforeBrowser = false;
    const exitCode = await runSiwcCli({
      argv: ["login"],
      env: { XDG_CONFIG_HOME: path.join(root, "config") },
      stdout: output,
      fetchImpl: mocks.fetchImpl,
      openBrowser: async (url) => {
        noticeShownBeforeBrowser = /账户标识/.test(output.value) && /email\/name/.test(output.value) &&
          /授权 scopes 与令牌/.test(output.value) && /本机运行的 Coda 进程会接收 OAuth 回调/.test(output.value) &&
          /将 SIWC 凭据保存在你控制的本机配置目录/.test(output.value) &&
          /凭据不会发送到 Coda 远端服务/.test(output.value) && /本次身份登录不会发送任务或仓库文本/.test(output.value) &&
          /由本机直接发送到 OpenAI 官方 Responses API，不经 Coda 远端代理/.test(output.value) &&
          /之后单独预览并由你批准/.test(output.value);
        await mocks.openBrowser(url);
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(noticeShownBeforeBrowser, true);
    assert.match(output.value, /不会启用 ChatGPT plan 推理/);
    assert.match(output.value, /任务或仓库文本/);
    assert.doesNotMatch(output.value, /首次启用 ChatGPT plan 的欢迎说明/);
  });
});

test("PKCE and dynamic authorization use the official registration contract and exact loopback URI", () => {
  const pkce = createPkceValues();
  assert.ok(pkce.state.length >= 43);
  assert.ok(pkce.nonce.length >= 43);
  assert.ok(pkce.verifier.length >= 43 && pkce.verifier.length <= 128);
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]+$/);
  const auth = new URL(buildSiwcAuthorizationUrl({
    clientId: "dynamic_agent_client",
    hostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    redirectUri: "http://127.0.0.1:1455/auth/callback",
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.challenge,
    requestPlanUsage: true,
  }));
  assert.equal(auth.origin + auth.pathname, SIWC_AUTHORIZATION_ENDPOINT);
  assert.equal(auth.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(auth.searchParams.get("agent_name_hint"), "Coda");
  assert.equal(auth.searchParams.get("ext_agent_host_id"), "urn:uuid:123e4567-e89b-42d3-a456-426614174000");
  assert.equal(auth.searchParams.get("redirect_uri"), "http://127.0.0.1:1455/auth/callback");
  assert.deepEqual(new Set(auth.searchParams.get("scope")?.split(" ")), new Set(FULL_SCOPES));
  assert.equal(auth.searchParams.get("resource"), SIWC_RESOURCE);
  assert.equal(auth.searchParams.get("response_type"), "code");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("code_challenge"), pkce.challenge);
  assert.equal(auth.searchParams.get("state"), pkce.state);
  assert.equal(auth.searchParams.get("nonce"), pkce.nonce);
  assert.equal(auth.searchParams.has("client_secret"), false);
  assert.equal(auth.searchParams.has("prompt"), false);

  const returning = new URL(buildSiwcAuthorizationUrl({
    clientId: ISSUED_CLIENT_ID,
    hostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174000",
    redirectUri: "http://127.0.0.1:52144/auth/callback",
    state: pkce.state,
    nonce: pkce.nonce,
    codeChallenge: pkce.challenge,
    requestPlanUsage: true,
    existingAccount: { idToken: "synthetic-id-token-hint", email: "fixture@example.invalid" },
    promptConsent: true,
  }));
  assert.equal(returning.searchParams.get("client_id"), ISSUED_CLIENT_ID);
  assert.equal(returning.searchParams.has("agent_name_hint"), false);
  assert.equal(returning.searchParams.get("id_token_hint"), "synthetic-id-token-hint");
  assert.equal(returning.searchParams.get("login_hint"), "fixture@example.invalid");
  assert.equal(returning.searchParams.get("prompt"), "consent");
});

test("SIWC registration rejects an invalid-state callback, exchanges only the valid code, and stores owner-only credentials", async () => {
  await withTemporaryStore(async (storePath) => {
    const mocks = makeAuthorizationMocks();
    const result = await runSiwcAuthorization({
      storePath,
      requestPlanUsage: true,
      fetchImpl: mocks.fetchImpl,
      openBrowser: mocks.openBrowser,
      timeoutMs: 2_000,
    });
    assert.equal(mocks.getTokenExchangeCount(), 1);
    const authorization = mocks.getAuthorizationUrl();
    const form = mocks.getTokenBody();
    assert.ok(authorization);
    assert.ok(form);
    assert.equal(authorization.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(authorization.searchParams.get("redirect_uri"), form.get("redirect_uri"));
    assert.equal(form.get("client_id"), ISSUED_CLIENT_ID);
    assert.equal(form.get("code"), "synthetic-authorization-code");
    assert.ok(form.get("code_verifier"));
    assert.equal(form.get("resource"), SIWC_RESOURCE);
    assert.equal(form.has("client_secret"), false);
    assert.equal(result.account.clientId, ISSUED_CLIENT_ID);
    assert.equal(result.account.subject, "synthetic-subject");
    assert.equal(result.planUsageAuthorized, true);
    assert.equal(result.account.accessToken, CALLBACK_ACCESS_TOKEN);
    const stored = await readSiwcCredentialStore(storePath);
    assert.equal(stored?.hostId, authorization.searchParams.get("ext_agent_host_id"));
    assert.equal(stored?.activeClientId, ISSUED_CLIENT_ID);
    assert.equal(stored?.accounts.length, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(storePath)).mode & 0o777, 0o600);
      assert.equal((await stat(path.dirname(storePath))).mode & 0o777, 0o700);
    }
  });
});

test("valid consent denial stops before token exchange and does not save an account", async () => {
  await withTemporaryStore(async (storePath) => {
    const mocks = makeAuthorizationMocks({ denial: true });
    await assert.rejects(runSiwcAuthorization({
      storePath,
      requestPlanUsage: true,
      fetchImpl: mocks.fetchImpl,
      openBrowser: mocks.openBrowser,
      timeoutMs: 2_000,
    }), /拒绝了 SIWC 授权/);
    assert.equal(mocks.getTokenExchangeCount(), 0);
    assert.equal((await readSiwcCredentialStore(storePath))?.accounts.length, 0);
  });
});

test("authorization-code exchange maps invalid_grant and invalid_client without exposing descriptions", async () => {
  const cases = [
    {
      code: "invalid_grant",
      expected: /丢弃本次 authorization code.*不要再次提交或复用该 code.*该尝试关联的 issued client ID/,
    },
    {
      code: "invalid_client",
      expected: /修正官方 client ID\/客户端配置.*不要盲目重试/,
    },
  ] as const;
  for (const item of cases) {
    await withTemporaryStore(async (storePath, root) => {
      await initializedStore(storePath);
      const requestId = `synthetic-oauth-${item.code}`;
      const secretDescription = `synthetic token-bearing description ${CALLBACK_ACCESS_TOKEN}`;
      const mocks = makeAuthorizationMocks({
        ...(item.code === "invalid_grant" ? { omitCallbackClientId: true } : {}),
        tokenError: { code: item.code, status: 400, requestId, description: secretDescription },
      });
      const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
      const exitCode = await runSiwcCli({
        argv: ["login", "--plan-usage"],
        env: { XDG_CONFIG_HOME: path.join(root, "config") },
        stdout: output,
        fetchImpl: mocks.fetchImpl,
        openBrowser: mocks.openBrowser,
      });
      assert.equal(exitCode, 1);
      assert.equal(mocks.getTokenExchangeCount(), 1);
      assert.match(output.value, item.expected);
      if (item.code === "invalid_grant") {
        assert.ok(output.value.includes(`issued client ID 为 ${ISSUED_CLIENT_ID}`));
        assert.equal(mocks.getTokenBody()?.get("client_id"), ISSUED_CLIENT_ID);
        assert.match(output.value, new RegExp(`npm run siwc -- login --plan-usage --client-id ${ISSUED_CLIENT_ID}`));
        assert.match(output.value, /不会再次使用 dynamic_agent_client 注册/);
        assert.doesNotMatch(output.value, /回调签发的 client ID/);
      }
      assert.match(output.value, new RegExp(`OAuth error=${item.code}`));
      assert.match(output.value, /HTTP 400/);
      assert.match(output.value, /response body shape=error-object/);
      assert.match(output.value, new RegExp(`request ID=${requestId}`));
      assert.doesNotMatch(output.value, /synthetic-authorization-code/);
      assert.doesNotMatch(output.value, /synthetic token-bearing description|synthetic-access-token-never-log/);
      const saved = await readSiwcCredentialStore(storePath);
      const original = accountFromStore(saved!, ISSUED_CLIENT_ID);
      assert.equal(original.accessToken, CALLBACK_ACCESS_TOKEN);
      assert.equal(original.refreshToken, CALLBACK_REFRESH_TOKEN);
      assert.equal(saved?.accounts.length, 1);
    });
  }
});

test("first-registration invalid_grant reauthorizes with the issued client ID and a fresh authorization code", async () => {
  await withTemporaryStore(async (storePath, root) => {
    const first = makeAuthorizationMocks({
      callbackCode: "synthetic-old-authorization-code",
      tokenError: { code: "invalid_grant", status: 400 },
    });
    const firstOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    const env = { XDG_CONFIG_HOME: path.join(root, "config") };
    assert.equal(await runSiwcCli({
      argv: ["login", "--plan-usage"],
      env,
      stdout: firstOutput,
      fetchImpl: first.fetchImpl,
      openBrowser: first.openBrowser,
    }), 1);
    const firstAuthorization = first.getAuthorizationUrl();
    assert.ok(firstAuthorization);
    assert.equal(firstAuthorization.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(first.getTokenBody()?.get("client_id"), ISSUED_CLIENT_ID);
    assert.equal(first.getTokenBody()?.get("code"), "synthetic-old-authorization-code");
    assert.equal(first.getTokenExchangeCount(), 1);
    assert.ok(firstOutput.value.includes(`issued client ID 为 ${ISSUED_CLIENT_ID}`));
    assert.match(firstOutput.value, new RegExp(`npm run siwc -- login --plan-usage --client-id ${ISSUED_CLIENT_ID}`));
    assert.match(firstOutput.value, /丢弃本次 authorization code，不要再次提交或复用该 code/);
    assert.doesNotMatch(firstOutput.value, /synthetic-old-authorization-code/);
    assert.equal((await readSiwcCredentialStore(storePath))?.accounts.length, 0);

    const retry = makeAuthorizationMocks({ callbackCode: "synthetic-fresh-authorization-code" });
    const retryOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    assert.equal(await runSiwcCli({
      argv: ["login", "--plan-usage", "--client-id", ISSUED_CLIENT_ID],
      env,
      stdout: retryOutput,
      fetchImpl: retry.fetchImpl,
      openBrowser: retry.openBrowser,
    }), 0);
    const retryAuthorization = retry.getAuthorizationUrl();
    assert.ok(retryAuthorization);
    assert.equal(retryAuthorization.searchParams.get("client_id"), ISSUED_CLIENT_ID);
    assert.notEqual(retryAuthorization.searchParams.get("client_id"), "dynamic_agent_client");
    assert.equal(retryAuthorization.searchParams.has("agent_name_hint"), false);
    assert.equal(retry.getTokenBody()?.get("client_id"), ISSUED_CLIENT_ID);
    assert.equal(retry.getTokenBody()?.get("code"), "synthetic-fresh-authorization-code");
    assert.notEqual(retry.getTokenBody()?.get("code"), first.getTokenBody()?.get("code"));
    assert.equal(retry.getTokenExchangeCount(), 1);
    assert.equal((await readSiwcCredentialStore(storePath))?.accounts[0]?.clientId, ISSUED_CLIENT_ID);
  });
});

test("reauthorization rejects a callback client ID that does not match the selected account", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath);
    const mocks = makeAuthorizationMocks({ callbackClientId: "oaiapp_other_account", callbackExpectedStatus: 400 });
    await assert.rejects(runSiwcAuthorization({
      storePath,
      existingClientId: ISSUED_CLIENT_ID,
      requestPlanUsage: true,
      fetchImpl: mocks.fetchImpl,
      openBrowser: mocks.openBrowser,
      timeoutMs: 2_000,
    }), /client ID 与所选账户不匹配/);
    assert.equal(mocks.getTokenExchangeCount(), 0);
    const store = await readSiwcCredentialStore(storePath);
    assert.equal(accountFromStore(store!, ISSUED_CLIENT_ID).refreshToken, CALLBACK_REFRESH_TOKEN);
    assert.equal(store?.accounts.length, 1);
  });
});

test("missing plan-use scopes retain identity login but block plan inference before any API request", async () => {
  await withTemporaryStore(async (storePath) => {
    const mocks = makeAuthorizationMocks({ scopes: SIWC_IDENTITY_SCOPES });
    const result = await runSiwcAuthorization({
      storePath,
      requestPlanUsage: true,
      fetchImpl: mocks.fetchImpl,
      openBrowser: mocks.openBrowser,
      timeoutMs: 2_000,
    });
    assert.equal(result.planUsageAuthorized, false);
    assert.equal(result.account.scopes.includes(SIWC_PLAN_SCOPE), false);
    let laterRequests = 0;
    await assert.rejects(getSiwcAccessTokenForUsage({
      storePath,
      fetchImpl: async () => { laterRequests += 1; throw new Error("must not fetch"); },
    }), /未明确授予/);
    assert.equal(laterRequests, 0);
  });
});

test("ID token verification rejects invalid issuer, audience, expiration, nonce, and account subject", async () => {
  const jwksFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url === SIWC_DISCOVERY_URL) return Response.json(oidcMetadata());
    if (url === `${SIWC_ISSUER}/.well-known/jwks.json`) return Response.json(syntheticJwks);
    throw new Error(`Unexpected synthetic fetch target: ${url}`);
  };
  const invalidTokens = [
    { claims: { iss: "https://attacker.example" }, expected: /签名、issuer、audience 或有效期/ },
    { claims: { aud: "oaiapp_other" }, expected: /签名、issuer、audience 或有效期/ },
    { claims: { expired: true }, expected: /签名、issuer、audience 或有效期/ },
    { claims: { nonce: "other-nonce" }, expected: /nonce 不匹配/ },
    { claims: { sub: "other-subject" }, expected: /身份与所选账户不匹配/ },
  ] as const;
  for (const item of invalidTokens) {
    const token = await signedIdToken(item.claims);
    await assert.rejects(verifySiwcIdToken({
      idToken: token,
      clientId: ISSUED_CLIENT_ID,
      nonce: "synthetic-nonce",
      expectedSubject: "synthetic-subject",
      fetchImpl: jwksFetch,
    }), item.expected);
  }
});

test("credential reads reject permissive local directories/files and symbolic links", async () => {
  if (process.platform === "win32") return;
  await withTemporaryStore(async (storePath, root) => {
    await initializedStore(storePath);
    const directory = path.dirname(storePath);
    await chmod(directory, 0o755);
    await assert.rejects(readSiwcCredentialStore(storePath), /目录权限过宽/);
    await chmod(directory, 0o700);

    await chmod(storePath, 0o644);
    await assert.rejects(readSiwcCredentialStore(storePath), /凭据权限过宽/);
    await chmod(storePath, 0o600);

    const linkPath = path.join(root, "linked-credentials.json");
    await symlink(storePath, linkPath);
    await assert.rejects(readSiwcCredentialStore(linkPath), /普通文件|安全读取/);
  });
});

test("temporary-file close failure removes secret temp file and preserves original credentials", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ accessToken: "synthetic-original-access-token" }));
    const originalContents = await readFile(storePath, "utf8");
    const originalStore = await readSiwcCredentialStore(storePath);
    assert.ok(originalStore);
    const attemptedSecret = "synthetic-close-failure-token-never-log";
    const attemptedStore = Object.freeze({
      ...originalStore,
      accounts: Object.freeze(originalStore.accounts.map((account) => Object.freeze({
        ...account,
        accessToken: attemptedSecret,
        refreshToken: attemptedSecret,
      }))),
    });
    await assert.rejects(writeSiwcCredentialStoreAtomically(storePath, attemptedStore, {
      openTemporaryFile: async (temporaryPath) => {
        const handle = await open(temporaryPath, "wx", 0o600);
        return {
          writeFile: async (data: string, encoding: "utf8") => { await handle.writeFile(data, encoding); },
          sync: () => handle.sync(),
          chmod: (mode: number) => handle.chmod(mode),
          truncate: (length?: number) => handle.truncate(length),
          close: async () => {
            await handle.close();
            throw new Error(`synthetic close failure ${attemptedSecret}`);
          },
        };
      },
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /原凭据未替换/);
      assert.doesNotMatch(error.message, /synthetic-close-failure-token-never-log/);
      assert.doesNotMatch(error.stack ?? "", /synthetic-close-failure-token-never-log/);
      return true;
    });
    assert.equal(await readFile(storePath, "utf8"), originalContents);
    assert.deepEqual((await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")), []);
    const stillStored = await readSiwcCredentialStore(storePath);
    assert.equal(stillStored?.accounts[0]?.accessToken, "synthetic-original-access-token");
    assert.ok(!originalContents.includes(attemptedSecret));
  });
});

test("temporary-file fsync and rename failures keep the original credential file and remove temp files", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ accessToken: "synthetic-original-write-token" }));
    for (const failure of ["temporary-fsync", "rename"] as const) {
      const originalContents = await readFile(storePath, "utf8");
      const originalStore = await readSiwcCredentialStore(storePath);
      assert.ok(originalStore);
      const attemptedSecret = `synthetic-${failure}-token-never-log`;
      const attemptedStore = Object.freeze({
        ...originalStore,
        accounts: Object.freeze(originalStore.accounts.map((account) => Object.freeze({
          ...account,
          accessToken: attemptedSecret,
          refreshToken: attemptedSecret,
        }))),
      });
      const options = failure === "temporary-fsync"
        ? {
            openTemporaryFile: async (temporaryPath: string) => {
              const handle = await open(temporaryPath, "wx", 0o600);
              return {
                writeFile: async (data: string, encoding: "utf8") => { await handle.writeFile(data, encoding); },
                sync: async () => { throw new Error(`synthetic private fsync failure ${attemptedSecret}`); },
                chmod: (mode: number) => handle.chmod(mode),
                truncate: (length?: number) => handle.truncate(length),
                close: () => handle.close(),
              };
            },
          }
        : {
            replaceFile: async (sourcePath: string, targetPath: string) => {
              assert.equal(await readFile(targetPath, "utf8"), originalContents);
              assert.ok((await readFile(sourcePath, "utf8")).includes(attemptedSecret));
              throw new Error(`synthetic private rename failure ${attemptedSecret}`);
            },
          };
      await assert.rejects(writeSiwcCredentialStoreAtomically(storePath, attemptedStore, options), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /原凭据未替换/);
        assert.doesNotMatch(error.message, /synthetic private .*failure/);
        assert.doesNotMatch(error.stack ?? "", /synthetic private .*failure/);
        return true;
      });
      assert.equal(await readFile(storePath, "utf8"), originalContents);
      assert.deepEqual((await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")), []);
      const actualStore = await readSiwcCredentialStore(storePath);
      assert.equal(actualStore?.accounts[0]?.accessToken, "synthetic-original-write-token");
      assert.ok(!originalContents.includes(attemptedSecret));
    }
  });
});

test("directory fsync failure reports durability uncertainty after the new store is committed", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ accessToken: "synthetic-old-durable-token" }));
    const originalContents = await readFile(storePath, "utf8");
    const originalStore = await readSiwcCredentialStore(storePath);
    assert.ok(originalStore);
    const newToken = "synthetic-new-rotated-token-never-log";
    const nextStore = Object.freeze({
      ...originalStore,
      accounts: Object.freeze(originalStore.accounts.map((account) => Object.freeze({
        ...account,
        accessToken: newToken,
        refreshToken: "synthetic-new-refresh-token-never-log",
      }))),
    });
    await assert.rejects(writeSiwcCredentialStoreAtomically(storePath, nextStore, {
      syncDirectory: async () => { throw new Error(`synthetic private directory fsync failure ${newToken}`); },
    }), (error: unknown) => {
      assert.ok(error instanceof CredentialDurabilityUncertainError);
      assert.match(error.message, /已原子替换到目标路径/);
      assert.match(error.message, /目录同步失败，崩溃持久性未确认/);
      assert.match(error.message, /siwc -- status/);
      assert.doesNotMatch(error.message, /synthetic-new-rotated-token-never-log/);
      assert.doesNotMatch(error.stack ?? "", /synthetic-new-rotated-token-never-log/);
      return true;
    });
    const actualContents = await readFile(storePath, "utf8");
    assert.notEqual(actualContents, originalContents);
    assert.ok(actualContents.includes(newToken));
    assert.deepEqual((await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")), []);
    const actualStore = await readSiwcCredentialStore(storePath);
    assert.equal(actualStore?.accounts[0]?.accessToken, newToken);
    assert.equal(actualStore?.accounts[0]?.refreshToken, "synthetic-new-refresh-token-never-log");
  });
});

test("refresh token rotation is serialized across concurrent callers and replaces the whole token set", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ expiresAt: Date.now() - 10_000, planUsageWelcomeSeen: true }));
    let refreshCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      assert.equal(String(input), SIWC_TOKEN_ENDPOINT);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      const form = new URLSearchParams(String(init?.body ?? ""));
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("client_id"), ISSUED_CLIENT_ID);
      assert.equal(form.get("refresh_token"), CALLBACK_REFRESH_TOKEN);
      assert.equal(form.get("resource"), SIWC_RESOURCE);
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({
        access_token: "synthetic-rotated-access-token",
        refresh_token: "synthetic-rotated-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        scope: FULL_SCOPES.join(" "),
      });
    };
    const tokens = await Promise.all([
      getSiwcAccessTokenForUsage({ storePath, fetchImpl }),
      getSiwcAccessTokenForUsage({ storePath, fetchImpl }),
    ]);
    assert.deepEqual(tokens, ["synthetic-rotated-access-token", "synthetic-rotated-access-token"]);
    assert.equal(refreshCalls, 1);
    const stored = await readSiwcCredentialStore(storePath);
    const account = accountFromStore(stored!, ISSUED_CLIENT_ID);
    assert.equal(account.accessToken, "synthetic-rotated-access-token");
    assert.equal(account.refreshToken, "synthetic-rotated-refresh-token");
    assert.equal(account.planUsageWelcomeSeen, true);
    assert.ok((account.expiresAt ?? 0) > Date.now());
    const text = await readFile(storePath, "utf8");
    assert.ok(!text.includes(CALLBACK_REFRESH_TOKEN));
    assert.ok(text.includes("synthetic-rotated-refresh-token"));
  });
});

test("terminal refresh failure clears unusable access and refresh tokens without printing them", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ expiresAt: Date.now() - 10_000 }));
    const fetchImpl: typeof fetch = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    await assert.rejects(getSiwcAccessTokenForUsage({ storePath, fetchImpl }), /refresh token 已失效/);
    const stored = await readSiwcCredentialStore(storePath);
    const account = accountFromStore(stored!, ISSUED_CLIENT_ID);
    assert.equal(account.accessToken, null);
    assert.equal(account.refreshToken, null);
    assert.ok(account.idToken);
  });
});

test("refresh rejects a non-Bearer token type and clears potentially rotated tokens", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ expiresAt: Date.now() - 10_000 }));
    const fetchImpl: typeof fetch = async () => Response.json({
      access_token: "synthetic-invalid-access-token",
      refresh_token: "synthetic-possibly-rotated-refresh-token",
      token_type: "MAC",
      expires_in: 3600,
      scope: FULL_SCOPES.join(" "),
    });
    await assert.rejects(getSiwcAccessTokenForUsage({ storePath, fetchImpl }), /Bearer token_type/);
    const stored = await readSiwcCredentialStore(storePath);
    const account = accountFromStore(stored!, ISSUED_CLIENT_ID);
    assert.equal(account.accessToken, null);
    assert.equal(account.refreshToken, null);
  });
});

test("logout revokes the rotating refresh token via discovery then clears all local tokens", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath);
    let revokeBody: URLSearchParams | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === SIWC_DISCOVERY_URL) return Response.json(oidcMetadata());
      assert.equal(url, `${SIWC_ISSUER}/api/accounts/oauth/revoke`);
      assert.equal(init?.method, "POST");
      revokeBody = new URLSearchParams(String(init?.body ?? ""));
      return new Response(null, { status: 200 });
    };
    const result = await logoutSiwcAccount({ storePath, clientId: ISSUED_CLIENT_ID, fetchImpl });
    assert.deepEqual(result, { remoteRevoked: true, hadRefreshToken: true });
    assert.equal(revokeBody?.get("token"), CALLBACK_REFRESH_TOKEN);
    assert.equal(revokeBody?.get("token_type_hint"), "refresh_token");
    assert.equal(revokeBody?.get("client_id"), ISSUED_CLIENT_ID);
    const store = await readSiwcCredentialStore(storePath);
    assert.equal(store?.accounts.length, 1);
    assert.equal(store?.activeClientId, null);
    const account = accountFromStore(store!, ISSUED_CLIENT_ID);
    assert.equal(account.accessToken, null);
    assert.equal(account.refreshToken, null);
    assert.equal(account.idToken, null);
    assert.deepEqual(account.scopes, []);
  });
});

test("logout retries revocation failures with bounded backoff and still clears local tokens", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath);
    let attempts = 0;
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === SIWC_DISCOVERY_URL) return Response.json(oidcMetadata());
      attempts += 1;
      return new Response("synthetic", { status: 503 });
    };
    const delays: number[] = [];
    const result = await logoutSiwcAccount({
      storePath,
      clientId: ISSUED_CLIENT_ID,
      fetchImpl,
      delay: async (milliseconds) => { delays.push(milliseconds); },
    });
    assert.deepEqual(result, { remoteRevoked: false, hadRefreshToken: true });
    assert.equal(attempts, 3);
    assert.deepEqual(delays, [100, 200]);
    const account = accountFromStore((await readSiwcCredentialStore(storePath))!, ISSUED_CLIENT_ID);
    assert.equal(account.refreshToken, null);
    assert.equal(account.accessToken, null);
  });
});

test("model catalog is fetched for the account and keeps only visible display slugs", async () => {
  const models = await listSiwcModels(CALLBACK_ACCESS_TOKEN, async (input, init) => {
    assert.equal(String(input), SIWC_MODELS_ENDPOINT);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${CALLBACK_ACCESS_TOKEN}`);
    return Response.json({ models: [
      { slug: "visible-current", display_name: "Visible Current", visibility: "list" },
      { slug: "hidden", display_name: "Hidden", visibility: "internal" },
      { slug: "visible-current", display_name: "Duplicate", visibility: "list" },
      { slug: "bad", display_name: 3, visibility: "list" },
    ] });
  });
  assert.deepEqual(models, [{ slug: "visible-current", displayName: "Visible Current" }]);
});

test("status and model list explain plan-specific usage without assuming the account tier", async () => {
  await withTemporaryStore(async (storePath, root) => {
    await initializedStore(storePath);
    const env = { XDG_CONFIG_HOME: path.join(root, "config") };
    const statusOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    assert.equal(await runSiwcCli({ argv: ["status"], env, stdout: statusOutput }), 0);
    assert.ok(statusOutput.value.includes(SIWC_PLAN_USAGE_NOTICE));
    assert.match(statusOutput.value, /Plus 的五小时 Work\/Codex 限额跨适用应用共享/);
    assert.match(statusOutput.value, /Pro 100\/200\/500 当前没有这项五小时限额/);
    assert.match(statusOutput.value, /本 CLI 无法识别账户方案/);
    assert.match(statusOutput.value, /app-specific limit/);
    assert.doesNotMatch(statusOutput.value, /额度与其他已连接应用共享/);

    const modelsOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    assert.equal(await runSiwcCli({
      argv: ["models"],
      env,
      stdout: modelsOutput,
      fetchImpl: async (input) => {
        assert.equal(String(input), SIWC_MODELS_ENDPOINT);
        return Response.json({ models: [] });
      },
    }), 0);
    assert.ok(modelsOutput.value.includes(SIWC_PLAN_USAGE_NOTICE));
    assert.doesNotMatch(modelsOutput.value, /额度与其他已连接应用共享/);
  });
});

test("Responses provider sends only the documented public SSE request and succeeds only at response.completed", async () => {
  const modelText = JSON.stringify({
    understanding: [{ text: "Synthetic code declares a greeting.", citations: [{ path: "src/main.ts", startLine: 1, endLine: 1 }] }],
    plan: [{ text: "Review the caller.", citations: [{ path: "src/main.ts", startLine: 1, endLine: 1 }] }],
  });
  let accessTokenCalls = 0;
  let receivedBody = "";
  let receivedUrl = "";
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => { accessTokenCalls += 1; return CALLBACK_ACCESS_TOKEN; },
    fetchImpl: async (input, init) => {
      receivedUrl = String(input);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${CALLBACK_ACCESS_TOKEN}`);
      receivedBody = String(init?.body);
      return new Response(
        sseEvent("response.output_text.delta", { delta: modelText }) + sseEvent("response.completed", { response: { output: [] } }),
        { status: 200, headers: { "Content-Type": "text/event-stream", "openai-request-id": "synthetic-request-1" } },
      );
    },
  });
  const response = await provider.send(responsesRequest());
  assert.equal(accessTokenCalls, 1);
  assert.equal(receivedUrl, SIWC_RESPONSES_ENDPOINT);
  const body = JSON.parse(receivedBody) as Record<string, unknown>;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.instructions, "synthetic instructions");
  assert.ok(Array.isArray(body.input));
  assert.equal(Object.hasOwn(body, "messages"), false);
  assert.equal(Object.hasOwn(body, "previous_response_id"), false);
  assert.equal(Object.hasOwn(body, "temperature"), false);
  assert.equal(Object.hasOwn(body, "tools"), false);
  assert.ok(!receivedBody.includes(CALLBACK_ACCESS_TOKEN));
  assert.deepEqual(await response.json(), { output_text: modelText });
});

test("token-bearing token retrieval errors are sanitized before provider errors and CLI output", async () => {
  const syntheticSecret = "synthetic-access-token-error-secret-never-log";
  let networkCalls = 0;
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => { throw new Error(`synthetic OAuth error included ${syntheticSecret}`); },
    fetchImpl: async () => { networkCalls += 1; throw new Error("must not reach network"); },
  });
  await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.match(error.message, /无法取得所选 SIWC 账户的授权/);
    assert.doesNotMatch(error.message, /synthetic-access-token-error-secret-never-log/);
    assert.doesNotMatch(error.stack ?? "", /synthetic-access-token-error-secret-never-log/);
    return true;
  });

  const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
  const exitCode = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    env: {},
    inspect: async () => syntheticSnapshot,
    stdout: output,
    confirmSend: async () => true,
    provider,
  });
  assert.equal(exitCode, 1);
  assert.match(output.value, /模型请求未完成/);
  assert.doesNotMatch(output.value, /synthetic-access-token-error-secret-never-log/);
  assert.equal(networkCalls, 0);
});

test("provider and CLI safely stop after credential durability becomes uncertain", async () => {
  const syntheticSecret = "synthetic-directory-sync-underlying-token-never-log";
  let modelNetworkCalls = 0;
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => {
      const error = new CredentialDurabilityUncertainError();
      Object.defineProperty(error, "cause", { value: new Error(syntheticSecret) });
      throw error;
    },
    fetchImpl: async () => { modelNetworkCalls += 1; throw new Error("must not reach model endpoint"); },
  });
  await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.match(error.message, /新内容已原子替换到目标路径/);
    assert.match(error.message, /目录同步失败、崩溃持久性未确认/);
    assert.match(error.message, /本次未发起推理/);
    assert.match(error.message, /siwc -- status/);
    assert.doesNotMatch(error.message, /synthetic-directory-sync-underlying-token-never-log/);
    assert.doesNotMatch(error.stack ?? "", /synthetic-directory-sync-underlying-token-never-log/);
    return true;
  });

  const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
  const exitCode = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    env: {},
    inspect: async () => syntheticSnapshot,
    stdout: output,
    confirmSend: async () => true,
    provider,
  });
  assert.equal(exitCode, 1);
  assert.match(output.value, /目录同步失败、崩溃持久性未确认/);
  assert.match(output.value, /siwc -- status/);
  assert.doesNotMatch(output.value, /synthetic-directory-sync-underlying-token-never-log/);
  assert.equal(modelNetworkCalls, 0);
});

test("rotated refresh credentials with directory durability uncertainty stop the CLI before inference", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({
      accessToken: "synthetic-expired-access-token",
      refreshToken: "synthetic-old-refresh-token",
      expiresAt: Date.now() - 10_000,
    }));
    const rotatedAccessToken = "synthetic-rotated-access-token-never-log";
    const rotatedRefreshToken = "synthetic-rotated-refresh-token-never-log";
    let refreshCalls = 0;
    let modelCalls = 0;
    const provider = createSiwcResponsesProvider({
      getAccessToken: () => getSiwcAccessTokenForUsage({
        storePath,
        fetchImpl: async (input) => {
          assert.equal(String(input), SIWC_TOKEN_ENDPOINT);
          refreshCalls += 1;
          return Response.json({
            access_token: rotatedAccessToken,
            refresh_token: rotatedRefreshToken,
            token_type: "Bearer",
            expires_in: 3600,
            scope: FULL_SCOPES.join(" "),
          });
        },
        credentialWriteOptions: {
          syncDirectory: async () => { throw new Error(`synthetic directory fsync detail ${rotatedAccessToken}`); },
        },
      }),
      fetchImpl: async () => { modelCalls += 1; throw new Error("model inference must not start"); },
    });
    const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
    const exitCode = await runReadonlyCli({
      cwd: "/synthetic/repository",
      requestMode: "siwc",
      model: "synthetic-current-slug",
      env: {},
      inspect: async () => syntheticSnapshot,
      stdout: output,
      confirmSend: async () => true,
      provider,
    });
    assert.equal(exitCode, 1);
    assert.equal(refreshCalls, 1);
    assert.equal(modelCalls, 0);
    assert.match(output.value, /新内容已原子替换到目标路径/);
    assert.match(output.value, /目录同步失败、崩溃持久性未确认/);
    assert.match(output.value, /本次未发起推理/);
    assert.match(output.value, /siwc -- status/);
    assert.doesNotMatch(output.value, /synthetic directory fsync detail|synthetic-rotated-access-token-never-log/);
    assert.deepEqual((await readdir(path.dirname(storePath))).filter((name) => name.endsWith(".tmp")), []);
    const actualStore = await readSiwcCredentialStore(storePath);
    const actualAccount = accountFromStore(actualStore!, ISSUED_CLIENT_ID);
    assert.equal(actualAccount.accessToken, rotatedAccessToken);
    assert.equal(actualAccount.refreshToken, rotatedRefreshToken);
  });
});

test("SSE parser handles complete and one-byte CRLF/CR/LF streams and only completes on response.completed", async () => {
  const sample = 'event: response.output_text.delta\r\ndata: {"type":"response.output_text.delta","delta":"ok"}\r\n\r\nevent: response.completed\r\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\r\n\r\n';
  const encoder = new TextEncoder();
  const crlfBytes = encoder.encode(sample);
  const variants = [
    { name: "complete CRLF block", chunks: [crlfBytes] },
    { name: "single-byte CRLF chunks", chunks: Array.from(crlfBytes, (byte) => new Uint8Array([byte])) },
    { name: "single-byte standalone CR chunks", chunks: Array.from(encoder.encode(sample.replace(/\r\n/g, "\r")), (byte) => new Uint8Array([byte])) },
    { name: "single-byte LF chunks", chunks: Array.from(encoder.encode(sample.replace(/\r\n/g, "\n")), (byte) => new Uint8Array([byte])) },
  ];
  for (const variant of variants) {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of variant.chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    const provider = createSiwcResponsesProvider({
      getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
      fetchImpl: async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    });
    const response = await provider.send(responsesRequest());
    assert.deepEqual(await response.json(), { output_text: "ok" }, variant.name);
  }

  const doneOnly = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } }),
  });
  await assert.rejects(doneOnly.send(responsesRequest()), /without response.completed/);
  const incomplete = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => new Response(sseEvent("response.incomplete", { response: { status: "incomplete" } }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  await assert.rejects(incomplete.send(responsesRequest()), /response.incomplete/);
});

test("Responses API errors preserve safe error.code and error.param with actionable capability guidance", async () => {
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => Response.json({
      error: { code: "subscription_sharing_unsupported_capability", param: "tools", message: "synthetic raw provider detail" },
    }, { status: 400 }),
  });
  await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.equal(error.code, "subscription_sharing_unsupported_capability");
    assert.equal(error.param, "tools");
    const userMessage = error.toUserMessage();
    assert.match(userMessage, /unsupported SIWC capability/i);
    assert.match(userMessage, /tools/);
    assert.match(userMessage, /error.code=subscription_sharing_unsupported_capability/);
    assert.match(userMessage, /error.param=tools/);
    assert.doesNotMatch(userMessage, /synthetic raw provider detail/);
    return true;
  });
  const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
  const exitCode = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    env: {},
    inspect: async () => syntheticSnapshot,
    stdout: output,
    confirmSend: async () => true,
    provider,
  });
  assert.equal(exitCode, 1);
  assert.match(output.value, /unsupported SIWC capability/);
  assert.match(output.value, /error.code=subscription_sharing_unsupported_capability/);
  assert.match(output.value, /error.param=tools/);
  assert.doesNotMatch(output.value, /synthetic raw provider detail/);
});

test("all official SIWC Responses error codes retain code/param and actionable recovery guidance", async () => {
  const cases = [
    { code: "subscription_sharing_unsupported_capability", status: 400, param: "tools.execution", expected: /error.param=tools\.execution.*remove or revise.*Do not resend the same body/i },
    { code: "subscription_sharing_route_not_supported", status: 403, expected: /verify the method and URL.*POST https:\/\/api\.openai\.com\/v1\/responses/i },
    { code: "subscription_sharing_invalid_user", status: 401, expected: /preserve the request ID.*only after confirmed revocation or a terminal refresh failure/i },
    { code: "chatpass_v2_scope_not_authorized", status: 403, expected: /check the issued client and grant configuration.*Do not blindly retry or change billing mode/i },
    { code: "chatpass_v2_invalid_authorization_context", status: 403, expected: /check the issued client and grant configuration.*Do not blindly retry or change billing mode/i },
    { code: "subscription_sharing_user_not_eligible", status: 403, expected: /selected user, workspace, or policy.*do not repeat this request or loop through OAuth/i },
    { code: "subscription_sharing_usage_limit_exceeded", status: 429, expected: /cannot distinguish an app-specific limit from a shared plan limit.*does not indicate a reset time/i },
    { code: "subscription_sharing_usage_unavailable", status: 503, expected: /preserve credentials and retry later with bounded backoff/i },
    { code: "subscription_sharing_user_unavailable", status: 503, expected: /preserve credentials and retry later with bounded backoff/i },
  ] as const;
  for (const item of cases) {
    const requestId = `synthetic-${item.code}`;
    const privateMessage = `synthetic private response text ${item.code}`;
    const provider = createSiwcResponsesProvider({
      getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
      fetchImpl: async () => Response.json({
        error: { code: item.code, ...(item.param ? { param: item.param } : {}), message: privateMessage },
      }, { status: item.status, headers: { "openai-request-id": requestId } }),
    });
    await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
      assert.ok(error instanceof SiwcProviderError);
      assert.equal(error.status, item.status);
      assert.equal(error.code, item.code);
      assert.equal(error.param, item.param ?? null);
      assert.equal(error.bodyShape, "error-object");
      assert.equal(error.requestId, requestId);
      const message = error.toUserMessage();
      assert.match(message, item.expected);
      assert.match(message, new RegExp(`error.code=${item.code}`));
      assert.match(message, new RegExp(`request ID=${requestId}`));
      if (item.param) assert.match(message, new RegExp(`error.param=${item.param}`));
      assert.doesNotMatch(message, /synthetic private response text/);
      if (item.code === "subscription_sharing_usage_limit_exceeded") {
        assert.match(message, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.doesNotMatch(message, /entire plan.*exhausted|reset in \d+/i);
      }
      return true;
    });
  }
});

test("Responses provider refuses system-role input and preview-only unsupported fields before token access", async () => {
  let tokenReads = 0;
  let networkCalls = 0;
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => { tokenReads += 1; return CALLBACK_ACCESS_TOKEN; },
    fetchImpl: async () => { networkCalls += 1; throw new Error("must not call"); },
  });
  const systemRoleBody = JSON.parse(responsesRequest().serializedBody) as { input: Array<{ role: string; content: string }> };
  systemRoleBody.input[0]!.role = "system";
  const systemRole = JSON.stringify(systemRoleBody);
  await assert.rejects(provider.send(responsesRequest(systemRole)), /explicit system.*rejected/);
  const unsupported = JSON.stringify({ model: "x", instructions: "i", input: [], previous_response_id: "old", store: false, stream: true });
  await assert.rejects(provider.send(responsesRequest(unsupported)), /unsupported by the current plan-usage preview.*previous_response_id.*remove that field/);
  assert.equal(tokenReads, 0);
  assert.equal(networkCalls, 0);
});

test("usage-limit stream errors never become success and point to shared plan usage management", async () => {
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => new Response(
      sseEvent("response.output_text.delta", { delta: "partial synthetic text" }) +
      sseEvent("response.failed", { response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "synthetic only" } } }),
      { status: 200, headers: { "Content-Type": "text/event-stream", "x-request-id": "synthetic-stream-id" } },
    ),
  });
  await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.equal(error.code, "subscription_sharing_usage_limit_exceeded");
    assert.equal(error.status, 200);
    assert.equal(error.requestId, "synthetic-stream-id");
    assert.match(error.message, /usage limit was reached/i);
    assert.match(error.message, /cannot distinguish an app-specific limit from a shared plan limit/i);
    assert.match(error.message, /does not indicate a reset time/i);
    assert.doesNotMatch(error.message, /entire plan.*exhausted|reset in \d+/i);
    assert.match(error.message, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(error.message, /synthetic only|partial synthetic text/);
    return true;
  });
});

test("a stream without response.completed fails and direct-admission detail text is filtered and kept separate from stable codes", async () => {
  const interrupted = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => new Response(sseEvent("response.output_text.delta", { delta: "partial" }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  await assert.rejects(interrupted.send(responsesRequest()), /without response.completed/);

  const admissionCases: ReadonlyArray<{
    status: number;
    requestId: string;
    code?: string;
    param?: string;
    unsafeParam?: string;
    nestedDetail?: boolean;
    detailText: string;
    expectedDetail: string | null;
  }> = [
    { status: 401, requestId: "synthetic-admission-401", code: "admission_denied", param: "scopes", detailText: "Selected region does not permit this request.", expectedDetail: "Selected region does not permit this request." },
    { status: 403, requestId: "synthetic-admission-403", unsafeParam: "bad\nsynthetic-injected-param-secret", detailText: `Denied: Bearer ${CALLBACK_ACCESS_TOKEN}`, expectedDetail: null },
    { status: 503, requestId: "synthetic-admission-503", code: "route_temporarily_unavailable", detailText: "temporary route failure", expectedDetail: "temporary route failure" },
    { status: 403, requestId: "synthetic-admission-nested-detail", code: "chatpass_v2_scope_not_authorized", param: "resource.invoke", nestedDetail: true, detailText: "nested private detail", expectedDetail: null },
    { status: 401, requestId: "synthetic-admission-detail-code", detailText: "invalid_grant", expectedDetail: "invalid_grant" },
    { status: 403, requestId: "synthetic-admission-control", detailText: "policy\ndenied", expectedDetail: "policy denied" },
    { status: 403, requestId: "synthetic-admission-bidi", detailText: `safe-before${String.fromCodePoint(0x202e)}spoofed-after${String.fromCodePoint(0x2066)}left${String.fromCodePoint(0x2067)}right${String.fromCodePoint(0x2068)}first${String.fromCodePoint(0x2069)}done`, expectedDetail: "safe-before\\u202Espoofed-after\\u2066left\\u2067right\\u2068first\\u2069done" },
    { status: 403, requestId: "synthetic-admission-length", detailText: "diagnostic text ".repeat(30), expectedDetail: `${"diagnostic text ".repeat(30).slice(0, 239)}…` },
  ];
  for (const item of admissionCases) {
    const providedParam = item.param ?? ("unsafeParam" in item ? item.unsafeParam : undefined);
    const nestedDetail = Boolean(item.nestedDetail);
    const detail = nestedDetail
      ? { ...(item.code ? { code: item.code } : {}), ...(providedParam ? { param: providedParam } : {}), message: item.detailText }
      : item.detailText;
    const provider = createSiwcResponsesProvider({
      getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
      fetchImpl: async () => Response.json({
        detail,
        ...(!nestedDetail && item.code ? { error: { code: item.code, ...(providedParam ? { param: providedParam } : {}) } } : {}),
        ...(!nestedDetail && providedParam ? { param: providedParam } : {}),
      }, { status: item.status, headers: { "openai-request-id": item.requestId } }),
    });
    await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
      assert.ok(error instanceof SiwcProviderError);
      assert.equal(error.status, item.status);
      const standardErrorObject = !nestedDetail && Boolean(item.code);
      assert.equal(error.code, standardErrorObject ? item.code ?? null : null);
      assert.equal(error.param, standardErrorObject ? item.param ?? null : null);
      assert.equal(error.detail, item.expectedDetail);
      const expectedShape = standardErrorObject ? "error-object" : "detail-object";
      assert.equal(error.bodyShape, expectedShape);
      assert.equal(error.requestId, item.requestId);
      const message = error.toUserMessage();
      assert.match(message, new RegExp(`HTTP ${item.status}`));
      assert.match(message, new RegExp(`response body shape=${expectedShape}`));
      assert.match(message, new RegExp(`request ID=${item.requestId}`));
      if (standardErrorObject && item.code) assert.match(message, new RegExp(`error.code=${item.code}`));
      if (standardErrorObject && item.param) assert.match(message, new RegExp(`error.param=${item.param}`));
      if (nestedDetail) assert.doesNotMatch(message, /error.code=chatpass_v2_scope_not_authorized|error.param=resource\.invoke/);
      if (item.expectedDetail) assert.ok(message.includes(JSON.stringify(item.expectedDetail)));
      assert.doesNotMatch(message, /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/);
      assert.doesNotMatch(message, /synthetic-access-token-never-log|synthetic-injected-param-secret|nested private detail/);
      return true;
    });
  }
});

test("readonly CLI previews SIWC JSON without API key, sends only after approval, and never falls back", async () => {
  let keyRead = false;
  let modelCalls = 0;
  let capturedRequest = "";
  let sentAuthorization = "";
  const output = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
  const modelText = JSON.stringify({
    understanding: [{ text: "Synthetic greeting declaration.", citations: [{ path: "src/main.ts", startLine: 1, endLine: 1 }] }],
    plan: [{ text: "Check its call site.", citations: [{ path: "src/main.ts", startLine: 1, endLine: 1 }] }],
  });
  const provider = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async (input, init) => {
      modelCalls += 1;
      assert.equal(String(input), SIWC_RESPONSES_ENDPOINT);
      sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      capturedRequest = String(init?.body);
      return new Response(sseEvent("response.output_text.delta", { delta: modelText }) + sseEvent("response.completed", { response: { output: [] } }), {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });
  const env = {
    get OPENAI_API_KEY() {
      keyRead = true;
      throw new Error("API key must never be read in SIWC mode");
    },
  };
  let disclosureVisibleBeforeApproval = false;
  const exitCode = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    providerLabel: "ChatGPT plan (SIWC)",
    env,
    inspect: async () => syntheticSnapshot,
    stdout: output,
    confirmSend: async () => {
      disclosureVisibleBeforeApproval = /本机运行的 Coda 进程会读取并处理你控制的本机配置目录中的 SIWC 凭据/.test(output.value) &&
        /凭据不会发送到 Coda 远端服务/.test(output.value) &&
        /所选仓库的有限文本上下文仅在你批准后由本机直接发送给 OpenAI 官方 Responses API/.test(output.value) &&
        /Coda 远端服务不接收该 payload，也不代理请求/.test(output.value);
      return true;
    },
    provider,
    fetchImpl: async () => { throw new Error("no fallback fetch"); },
  });
  assert.equal(exitCode, 0);
  assert.equal(disclosureVisibleBeforeApproval, true);
  assert.equal(modelCalls, 1);
  assert.equal(keyRead, false);
  assert.equal(sentAuthorization, `Bearer ${CALLBACK_ACCESS_TOKEN}`);
  assert.ok(output.value.includes("ChatGPT plan"));
  assert.match(output.value, /正在使用 ChatGPT 方案额度/);
  assert.match(output.value, /本次请求会消耗所选账户额度/);
  assert.ok(output.value.includes(SIWC_PLAN_USAGE_NOTICE));
  assert.doesNotMatch(output.value, /额度可能与其他已连接应用共享/);
  assert.match(output.value, /本机运行的 Coda 进程会读取并处理你控制的本机配置目录中的 SIWC 凭据/);
  assert.match(output.value, /凭据不会发送到 Coda 远端服务/);
  assert.match(output.value, /所选仓库的有限文本上下文仅在你批准后由本机直接发送给 OpenAI 官方 Responses API/);
  assert.match(output.value, /Coda 远端服务不接收该 payload，也不代理请求/);
  assert.ok(output.value.includes(SIWC_USAGE_URL));
  assert.ok(output.value.includes(capturedRequest));
  assert.ok(!capturedRequest.includes(CALLBACK_ACCESS_TOKEN));
  const body = JSON.parse(capturedRequest) as Record<string, unknown>;
  assert.equal(body.store, false);
  assert.equal(body.stream, true);
  assert.equal(body.model, "synthetic-current-slug");
  assert.equal(Object.hasOwn(body, "messages"), false);
  assert.equal(Object.hasOwn(body, "previous_response_id"), false);

  const noFallbackOutput = { value: "", write(chunk: string | Uint8Array) { this.value += String(chunk); return true; } };
  const noFallback = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    env,
    inspect: async () => syntheticSnapshot,
    stdout: noFallbackOutput,
    confirmSend: async () => true,
    fetchImpl: async () => { throw new Error("must not fetch"); },
  });
  assert.equal(noFallback, 1);
  assert.equal(keyRead, false);
  assert.match(noFallbackOutput.value, /不会静默切换/);
});

test("TUI status shows the truthful plan authorization state and Usage link without revealing tokens", async () => {
  await withTemporaryStore(async (storePath, root) => {
    const xdg = path.join(root, "xdg");
    const env = { XDG_CONFIG_HOME: xdg };
    assert.equal(resolveSiwcStorePath(env), path.join(xdg, "coda", "siwc-credentials.json"));
    assert.equal(resolveSiwcStorePath({ XDG_CONFIG_HOME: "relative-config" }), path.join(os.homedir(), ".config", "coda", "siwc-credentials.json"));
    const emptyStatus = await readSiwcTuiStatus(env);
    assert.match(emptyStatus, /未连接/);
    assert.match(emptyStatus, /Fake-provider 演示不使用 ChatGPT plan/);
    assert.match(emptyStatus, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    await initializedStore(storePath, accountRecord({ accessToken: "unique-synthetic-display-secret" }));
    const activeStatus = await readSiwcTuiStatus({ XDG_CONFIG_HOME: path.join(root, "config") });
    assert.match(activeStatus, /活动账户已授予 plan-use scope/);
    assert.match(activeStatus, /Fake-provider 演示仍只返回本地模拟结果/);
    assert.ok(!activeStatus.includes("unique-synthetic-display-secret"));
    assert.ok(!activeStatus.includes(CALLBACK_REFRESH_TOKEN));
  });
});
}
