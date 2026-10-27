# Minimal Agent：TypeScript + Hono

一个可直接运行的工具型 Agent API 示例。Hono 提供 HTTP 接口，模型通过 OpenAI 兼容的 Chat Completions API 响应；服务端只执行明确列入白名单的工具，不会把模型生成的代码当作程序运行。

## 功能

- `GET /health`：轻量健康检查，不调用模型。
- `POST /agent`：接收一条消息，返回 `{ "reply": "..." }`。
- `get_current_time`：按 IANA 时区读取当前时间，默认 UTC。
- `calculate`：安全计算四则运算和括号表达式；不使用 `eval` 或动态代码执行。
- 请求体限制为 16 KB，并对消息长度、模型等待时间、工具调用总数和模型往返轮数设置上限。
- 通过依赖注入隔离 HTTP 服务启动和 Agent 应用，方便用自动化测试验证错误路径与工具调用。
- `npm run inspect`：本地只读代码理解原型；在发送前预览完整请求并要求明确确认。

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

```bash
export OPENAI_API_KEY='your-api-key'
# 可选：OPENAI_BASE_URL（默认 https://api.openai.com/v1）和 OPENAI_MODEL（默认 gpt-4.1-mini）
npm run inspect -- "请说明 agent 请求从哪里进入，以及主要安全边界"
```

发送前 CLI 会显示实际服务目标、模型，以及包括系统指令、问题和逐行编号上下文在内的完整最终 JSON payload。默认取消；只有在交互终端明确输入 `yes` 才会发送，其他输入和非交互终端一律取消。确认后使用预览时冻结的同一请求体发送。API key 只在确认后读取，并仅放在 Authorization 请求头；它不会显示、写入 prompt 或用于上下文收集。CLI 不加载 `.env`。

上下文只来自常见的已跟踪路径（如 `src/`、`app/`、`lib/`、`test/` 和 `README*`），最多 6 个文件、单文件 16 KiB、合计 24 KiB。硬排除任意路径段中的 `.env*`、凭据/密钥目录、`.git`、依赖与构建目录、二进制/非 UTF-8/含终端控制字符文件、被有限启发式检测为可能含凭据的文件、符号链接及超大文件；不会读取被过滤文件内容。凭据检查只覆盖部分常见文本形式（例如简单的 `password = "..."`、`apiKey = "..."` 赋值和一些已知 token 外形），属于有限过滤，不是通用密钥识别器，也不能保证发现所有凭据。HTTP 服务目标只允许精确的 `localhost`、IPv4 回环地址（`127.0.0.0/8`）或 IPv6 `::1`；其他 HTTP 地址会被拒绝，远端服务必须使用 HTTPS。模型结果仅是带路径/行号的理解和最多三步短计划；CLI 会核对每条引用路径属于本次上下文且行号有效，无引用或引用无效时标为“未验证/未完成”并返回失败状态。模型建议的命令不会执行，文件不会修改，也不会 commit、push 或开 PR。

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
- `test/app.test.ts`：接口、工具和错误路径测试。
- `.env.example`：环境变量模板。

不要把 `.env`、API key 或其他凭据提交到 Git；仓库已忽略本地 `.env` 文件。
