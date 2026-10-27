import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { updateSiwcCredentialStore, accountFromStore, readSiwcCredentialStore, resolveSiwcStorePath, siwcAccountStatuses } from "./siwc/credential-store.js";
import { runSiwcAuthorization, type AuthorizationOptions } from "./siwc/oauth.js";
import { getSiwcAccessTokenForUsage, logoutSiwcAccount } from "./siwc/session.js";
import { createSiwcResponsesProvider, listSiwcModels, SIWC_USAGE_URL, SiwcProviderError } from "./siwc/responses-provider.js";
import { runReadonlyCli, type ReadonlyCliOptions } from "./readonly-cli.js";

const USAGE = [
  "Coda SIWC：可选的本机 Sign in with ChatGPT 与计划用量 provider",
  "",
  "用法：",
  "  npm run siwc -- login [--plan-usage] [--client-id <issued-client-id>]",
  "  npm run siwc -- status",
  "  npm run siwc -- select <issued-client-id>",
  "  npm run siwc -- models [--client-id <issued-client-id>]",
  "  npm run siwc -- inspect [--model <catalog-slug>] [问题]",
  "  npm run siwc -- logout [--client-id <issued-client-id>]",
  "",
  "login 默认只请求身份 scope；只有显式加 --plan-usage 才请求 ChatGPT 计划用量权限。",
  "ChatGPT plan 使用和 OpenAI API key 计费分开；不会自动兜底或切换。",
  `Manage usage：${SIWC_USAGE_URL}`,
].join("\n");

type Writer = Pick<Writable, "write">;
type Reader = Readable & { isTTY?: boolean };
type Environment = Readonly<Record<string, string | undefined>>;

type SiwcCliOptions = Readonly<{
  argv?: readonly string[];
  cwd?: string;
  env?: Environment;
  stdin?: Reader;
  stdout?: Writer;
  fetchImpl?: typeof fetch;
  openBrowser?: AuthorizationOptions["openBrowser"];
  confirmSend?: ReadonlyCliOptions["confirmSend"];
  inspect?: ReadonlyCliOptions["inspect"];
}>;

function write(stdout: Writer, text: string): void {
  stdout.write(text);
}

function safeError(error: unknown): string {
  if (error instanceof SiwcProviderError) return error.toUserMessage();
  return error instanceof Error ? error.message : "操作未完成；凭据未显示。";
}

function valueAfter(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (args.lastIndexOf(flag) !== index || !args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`${flag} 需要且只能有一个值。`);
  }
  return args[index + 1];
}

function removeOption(args: readonly string[], flag: string): string[] {
  const index = args.indexOf(flag);
  if (index < 0) return [...args];
  return args.filter((_, itemIndex) => itemIndex !== index && itemIndex !== index + 1);
}

function defaultOpenBrowser(authorizationUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let command: string;
    let args: string[];
    if (process.platform === "darwin") {
      command = "open";
      args = [authorizationUrl];
    } else if (process.platform === "win32") {
      command = "cmd.exe";
      args = ["/c", "start", "", authorizationUrl];
    } else {
      command = "xdg-open";
      args = [authorizationUrl];
    }
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    } catch {
      reject(new Error("browser-launch-failed"));
      return;
    }
    child.once("error", () => reject(new Error("browser-launch-failed")));
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("browser-launch-failed")));
    child.unref();
  });
}

async function promptModel(
  stdin: Reader,
  stdout: Writer,
  models: readonly Readonly<{ slug: string; displayName: string }>[],
): Promise<string | null> {
  if (!stdin.isTTY) {
    write(stdout, "当前不是交互终端；请从刚读取的账户目录中显式传入 --model <slug>。未发起推理。\n");
    return null;
  }
  write(stdout, "所选 ChatGPT 账户当前可用的模型：\n");
  models.forEach((model, index) => write(stdout, `  ${index + 1}. ${model.displayName} (${model.slug})\n`));
  const readline = createInterface({ input: stdin, output: stdout as Writable });
  try {
    const answer = (await readline.question("选择编号；其他输入取消，不会自动选用其他模型：")).trim();
    const index = Number(answer) - 1;
    return Number.isInteger(index) && index >= 0 && index < models.length ? models[index].slug : null;
  } finally {
    readline.close();
  }
}

