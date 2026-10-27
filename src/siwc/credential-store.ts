import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const SIWC_PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SIWC_RESOURCE_SCOPE = "resource.invoke";
export const SIWC_REFRESH_SCOPE = "offline_access";

export type SiwcAccountRecord = Readonly<{
  clientId: string;
  issuer: "https://auth.openai.com";
  subject: string;
  email?: string;
  name?: string;
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
  scopes: readonly string[];
  expiresAt: number | null;
  updatedAt: string;
}>;

export type SiwcCredentialStore = Readonly<{
  version: 1;
  hostId: string;
  activeClientId: string | null;
  accounts: readonly SiwcAccountRecord[];
}>;

export type SiwcAccountStatus = Readonly<{
  clientId: string;
  email?: string;
  isActive: boolean;
  signedIn: boolean;
  planUsageAuthorized: boolean;
  expiresAt: number | null;
}>;

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const LOCK_MAX_WAIT_MS = 15_000;
const MAX_STORE_BYTES = 1_048_576;
const MAX_ACCOUNTS = 32;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Environment = Readonly<Record<string, string | undefined>>;
type StoreMutation = (current: SiwcCredentialStore) => SiwcCredentialStore;

export function resolveSiwcStorePath(env: Environment = process.env): string {
  const configuredHome = env.XDG_CONFIG_HOME;
  const configHome = configuredHome && path.isAbsolute(configuredHome)
    ? configuredHome
    : path.join(os.homedir(), ".config");
  return path.resolve(configHome, "coda", "siwc-credentials.json");
}

export function assertSiwcCredentialPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("当前版本在 Windows 上暂不读取或写入 SIWC 凭据，因为尚未验证 owner-only ACL；请使用受 POSIX 权限保护的 macOS/Linux 环境。");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateAccount(value: unknown): SiwcAccountRecord {
  if (!isRecord(value)) throw new Error("SIWC 本地凭据记录格式无效；不会使用其中的凭据。");
  const { clientId, issuer, subject, idToken, accessToken, refreshToken, scopes, expiresAt, updatedAt } = value;
  if (
    typeof clientId !== "string" || !clientId || clientId === "dynamic_agent_client" ||
    issuer !== "https://auth.openai.com" || typeof subject !== "string" || !subject ||
    (idToken !== null && (typeof idToken !== "string" || !idToken)) ||
    (accessToken !== null && (typeof accessToken !== "string" || !accessToken)) ||
    (refreshToken !== null && (typeof refreshToken !== "string" || !refreshToken)) ||
    !Array.isArray(scopes) || scopes.length > 64 || scopes.some((scope) => typeof scope !== "string" || !scope) ||
    (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) ||
    typeof updatedAt !== "string" || !Number.isFinite(Date.parse(updatedAt))
  ) {
    throw new Error("SIWC 本地凭据记录格式无效；不会使用其中的凭据。");
  }
  if (value.email !== undefined && typeof value.email !== "string") throw new Error("SIWC 本地账户信息格式无效。");
  if (value.name !== undefined && typeof value.name !== "string") throw new Error("SIWC 本地账户信息格式无效。");
  return Object.freeze({
    clientId,
    issuer,
    subject,
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    idToken,
    accessToken,
    refreshToken,
    scopes: Object.freeze([...new Set(scopes as string[])]),
    expiresAt,
    updatedAt,
  });
}

function validateStore(value: unknown): SiwcCredentialStore {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.accounts)) {
    throw new Error("SIWC 本地凭据文件版本或格式无效；不会使用其中的凭据。");
  }
  if (typeof value.hostId !== "string" || !value.hostId.startsWith("urn:uuid:") || !UUID_V4.test(value.hostId.slice("urn:uuid:".length))) {
    throw new Error("SIWC 本地 host ID 格式无效；不会使用其中的凭据。");
  }
  if (value.activeClientId !== null && typeof value.activeClientId !== "string") {
    throw new Error("SIWC 本地活动账户标识无效；不会使用其中的凭据。");
  }
  if (value.accounts.length > MAX_ACCOUNTS) throw new Error("SIWC 本地账户数量超出安全上限；不会使用其中的凭据。");
  const accounts = value.accounts.map(validateAccount);
  if (new Set(accounts.map((account) => account.clientId)).size !== accounts.length) {
    throw new Error("SIWC 本地账户记录重复；不会使用其中的凭据。");
  }
  if (value.activeClientId !== null && !accounts.some((account) => account.clientId === value.activeClientId)) {
    throw new Error("SIWC 本地活动账户不存在；不会使用其中的凭据。");
  }
  return Object.freeze({
    version: 1,
    hostId: value.hostId,
    activeClientId: value.activeClientId,
    accounts: Object.freeze(accounts),
  });
}

