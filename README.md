# Coda：TypeScript + Hono

[GitHub 仓库：Jackie733/coda](https://github.com/Jackie733/coda)

一个可直接运行的工具型 Agent API 示例。Hono 提供 HTTP 接口，模型通过 OpenAI 兼容的 Chat Completions API 响应；服务端只执行明确列入白名单的工具，不会把模型生成的代码当作程序运行。

## 功能

- `GET /health`：轻量健康检查，不调用模型。
- `POST /agent`：接收一条消息，返回 `{ "reply": "..." }`。
- `get_current_time`：按 IANA 时区读取当前时间，默认 UTC。
- `calculate`：安全计算四则运算和括号表达式；不使用 `eval` 或动态代码执行。
- 请求体限制为 16 KB，并对消息长度、模型等待时间、工具调用总数和模型往返轮数设置上限。
- 通过依赖注入隔离 HTTP 服务启动和 Agent 应用，方便用自动化测试验证错误路径与工具调用。
- `npm run inspect`：本地只读代码理解原型；在发送前预览完整请求并要求明确确认。
- `npm run siwc -- ...`：可选的本机 Sign in with ChatGPT（SIWC）身份/ChatGPT-plan provider；与 API-key 计费路径分开，不会互相兜底。

## 运行

需要 Node.js 20 或更新版本。

```bash
npm install
cp .env.example .env
```

编辑 `.env`，填入自己的 API key：

```dotenv
OPENAI_API_KEY=your-api-key
OPENAI_MODEL=gpt-4.1-mini
# 可选：兼容 OpenAI API 的服务地址，默认 https://api.openai.com/v1；仅 HTTPS，或 localhost/loopback IP 的 HTTP
# OPENAI_BASE_URL=https://api.openai.com/v1
PORT=3000
```

启动开发服务器：

```bash
npm run dev
```

## 本地只读代码理解 CLI（M0）

CLI 从当前目录识别 Git 仓库，显示仓库路径、分支和工作树是否有改动，然后只从 Git 已跟踪的常见源码目录、测试目录和根目录说明/清单中挑选有限上下文。上下文收集不递归扫描整个工作区，也不读取未跟踪文件内容、shell 历史或 `.env`；Git 状态摘要只用于判断是否有改动，不显示未跟踪路径名。它也不把本地仓库路径或认证密钥放进模型 payload。为识别仓库和工作树状态，它只运行固定的只读 Git 元数据/路径查询；不会运行仓库脚本或模型建议的命令。

## Fake-provider TUI（本地状态机演示）

```bash
npm run tui
```

该终端界面只演示 #8 的 provider-neutral 状态机：`I` 进入只读流程并键入任务，`P` 进入补丁流程并分别键入任务、计划和精确文件范围（逗号分隔仓库相对路径）。可用 Backspace/方向键编辑；patch 范围复核屏支持 `T` 修改任务、`2` 修改计划、`F` 修改文件，并须明确确认范围，再在完整请求预览中再次批准。`Esc`/`N`/返回键取消当前流程，补丁 diff 需先显示后才能选择保留或丢弃。默认 fake provider 只在本地返回确定性模拟结果，不联网、不检查/读取真实仓库，也不会写入文件；`TERM=dumb` 使用纯文本输入，非 TTY 会立即安全退出。这个演示不会替代 `inspect` 或 `patch` 的真实工具流程。

```bash
export OPENAI_API_KEY='your-api-key'
# 可选：OPENAI_BASE_URL（默认 https://api.openai.com/v1）和 OPENAI_MODEL（默认 gpt-4.1-mini）
npm run inspect -- "请说明 agent 请求从哪里进入，以及主要安全边界"
```

每次发送前 CLI 都会显示实际服务目标、模型，以及包括系统指令、问题和逐行编号上下文在内的完整最终 JSON payload。默认取消；只有在交互终端对该次请求明确输入 `yes` 才会发送，其他输入和非交互终端一律取消。确认后使用预览时冻结的同一请求体发送。API key 只在确认后读取，并仅放在 Authorization 请求头；它不会显示、写入 prompt 或用于上下文收集。CLI 不加载 `.env`。

上下文只来自常见的已跟踪路径（如 `src/`、`app/`、`lib/`、`test/` 和 `README*`），最多 6 个文件、单文件 16 KiB、合计 24 KiB。硬排除任意路径段中的 `.env*`、凭据/密钥目录、`.git`、依赖与构建目录、二进制/非 UTF-8/含终端控制字符文件、被有限启发式检测为可能含凭据的文件、符号链接及超大文件；不会读取被过滤文件内容。凭据检查会按变量名线索排除密码、secret、token 等赋值和带认证信息的常见数据库 URL，也会检查部分已知 token 外形；它属于有限启发式，不是通用密钥识别器，无法保证识别所有秘密或凭据。HTTP 服务目标只允许精确的 `localhost`、IPv4 回环地址（`127.0.0.0/8`）或 IPv6 `::1`；其他 HTTP 地址会被拒绝，远端服务必须使用 HTTPS。模型结果使用 `understanding[]` 和最多三项的 `plan[]` 结构，每个条目单独携带 `text` 和 `citations[]`；CLI 分别核对该条目的每条引用路径是否属于本次上下文、行号是否有效，缺失或无效时只把对应条目标为“未验证”，不会由其他条目的有效引用兜底。“已验证”只代表引用路径/行号结构有效，不证明引用在语义上支持该结论或计划。模型输出中的 ANSI/OSC/C0/C1 控制字符会转为可见文本后再显示。模型建议的命令不会执行，文件不会修改，也不会 commit、push 或开 PR。

## 本地隔离补丁 CLI（M1）

安全边界：linked worktree 只隔离候选补丁的工作目录，不是 OS/container 安全沙箱；MVP 不防同一 OS 用户下的恶意并发进程或 TOCTOU 竞态。详见[安全边界与威胁模型](SECURITY.md)。

补丁流程要求用户先给出具体计划和精确的仓库相对文件清单；重复 `--file` 可批准多个目标（最多 6 个）：

```bash
npm run patch -- --plan "修复 greeting 的输入校验" --file src/app.ts --file test/app.test.ts
```

CLI 先显示当前 `HEAD`、具体计划和精确文件范围；输入 `yes` 才批准在本地为这些文件生成候选补丁，此时尚未创建 worktree 或发送请求。之后 CLI 才创建隔离工作树、展示实际服务目标和完整最终 JSON 请求；用户再次输入 `yes` 才会原样发送一次请求。两步默认均取消，非交互终端不发送。API key 仅在第二次确认后读取。为避免混入个人本地改动，模型上下文和补丁均以 `HEAD` 为基准；源工作树的文件、index 以及 staged、unstaged 和 untracked 内容不会复制或改动。Git 会在仓库管理目录登记一个独立 linked worktree；临时工作目录只物化批准文件，请求也只包含这些文件的安全文本上下文。

模型只返回结构化文本替换（`oldText` / `newText`），每项必须带理由和引用；CLI 会拒绝不在白名单内的路径、遍历/绝对路径、符号链接、`.git`/秘密路径、重复或不唯一的文本匹配、无效引用、控制字符和疑似凭据。为避免 Git pathspec 将批准路径展开为模式，文件名仅支持 ASCII 字母/数字及 `.`、`_`、`-`、`+`、`@` 字符。CLI 先创建不检出内容的 detached Git linked worktree，再用固定 HEAD 初始化隔离 index，并只通过 `checkout-index` 物化批准的精确文件；不启用 sparse checkout，也不改写共享 `.git/config`。源工作树中的秘密或其他文件不会复制到临时目录。创建/检出期间会禁用仓库自定义 Git hooks 与 clean/smudge/process filters。补丁只写进该隔离工作树，不运行 shell、模型建议的命令、测试或仓库脚本，也不会提交、推送、创建 PR 或合并。应用后会显示隔离工作树相对基准的完整 diff，再由用户输入 `keep` 保留该工作树供检查，或输入 `discard` 丢弃；非交互模式默认丢弃。失败或取消时 CLI 不会声称补丁成功，并报告隔离工作树是否仍然存在，但父临时目录删除失败可能没有单独报告（见 [issue #6](https://github.com/Jackie733/coda/issues/6)）。保留结果只是本地未提交的候选补丁，不代表独立 QA 已通过。

## 可选 SIWC / ChatGPT plan provider（本机、明确授权）

该 provider 只供用户在本人本机运行的开源 Coda 使用；它不是通用代理，不用于共享、转让、轮换或代他人消耗计划额度，也没有 Coda paywall。付费或远程托管服务若要接入 SIWC，必须先取得 OpenAI 要求的批准。登录只会打开 OpenAI 官方 SIWC 授权流程；不要提供 ChatGPT 密码/cookie，也不会读取浏览器会话或 Codex 私有缓存。

```bash
# 只登录身份，不请求计划推理授权
npm run siwc -- login

# 明确请求 ChatGPT plan 用量；需要在 OpenAI 官方授权页同意
npm run siwc -- login --plan-usage

# 查看脱敏状态、当前账户模型，执行只读 inspect 或退出
npm run siwc -- status
npm run siwc -- models
npm run siwc -- inspect --model <从 models 返回的 slug> "请说明入口与安全边界"
npm run siwc -- logout
```

只有 `login --plan-usage` 才请求 `chatgpt.tokens.use.direct`（以及官方流程所需的资源/刷新 scopes）；身份登录或缺少实际授予的 plan-use scope 都不能发起计划推理。首次动态注册后，必须用授权回调签发的 client ID；多账户可用 `status` 查看并用 `select <issued-client-id>` 切换。注销后若本机仅有一个已保存账户，默认 `login` 会复用它；多账户且没有活动选择时，必须显式给出 `--client-id <issued-client-id>`，不会猜选账户。模型列表来自所选账户当前可见的官方 `/v1/models` 目录，交互终端可选择，非交互终端须显式传 `--model`。

`inspect` 会先按现有只读流程收集有限的已跟踪源码，展示最终 Responses JSON 和模型，然后要求逐次确认。隐私告知：这个 payload 包含你输入的任务/问题和所选仓库的有限已跟踪文本上下文；批准后由本机直接发送给 OpenAI 官方 Responses API，Coda 不接收或远端代理该请求。SIWC 凭据只保存在本机；access token 不放进 payload，只在批准后由本机放入直连 OpenAI 的 Authorization header。请求设为 `store:false`、`stream:true`，只有收到 `response.completed` 才算成功；不使用 ChatGPT 内部 backend API。SIWC 请求从不读取 API key、不走 Hono `/agent`，失败也不会切换 API-key provider。OpenAI API key 与 ChatGPT plan/credits 是两种独立计费方式。

每次请求预览都会显示“正在使用 ChatGPT 方案额度”、额度会被本次请求消耗且可能与其他已连接应用共享，并附 [Usage 管理入口](https://chatgpt.com/settings/usage)。首次为新账户或尚未获 plan-use scope 的账户运行 `login --plan-usage` 时显示欢迎说明；成功授权后，本机账户记录会保留该状态，注销后重登也不重复。身份-only `login` 会在打开授权页前说明 OAuth 返回的账户标识、可能的 email/name、scopes 与 token 如何在本机处理，且该步骤不发送任务/仓库文本；这些上下文只在后续单独预览并批准的推理请求中直发 OpenAI。遇到 usage-limit 时会停止 plan 请求并给出 Usage 入口；错误码不能区分 app 专属限制与共享 plan 限制，也不能推断重置时间，不会静默改用 API key。`status` 不展示 token；Unix 配置目录权限为 `0700`、凭据文件权限为 `0600`，支持 refresh-token 轮换与 logout 撤销。由于当前版本未验证 Windows owner-only ACL，SIWC 凭据读取/写入在 Windows 上会 fail closed（其他本机 CLI/TUI 功能不受影响）。CI 只使用 mock OAuth/token/model endpoints 和 synthetic repository/prompt；不会自动运行真实账户或模型 smoke。

## 调用示例

```bash
curl -X POST http://localhost:3000/agent \
  -H 'Content-Type: application/json' \
  -d '{"message":"现在台北几点？另外计算 (12 + 8) / 4。"}'
```

返回示例：

```json
{"reply":"台北现在是……；计算结果为 5。"}
```

## 资源限制

以下环境变量可选；缺失、非整数或超出范围时会使用默认值。

| 变量 | 默认值 | 允许范围 | 作用 |
| --- | ---: | ---: | --- |
| `MAX_AGENT_TURNS` | 4 | 1–12 | 一次请求中模型调用的最大轮数 |
| `MAX_TOOL_CALLS` | 8 | 1–32 | 一次请求中工具调用总数上限 |
| `MAX_MESSAGE_LENGTH` | 4000 | 1–16000 | 消息字符上限 |
| `OPENAI_TIMEOUT_MS` | 30000 | 1000–120000 | 单次模型请求超时毫秒数 |

请求体硬上限为 16 KB。输入错误返回 HTTP 400 或 413；未配置 API key 返回 503；模型提供方错误返回 502；模型请求超时返回 504。错误响应格式为 `{ "error": "..." }`，提供方 HTTP 错误会额外包含其状态码。

## 检查与测试

```bash
npm run check
npm test
```

测试使用 Node.js 内置测试框架和模拟模型响应，不需要真实 API key，也不会产生模型调用费用。

## 项目结构与安全

- `src/app.ts`：路由、输入校验、模型交互循环和白名单工具。
- `src/index.ts`：读取环境变量并启动 Node.js HTTP 服务。
- `src/siwc/` 与 `src/siwc-cli.ts`：本机 SIWC OAuth、凭据存储、计划用量 Responses provider 与显式命令入口。
- `test/app.test.ts`：接口、工具和错误路径测试。
- `SECURITY.md`：M0/M1 安全边界、威胁模型与同 UID 范围外说明。
- `.env.example`：环境变量模板。

不要把 `.env`、API key 或其他凭据提交到 Git；仓库已忽略本地 `.env` 文件。