async function printStatus(stdout: Writer, storePath: string): Promise<void> {
  const store = await readSiwcCredentialStore(storePath);
  const statuses = siwcAccountStatuses(store);
  write(stdout, "SIWC 本地账户状态（不会显示或输出 token）：\n");
  if (statuses.length === 0) {
    write(stdout, "尚未连接 ChatGPT 账户。\n");
    write(stdout, "身份登录：npm run siwc -- login\n");
    write(stdout, "要使用计划额度，需明确运行：npm run siwc -- login --plan-usage\n");
  } else {
    for (const status of statuses) {
      const active = status.isActive ? "活动账户" : "已保存账户";
      const label = status.email ? `${status.email} · ${status.clientId}` : status.clientId;
      const authorization = status.planUsageAuthorized ? "已授予 plan-use scope" : "未授予 plan-use scope";
      const session = status.signedIn
        ? status.expiresAt === null ? "有身份凭据，access token 状态未知/需重新授权" : `access token 到期：${new Date(status.expiresAt).toISOString()}`
        : "已退出（本机 token 已清除）";
      write(stdout, `- ${active}：${label}\n  授权：${authorization}；${session}\n`);
    }
    const active = statuses.find((item) => item.isActive);
    if (active?.planUsageAuthorized && active.signedIn) {
      write(stdout, "活动账户：ChatGPT plan 授权已启用；真实请求会使用其当前 plan/credits 额度，并与其他已连接应用共享。\n");
    } else {
      write(stdout, "当前没有可直接用于 ChatGPT plan 推理的活动授权。API-key provider 仍是独立模式。\n");
    }
  }
  write(stdout, `Manage usage：${SIWC_USAGE_URL}\n`);
}

async function runLogin(args: readonly string[], options: SiwcCliOptions, stdout: Writer, storePath: string): Promise<number> {
  const requestPlanUsage = args.includes("--plan-usage");
  const clientId = valueAfter(args, "--client-id");
  const unexpected = args.filter((arg, index) => arg !== "--plan-usage" && arg !== "--client-id" && (index === 0 || args[index - 1] !== "--client-id"));
  if (unexpected.length > 0) throw new Error(`login 参数不支持：${unexpected.join(" ")}`);
  const store = await readSiwcCredentialStore(storePath);
  const existing = clientId ? store?.accounts.find((account) => account.clientId === clientId) : undefined;
  if (clientId && !existing) throw new Error("--client-id 必须是 `siwc status` 显示的本机 issued client ID。");
  if (requestPlanUsage) {
    write(stdout, "Continue with ChatGPT：首次授权说明——获准后，每次明确确认的 AI 请求会消耗本人 ChatGPT plan/credits，额度可能与其他已连接应用共享；题目与所选仓库上下文会直接发送给 OpenAI，SIWC 凭据只保存在本机，Coda 不经远端代理。\n");
    write(stdout, `可在此查看或管理额度：${SIWC_USAGE_URL}\n`);
  } else {
    write(stdout, "Continue with ChatGPT：本次只请求身份 scope，不会启用 ChatGPT plan 推理。\n");
  }
  const needsConsent = Boolean(existing && requestPlanUsage && !existing.scopes.includes("chatgpt.tokens.use.direct"));
  const result = await runSiwcAuthorization({
    storePath,
    ...(clientId ? { existingClientId: clientId } : {}),
    requestPlanUsage,
    ...(needsConsent ? { promptConsent: true } : {}),
    fetchImpl: options.fetchImpl,
    openBrowser: options.openBrowser ?? defaultOpenBrowser,
  });
  const accountLabel = result.account.email ?? result.account.clientId;
  write(stdout, `SIWC 登录已验证并保存在本机（账户：${accountLabel}；token 未显示）。\n`);
  if (result.planUsageAuthorized) {
    write(stdout, "ChatGPT plan use 已启用；后续推理只会使用此账户授权的 plan/credits，不会切到 API key。\n");
    write(stdout, `Manage usage：${SIWC_USAGE_URL}\n`);
  } else if (requestPlanUsage) {
    write(stdout, "身份登录成功，但 OpenAI 返回的 granted scopes 未包含完整 plan-use 权限；已保留身份登录但禁止 plan 推理。需要时运行 `npm run siwc -- login --client-id <issued-client-id> --plan-usage` 重新授权。\n");
  } else {
    write(stdout, "此账户仅作身份登录；未获明确 plan-use 授权，不能用于推理。\n");
  }
  return 0;
}

async function runSelect(clientId: string | undefined, stdout: Writer, storePath: string): Promise<number> {
  if (!clientId) throw new Error("select 需要一个来自 `siwc status` 的 issued client ID。");
  const updated = await updateSiwcCredentialStore(storePath, (current) => {
    if (!current.accounts.some((account) => account.clientId === clientId)) throw new Error("找不到所选的 SIWC client ID。");
    return Object.freeze({ ...current, activeClientId: clientId });
  });
  const account = accountFromStore(updated, clientId);
  write(stdout, `活动 SIWC 账户已切换为 ${account.email ?? account.clientId}。API-key 模式未改变。\n`);
  return 0;
}

async function runModels(args: readonly string[], stdout: Writer, storePath: string, fetchImpl: typeof fetch): Promise<number> {
  const clientId = valueAfter(args, "--client-id");
  if (args.some((arg) => arg !== "--client-id" && arg !== clientId)) throw new Error("models 只接受可选的 --client-id <issued-client-id>。");
  const token = await getSiwcAccessTokenForUsage({ storePath, clientId, fetchImpl });
  const models = await listSiwcModels(token, fetchImpl);
  write(stdout, "当前账户模型目录（display_name / slug）：\n");
  if (models.length === 0) write(stdout, "账户目录中没有可展示的模型；未发起推理。\n");
  else for (const model of models) write(stdout, `- ${model.displayName} (${model.slug})\n`);
  write(stdout, "本目录来自当前所选账户的 /v1/models；ChatGPT plan 使用额度与其他已连接应用共享。\n");
  write(stdout, `Manage usage：${SIWC_USAGE_URL}\n`);
  return 0;
}

