# Minimal Agent：TypeScript + Hono

一个尽量精简、可直接运行的工具型 Agent API 示例。服务用 Hono 提供 HTTP 接口，通过 OpenAI 兼容的 Chat Completions API 与模型交互；模型可以选择调用白名单工具 `get_current_time`，服务执行工具后再把结果交回模型。

## 运行

需要 Node.js 20 或更新版本。

```bash
npm install
cp .env.example .env
```

编辑 `.env`，填入你自己的 API key：

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

检查 TypeScript：

```bash
npm run check
```

## 调用示例

```bash
curl -X POST http://localhost:3000/agent \
  -H 'Content-Type: application/json' \
  -d '{"message":"现在香港几点？"}'
```

返回格式：

```json
{"reply":"……"}
```

`GET /health` 是不调用模型的健康检查接口。`POST /agent` 接收 `{"message":"..."}`；示例只提供当前时间工具，并限制工具调用次数和模型往返轮数。

## 结构

- `src/index.ts`：Hono 路由、模型调用和工具执行循环。
- `.env.example`：环境变量模板。
- `package.json`：运行与类型检查命令。

不要把 `.env`、API key 或其他凭据提交到 Git。仓库忽略了 `.env` 文件。