async function ensurePrivateDirectory(storePath: string): Promise<void> {
  assertSiwcCredentialPlatform();
  const directory = path.dirname(storePath);
  await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
  const details = await lstat(directory).catch(() => null);
  if (!details || details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("SIWC 凭据目录不是安全的普通目录；不会写入凭据。");
  }
  if (process.platform !== "win32") await chmod(directory, DIRECTORY_MODE);
}

async function assertPrivateDirectory(storePath: string): Promise<boolean> {
  assertSiwcCredentialPlatform();
  let details;
  try {
    details = await lstat(path.dirname(storePath));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw new Error("无法安全检查 SIWC 凭据目录。");
  }
  if (details.isSymbolicLink() || !details.isDirectory()) {
    throw new Error("SIWC 凭据目录不是安全的普通目录；不会读取凭据。");
  }
  if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
    throw new Error("SIWC 凭据目录权限过宽；请将目录权限限制为仅当前用户可访问（0700）。");
  }
  return true;
}

async function readUnlocked(storePath: string): Promise<SiwcCredentialStore | null> {
  if (!await assertPrivateDirectory(storePath)) return null;
  let handle;
  try {
    const flags = process.platform === "win32" ? "r" : constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(storePath, flags);
    const details = await handle.stat();
    if (!details.isFile()) throw new Error("SIWC 本地凭据必须是普通文件；不会跟随符号链接。");
    if (details.size > MAX_STORE_BYTES) throw new Error("SIWC 本地凭据文件超过安全大小上限；不会读取其中的凭据。");
    if (process.platform !== "win32" && (details.mode & 0o077) !== 0) {
      throw new Error("SIWC 本地凭据权限过宽；请将文件权限限制为仅当前用户可读写（0600）。");
    }
    const parsed: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    return validateStore(parsed);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    if (error instanceof Error && (/权限过宽|普通文件|安全大小上限|账户数量超出|格式无效|版本或格式无效|host ID|活动账户|账户记录重复/.test(error.message))) throw error;
    throw new Error("SIWC 本地凭据文件无法安全读取或解析；不会使用其中的凭据。");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readSiwcCredentialStore(storePath = resolveSiwcStorePath()): Promise<SiwcCredentialStore | null> {
  return readUnlocked(storePath);
}

async function writeUnlocked(storePath: string, store: SiwcCredentialStore): Promise<void> {
  await ensurePrivateDirectory(storePath);
  const checked = validateStore(store);
  const temporaryPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(checked, null, 2)}\n`, "utf8");
    await handle.sync();
    if (process.platform !== "win32") await handle.chmod(FILE_MODE);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
  try {
    await rename(temporaryPath, storePath);
    if (process.platform !== "win32") await chmod(storePath, FILE_MODE);
    if (process.platform !== "win32") {
      const directoryHandle = await open(path.dirname(storePath), "r");
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function withSiwcStoreLock<T>(storePath: string, operation: () => Promise<T>): Promise<T> {
  await ensurePrivateDirectory(storePath);
  const lockPath = `${storePath}.lock`;
  const deadline = Date.now() + LOCK_MAX_WAIT_MS;
  let lockHandle;
  while (!lockHandle) {
    try {
      lockHandle = await open(lockPath, "wx", FILE_MODE);
      if (process.platform !== "win32") await lockHandle.chmod(FILE_MODE);
      await lockHandle.writeFile(`${process.pid}\n`, "utf8");
      await lockHandle.sync();
    } catch (error) {
      if (lockHandle) {
        await lockHandle.close().catch(() => undefined);
        await rm(lockPath, { force: true }).catch(() => undefined);
        lockHandle = undefined;
      }
      if (!isRecord(error) || error.code !== "EEXIST") throw new Error("无法安全锁定 SIWC 本地凭据。");
      if (Date.now() >= deadline) throw new Error("SIWC 本地凭据正被另一个进程使用；请稍后重试。");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await operation();
  } finally {
    await lockHandle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function updateSiwcCredentialStore(
  storePath: string,
  mutation: StoreMutation,
): Promise<SiwcCredentialStore> {
  return withSiwcStoreLock(storePath, async () => {
    const current = await readUnlocked(storePath);
    if (!current) throw new Error("SIWC 本地凭据尚未初始化；请先运行登录流程。");
    const updated = validateStore(mutation(current));
    await writeUnlocked(storePath, updated);
    return updated;
  });
}

export async function ensureSiwcCredentialStore(storePath = resolveSiwcStorePath()): Promise<SiwcCredentialStore> {
  return withSiwcStoreLock(storePath, async () => {
    const existing = await readUnlocked(storePath);
    if (existing) return existing;
    const created = validateStore({
      version: 1,
      hostId: `urn:uuid:${randomUUID()}`,
      activeClientId: null,
      accounts: [],
    });
    await writeUnlocked(storePath, created);
    return created;
  });
}

export async function saveSiwcAccount(
  storePath: string,
  account: SiwcAccountRecord,
  expectedSubject?: string,
): Promise<SiwcCredentialStore> {
  return updateSiwcCredentialStore(storePath, (current) => {
    const existing = current.accounts.find((item) => item.clientId === account.clientId);
    if (expectedSubject && (!existing || existing.subject !== expectedSubject)) {
      throw new Error("所选 SIWC 账户已变更；为避免覆盖其他账户凭据，本次登录未保存。");
    }
    if (existing && existing.subject !== account.subject) {
      throw new Error("SIWC 账户身份不匹配；为避免覆盖其他账户凭据，本次登录未保存。");
    }
    const accounts = existing
      ? current.accounts.map((item) => item.clientId === account.clientId ? account : item)
      : [...current.accounts, account];
    return Object.freeze({ ...current, activeClientId: account.clientId, accounts: Object.freeze(accounts) });
  });
}

export function planUsageAuthorized(account: SiwcAccountRecord): boolean {
  return account.scopes.includes(SIWC_PLAN_SCOPE) && account.scopes.includes(SIWC_RESOURCE_SCOPE);
}

export function siwcAccountStatuses(store: SiwcCredentialStore | null): readonly SiwcAccountStatus[] {
  if (!store) return Object.freeze([]);
  return Object.freeze(store.accounts.map((account) => Object.freeze({
    clientId: account.clientId,
    ...(account.email ? { email: account.email } : {}),
    isActive: store.activeClientId === account.clientId,
    signedIn: Boolean(account.accessToken || account.idToken),
    planUsageAuthorized: planUsageAuthorized(account),
    expiresAt: account.expiresAt,
  })));
}

export function accountFromStore(store: SiwcCredentialStore, clientId?: string): SiwcAccountRecord {
  const selectedId = clientId ?? store.activeClientId;
  if (!selectedId) throw new Error("尚无活动的 ChatGPT 账户；请先运行 `npm run siwc -- login --plan-usage`。");
  const account = store.accounts.find((item) => item.clientId === selectedId);
  if (!account) throw new Error("找不到所选 SIWC 账户；请运行 `npm run siwc -- status` 查看本地账户。");
  return account;
}

export function clearSiwcAccountTokens(
  store: SiwcCredentialStore,
  clientId: string,
): SiwcCredentialStore {
  const found = store.accounts.some((account) => account.clientId === clientId);
  if (!found) throw new Error("找不到所选 SIWC 账户。");
  return Object.freeze({
    ...store,
    activeClientId: store.activeClientId === clientId ? null : store.activeClientId,
    accounts: Object.freeze(store.accounts.map((account) => account.clientId === clientId
      ? Object.freeze({ ...account, idToken: null, accessToken: null, refreshToken: null, scopes: Object.freeze([]), expiresAt: null, updatedAt: new Date().toISOString() })
      : account)),
  });
}


export async function mutateSiwcCredentialStoreLocked<T>(
  storePath: string,
  operation: (current: SiwcCredentialStore) => Promise<Readonly<{ store: SiwcCredentialStore; result: T }>>,
): Promise<T> {
  return withSiwcStoreLock(storePath, async () => {
    const current = await readUnlocked(storePath);
    if (!current) throw new Error("SIWC 本地凭据尚未初始化；请先运行登录流程。");
    const changed = await operation(current);
    const updated = validateStore(changed.store);
    await writeUnlocked(storePath, updated);
    return changed.result;
  });
}
