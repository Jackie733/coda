# 安全边界与威胁模型

本文说明 Coda 当前本地 coding-agent CLI（M0 `inspect`、M1 `patch`）的安全目标和明确边界。它不是完整安全审计，也不是对所有本机攻击的防护承诺。

## 产品与权限模型

M0/M1 在用户启动它的本机进程中运行，并继承该操作系统账户可访问的权限。模型服务只会在用户逐次批准后收到预览中的请求；Coda 不向模型 endpoint 提供文件系统或命令工具。当前 CLI 不执行模型建议的 shell 命令、测试或仓库脚本。

M0 从 Git 跟踪的有限路径收集有限文本，并尽力过滤疑似凭据；用户在每次请求前可查看完整 payload 并取消。过滤规则是启发式，不能保证识别所有秘密。payload 中的代码、注释、README、模型回复和引用均应视为不可信数据；引用路径/行号校验只检查结构，不证明结论在语义上正确。

M1 先要求用户批准具体计划和精确文件范围，再单独批准最终模型请求。它基于固定 `HEAD` 在临时 linked worktree 中只物化已批准文件，生成候选补丁；用户查看完整 diff 后选择保留或丢弃。标准流程不把源工作树的 staged、unstaged 或 untracked 内容作为 M1 上下文，也不提交、推送、开 PR 或合并。Git 会在仓库管理目录登记 linked worktree。当前实现会报告 linked worktree 是否仍存在；但 Git 已移除 worktree 后，父临时目录删除失败可能没有单独报出，详见 [issue #6](https://github.com/Jackie733/coda/issues/6)。

### 可选 SIWC / ChatGPT plan provider（issue #10）

SIWC 是仅供用户在本人本机运行的开源 Coda 使用的可选 provider，不是一般用途的 API 代理，也不允许共享/转让/轮换订阅、为其他人转发请求或汇聚多个账户。该功能没有 Coda paywall；任何付费或远程托管版本必须先满足 OpenAI 的 SIWC 审批要求。授权只能通过 OpenAI 官方 Sign in with ChatGPT 流程取得；禁止索取 ChatGPT 密码/cookie、读取浏览器会话或使用 Codex 私有凭据缓存。

身份登录与计划推理授权分开。identity-only OAuth 在打开授权页前说明会处理 OpenAI 返回的账户标识、可选 email/name、授权 scopes 与令牌；凭据仅保存在本机，身份登录本身不会发送任务或仓库上下文，后者只会在之后单独预览并获用户批准的推理中直发 OpenAI。只有用户明确运行 `npm run siwc -- login --plan-usage` 并在官方页面同意、且返回的实际授权 scope 包含 `chatgpt.tokens.use.direct` 与 `resource.invoke`，本机才允许发起计划请求。首次启用时显示一次 plan-use 欢迎说明，并把已展示状态留在本机账户记录中；后续重登（包括 logout 后）不重复欢迎。每次模型请求仍有独立预览/确认门，持续显示正在使用 ChatGPT 方案额度和官方 Usage 链接；API-key 与 SIWC provider 的 endpoint、凭据与计费描述互不混用。

SIWC 凭据只存于用户选择的本机 XDG 配置路径下，Unix 配置目录为 `0700`、凭据文件为 `0600`，通过临时文件原子替换并以本机文件锁串行化写入/刷新。rename 是写入 commit 点：temp fsync/rename 失败时旧文件保持；rename 成功后若 directory fsync 失败，则以专用 `CredentialDurabilityUncertainError` 明确说明新文件内容已替换但崩溃持久性未确认，要求检查 `siwc status`，不声称旧凭据仍在。此状态下 provider 停止本次推理，且不输出底层异常或 token。当前版本尚未验证 Windows owner-only ACL，因此在 Windows 上对 SIWC 凭据的读写会 fail closed，不会读取或写入 token。存储包含 issued client ID、subject、ID/access/refresh token 与真实授予的 scopes；CLI/TUI 只显示脱敏状态，不把令牌放入模型 payload、Hono 请求、提示、日志或 diff。按 OpenAI 合约，ID token 仅可作为 `id_token_hint` 送往官方授权 endpoint；access/refresh token 不进入 URL。logout 会按 OIDC discovery 的 revocation endpoint 撤销 refresh token，并无论远端撤销是否可确认都清除本机 token。

隐私/数据处理告知：获准的 Responses payload 包含用户输入的任务/问题和本次选中的有限 Git 跟踪仓库文本上下文；这些内容由用户本机直接发送到 OpenAI 官方 Responses API。SIWC 凭据仅保存在本机；access token 只经 Authorization header 直连 OpenAI，Coda 不接收、不存储，也不通过 Coda 远端服务代理请求。用户可在预览时检查完整 payload 并取消。

计划推理只访问公开的 Responses API 与当前账户的公开模型目录；不调用 ChatGPT 内部 backend endpoint。每个 Responses 请求设置 `store:false`、`stream:true`，只在 `response.completed` 后报告成功；usage-limit、`response.incomplete`、失败事件、断流或非成功 HTTP 状态都不算成功。usage-limit code 不能区分是 ChatGPT plan 共享额度还是 app-specific limit，也不能说明重置时间；停止 plan 请求并引导用户检查官方 Usage 页面，不推断整个 plan 已耗尽或 reset。计划额度可能与其他已连接应用共享，CLI/TUI 显示官方 Usage 管理链接。CI 的 OAuth、token、模型目录和 SSE 全部通过 mock 与 synthetic 数据测试，真实 provider smoke 不自动运行。

## 需要保护的资产

- 源工作树中的文件、HEAD、index，以及用户的 staged、unstaged、untracked 改动。
- 不应发送给模型服务的本地秘密、凭据和无关仓库内容。
- 用户在预览中批准的具体请求、批准计划和文件范围，以及对候选补丁的最终处置选择。
- 用户本机上其账户可访问的其他文件、进程和凭据。

## 信任假设与威胁范围

Coda 信任用户明确执行的本地程序、Git/操作系统和用户选择的模型服务按其公开接口运行。仓库内容和模型输出不被视作指令；它们不能授权 Coda 执行命令或扩大批准的文件范围。

M0/M1 的目标是减少无意数据外发和误写风险：限制发送内容、在发送前展示并征求同意；不执行模型生成命令；把候选文本补丁限制在独立的临时 linked worktree，并展示完整 diff 后再由用户决定保留或丢弃。

## 明确不防护的情况

**MVP 不防御同一 OS UID（同一操作系统用户）下恶意或被攻陷的并发进程。**这类进程与 Coda 共享该用户可访问的权限，可能读取或改写本地文件、进程资源和 Git 可访问数据，也可能在检查与使用之间竞态替换文件。Coda 不声称已解决或防止此类 TOCTOU 问题。

**Linked worktree 不是 OS/container 安全沙箱。**它为候选补丁提供独立工作目录和 index，但不隔离同 UID 进程，也不限制进程、网络、资源、凭据或文件访问。它也不会阻止用户或其他有权限的本地进程访问源仓库和临时目录。M1 当前不运行任意命令/测试，因此 worktree 不应被描述为安全地执行不可信代码的环境。

同 UID 恶意并发进程、系统级入侵、恶意或被攻陷的 Git/操作系统/依赖、模型服务自身的数据处理，以及所有潜在秘密识别绕过，均不在当前 MVP 的防护保证内。若产品将来需要防护不可信本地进程，必须另行设计并评估 OS/container 级隔离；不能仅依赖 linked worktree、提示词、应用层检查或审批弹窗。

## 用户应注意

- 发出请求前检查实际 endpoint、模型和完整 payload；秘密过滤只是尽力而为。
- 只批准自己愿意发送给所选模型服务的上下文。该服务的数据留存与处理按其适用条款执行。
- 审阅完整补丁 diff；`keep` 只保留本地未提交的候选工作树，不等于测试通过或独立 QA 验收。
- 遇到清理错误或 CLI 报告仍有 linked worktree 时，按显示的路径检查并手动处理残留；在 issue #6 完成前，“linked worktree 已移除”不保证父临时目录也已删除。

## 报告安全问题

若仓库启用了 GitHub 私密漏洞报告，请通过该渠道提交可复现的安全问题；否则先联系仓库维护者。不要在公开 issue 中粘贴真实凭据、私有仓库代码或用户数据。
