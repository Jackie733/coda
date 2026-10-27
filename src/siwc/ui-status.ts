import { readSiwcCredentialStore, resolveSiwcStorePath, siwcAccountStatuses } from "./credential-store.js";
import { SIWC_USAGE_URL } from "./responses-provider.js";

export async function readSiwcTuiStatus(env: Readonly<Record<string, string | undefined>> = process.env): Promise<string> {
  let store;
  try {
    store = await readSiwcCredentialStore(resolveSiwcStorePath(env));
  } catch {
    const reason = process.platform === "win32"
      ? "Windows 当前版本未启用 SIWC 凭据读写（owner-only ACL 尚未验证）"
      : "本机凭据状态不可读取";
    return [
      `SIWC plan 授权状态：${reason}；此 Fake-provider 演示不使用 ChatGPT plan。`,
      `Manage usage：${SIWC_USAGE_URL}`,
    ].join("\n");
  }
  const active = siwcAccountStatuses(store).find((account) => account.isActive);
  let status: string;
  if (!active || !active.signedIn) status = "SIWC plan 授权状态：未连接；此 Fake-provider 演示不使用 ChatGPT plan。";
  else if (!active.planUsageAuthorized) status = "SIWC plan 授权状态：当前账户未授予 plan-use scope；此 Fake-provider 演示不使用 ChatGPT plan。";
  else status = "SIWC plan 授权状态：活动账户已授予 plan-use scope；此 Fake-provider 演示仍只返回本地模拟结果，不消耗 ChatGPT plan。";
  return [status, `Manage usage：${SIWC_USAGE_URL}`].join("\n");
}