async function runInspect(args: readonly string[], options: SiwcCliOptions, stdout: Writer, storePath: string, fetchImpl: typeof fetch): Promise<number> {
  const model = valueAfter(args, "--model");
  const remaining = removeOption(removeOption(args, "--model"), "--client-id");
  const clientId = valueAfter(args, "--client-id");
  const question = remaining.filter((item) => item !== clientId).join(" ").trim();
  const store = await readSiwcCredentialStore(storePath);
  if (!store) throw new Error("沒有已保存的 SIWC 账户；请运行 `npm run siwc -- login --plan-usage`。");
  const account = accountFromStore(store, clientId);
  if (!account.scopes.includes("chatgpt.tokens.use.direct") || !account.scopes.includes("resource.invoke")) {
    throw new Error("所选账户未获明确 `chatgpt.tokens.use.direct` 和 `resource.invoke` 授权；未请求模型目录或推理。请运行 `npm run siwc -- login --client-id <issued-client-id> --plan-usage`。API key 不会作为兜底。");
  }
  const accessToken = await getSiwcAccessTokenForUsage({ storePath, clientId: account.clientId, fetchImpl });
  const models = await listSiwcModels(accessToken, fetchImpl);
  if (models.length === 0) throw new Error("所选账户没有可展示的模型；未发起推理。");
  let selectedModel: string | null;
  if (model) {
    if (!models.some((item) => item.slug === model)) throw new Error("--model 必须是刚从所选账户当前目录返回的可见 slug；未发起推理。");
    selectedModel = model;
  } else {
    selectedModel = await promptModel(options.stdin ?? process.stdin, stdout, models);
    if (!selectedModel) {
      write(stdout, "已取消模型选择；未发起 Responses 推理。\n");
      return 0;
    }
  }
  const provider = createSiwcResponsesProvider({
    fetchImpl,
    getAccessToken: () => getSiwcAccessTokenForUsage({ storePath, clientId: account.clientId, fetchImpl }),
  });
  return runReadonlyCli({
    cwd: options.cwd,
    question,
    env: options.env ?? {},
    requestMode: "siwc",
    model: selectedModel,
    providerLabel: "ChatGPT plan (SIWC)",
    provider,
    fetchImpl,
    confirmSend: options.confirmSend,
    stdout,
    stdin: options.stdin,
    inspect: options.inspect,
  });
}

async function runLogout(args: readonly string[], stdout: Writer, storePath: string, fetchImpl: typeof fetch): Promise<number> {
  const clientId = valueAfter(args, "--client-id");
  if (args.some((arg) => arg !== "--client-id" && arg !== clientId)) throw new Error("logout 只接受可选的 --client-id <issued-client-id>。");
  const store = await readSiwcCredentialStore(storePath);
  if (!store) throw new Error("本机没有 SIWC 账户凭据。");
  const account = accountFromStore(store, clientId);
  const result = await logoutSiwcAccount({ storePath, clientId: account.clientId, fetchImpl });
  write(stdout, `已从本机清除 ${account.email ?? account.clientId} 的 access、refresh 与 ID token。\n`);
  if (result.remoteRevoked) write(stdout, "OpenAI renewable session 撤销已确认（HTTP 200）。\n");
  else if (result.hadRefreshToken) write(stdout, `远端撤销未确认；本机凭据已清除，可在 ChatGPT 设置中断开该应用：${SIWC_USAGE_URL}\n`);
  else write(stdout, "没有本地 refresh token 可撤销；本机凭据已清除。\n");
  return 0;
}

export async function runSiwcCli(options: SiwcCliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  const argv = [...(options.argv ?? process.argv.slice(2))];
  const command = argv.shift() ?? "status";
  const storePath = resolveSiwcStorePath(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        write(stdout, `${USAGE}\n`);
        return 0;
      case "status":
        if (argv.length) throw new Error("status 不接受参数。");
        await printStatus(stdout, storePath);
        return 0;
      case "login":
        return await runLogin(argv, options, stdout, storePath);
      case "select":
        if (argv.length !== 1) throw new Error("select 需要且只能有一个 issued client ID。");
        return await runSelect(argv[0], stdout, storePath);
      case "models":
        return await runModels(argv, stdout, storePath, fetchImpl);
      case "inspect":
        return await runInspect(argv, options, stdout, storePath, fetchImpl);
      case "logout":
        return await runLogout(argv, stdout, storePath, fetchImpl);
      default:
        write(stdout, `${USAGE}\n`);
        return 2;
    }
  } catch (error) {
    write(stdout, `SIWC 操作未完成：${safeError(error)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runSiwcCli();
}
