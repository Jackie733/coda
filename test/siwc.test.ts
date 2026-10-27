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
  callbackExpectedStatus?: number;
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
    callback.searchParams.set("code", "synthetic-authorization-code");
    callback.searchParams.set("state", authorizationUrl.searchParams.get("state") ?? "");
    callback.searchParams.set("client_id", callbackClientId);
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
        disclosureWasVisibleBeforeBrowser = /首次授权说明/.test(output.value) &&
          /额度可能与其他已连接应用共享/.test(output.value) &&
          /题目与所选仓库上下文会直接发送给 OpenAI/.test(output.value) &&
          /SIWC 凭据只保存在本机/.test(output.value) &&
          /Coda 不经远端代理/.test(output.value) &&
          output.value.includes(SIWC_USAGE_URL);
        await mocks.openBrowser(url);
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(disclosureWasVisibleBeforeBrowser, true);
    assert.match(output.value, /会消耗本人 ChatGPT plan\/credits/);
    assert.match(output.value, /题目与所选仓库上下文会直接发送给 OpenAI/);
    assert.match(output.value, /SIWC 凭据只保存在本机/);
    assert.match(output.value, /Coda 不经远端代理/);
    assert.match(output.value, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
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

test("refresh token rotation is serialized across concurrent callers and replaces the whole token set", async () => {
  await withTemporaryStore(async (storePath) => {
    await initializedStore(storePath, accountRecord({ expiresAt: Date.now() - 10_000 }));
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
      error: { code: "unsupported_capability", param: "tools", message: "synthetic raw provider detail" },
    }, { status: 400 }),
  });
  await assert.rejects(provider.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.equal(error.code, "unsupported_capability");
    assert.equal(error.param, "tools");
    const userMessage = error.toUserMessage();
    assert.match(userMessage, /unsupported Responses field or capability/i);
    assert.match(userMessage, /tools/);
    assert.match(userMessage, /error.code=unsupported_capability/);
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
  assert.match(output.value, /unsupported Responses field or capability/);
  assert.match(output.value, /error.code=unsupported_capability/);
  assert.match(output.value, /error.param=tools/);
  assert.doesNotMatch(output.value, /synthetic raw provider detail/);
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
    assert.match(error.message, /usage limit reached/i);
    assert.match(error.message, new RegExp(SIWC_USAGE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(error.message, /synthetic only|partial synthetic text/);
    return true;
  });
});

test("a stream without response.completed and a non-OK detail body remain explicit failures", async () => {
  const interrupted = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => new Response(sseEvent("response.output_text.delta", { delta: "partial" }), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  });
  await assert.rejects(interrupted.send(responsesRequest()), /without response.completed/);

  const rejected = createSiwcResponsesProvider({
    getAccessToken: async () => CALLBACK_ACCESS_TOKEN,
    fetchImpl: async () => Response.json({ detail: "synthetic private diagnostic" }, { status: 503, headers: { "openai-request-id": "synthetic-admission-id" } }),
  });
  await assert.rejects(rejected.send(responsesRequest()), (error: unknown) => {
    assert.ok(error instanceof SiwcProviderError);
    assert.equal(error.status, 503);
    assert.equal(error.code, null);
    assert.equal(error.bodyShape, "detail-object");
    assert.equal(error.requestId, "synthetic-admission-id");
    assert.doesNotMatch(error.message, /synthetic private diagnostic/);
    return true;
  });
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
  const exitCode = await runReadonlyCli({
    cwd: "/synthetic/repository",
    requestMode: "siwc",
    model: "synthetic-current-slug",
    providerLabel: "ChatGPT plan (SIWC)",
    env,
    inspect: async () => syntheticSnapshot,
    stdout: output,
    confirmSend: async () => true,
    provider,
    fetchImpl: async () => { throw new Error("no fallback fetch"); },
  });
  assert.equal(exitCode, 0);
  assert.equal(modelCalls, 1);
  assert.equal(keyRead, false);
  assert.equal(sentAuthorization, `Bearer ${CALLBACK_ACCESS_TOKEN}`);
  assert.ok(output.value.includes("ChatGPT plan"));
  assert.match(output.value, /正在使用 ChatGPT 方案额度/);
  assert.match(output.value, /本次请求会消耗所选账户额度/);
  assert.match(output.value, /额度可能与其他已连接应用共享/);
  assert.match(output.value, /任务与所选仓库上下文会在你批准后直接发送给 OpenAI 官方 Responses API/);
  assert.match(output.value, /Coda 不经远端代理/);
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
