# Minimal Agent：TypeScript + Hono

一个可直接运行的工具型 Agent API 示例。Hono 提供 HTTP 接口，模型通过 OpenAI 兼容的 Chat Completions API 响应；服务端只执行明确列入白名单的工具，不会把模型生成的代码当作程序运行。

## 功能

- `GET /health`：轻量健康检查，不调用模型。
- `POST /agent`：接收一条消息，返回 `{ "reply": "..." }`。
- `get_current_time`：按 IANA 时区读取当前时间，默认 UTC。
- `calculate`：安全计算四则运算和括号表达式；不使用 `eval` 或动态代码执行。
- 请求体限制为 16 KB，并对消息长度、模型等待时间、工具调用总数和模型往返轮数设置上限。
- 通过依赖注入隔离 HTTP 服务启动和 Agent 应用，方便用自动化测试验证错误路径与工具调用。

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
# 可选：兼容 OpenAI API 的服务地址，默认 https://api.openai.com/v1
# OPENAI_BASE_URL=https://api.openai.com/v1
PORT=3000
```

启动开发服务器：

```bash
npm run dev
```

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
