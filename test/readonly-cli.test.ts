import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { inspectRepository } from "../src/repo-context.js";
import { endpointFrom, runReadonlyCli } from "../src/readonly-cli.js";

async function createSyntheticRepository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "readonly-cli-fixture-"));
  const runGit = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  runGit("init", "-b", "fixture-main");
  runGit("config", "user.email", "fixture@example.invalid");
  runGit("config", "user.name", "Synthetic Fixture");

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "src", ".env-cache"), { recursive: true });
  await mkdir(path.join(root, "src", ".aws"), { recursive: true });
  await mkdir(path.join(root, "src", "nested-safe"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });
  await mkdir(path.join(root, "node_modules", "fake"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "# Synthetic fixture\nFixture-only documentation.\n");
  await writeFile(path.join(root, "package.json"), '{"name":"fixture-only"}\n');
  await writeFile(path.join(root, "src", "main.ts"), "export function greeting() {\n  return 'fixture-only';\n}\n");
  await writeFile(path.join(root, "src", "config.ts"), 'const password = "hunter2";\nexport const apiKey = "short-test-key";\n');
  await writeFile(path.join(root, "src", "credential-assignments.ts"), 'const refreshToken = "fixture-refresh-token";\nconst clientSecret = "fixture-client-secret";\nconst DB_PASSWORD = "fixture-db-password";\n');
  await writeFile(path.join(root, "src", "credential-database-url.ts"), 'const DATABASE_URL = "postgresql://fixture_user:fixture_pass@db.example.invalid:5432/app";\n');
  await writeFile(path.join(root, "src", ".env-cache", "leak.ts"), "export const hidden = 'env-directory-secret';\n");
  await writeFile(path.join(root, "src", ".aws", "credentials.ts"), "export const hidden = 'credential-directory-secret';\n");
  await writeFile(path.join(root, "src", "nested-safe", "child.ts"), "export const nested = 'in-repo-before-link';\n");
  await writeFile(path.join(root, "test", "main.test.ts"), "// synthetic test fixture\n");
  await writeFile(path.join(root, ".env.local"), "SYNTHETIC_FIXTURE_SECRET=never-include-this\n");
  await writeFile(path.join(root, "secrets", "credential.ts"), "export const secret = 'never-include-this';\n");
  await writeFile(path.join(root, "node_modules", "fake", "index.ts"), "export const dependency = true;\n");
  await writeFile(path.join(root, "dist", "built.ts"), "export const built = true;\n");
  await writeFile(path.join(root, "src", "binary.ts"), Buffer.from([0x00, 0x01, 0x02]));
  await writeFile(path.join(root, "src", "oversized.ts"), "x".repeat(16 * 1024 + 1));

  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
  await writeFile(outside, "export const outsideSecret = 'must-not-be-read';\n");
  const outsideDirectory = path.join(path.dirname(root), `${path.basename(root)}-outside-directory`);
  await mkdir(outsideDirectory, { recursive: true });
  await writeFile(path.join(outsideDirectory, "child.ts"), "export const outsideNested = 'must-not-be-read-either';\n");
  await symlink(outside, path.join(root, "src", "outside-link.ts"));

  runGit("add", "-A");
  runGit("commit", "-m", "synthetic fixture");
  return root;
}

async function withRepository<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await createSyntheticRepository();
  try {
    return await callback(root);
  } finally {
    const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
    const outsideDirectory = path.join(path.dirname(root), `${path.basename(root)}-outside-directory`);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
    await rm(outsideDirectory, { recursive: true, force: true });
  }
}

function captureOutput() {
  let value = "";
  return {
    writer: { write: (chunk: string | Uint8Array) => { value += String(chunk); return true; } },
    get text() { return value; },
  };
}

test("model endpoint preview uses a normalized URL and rejects unsafe destinations", () => {
  assert.equal(endpointFrom("https://MOCK.example:443/v1/"), "https://mock.example/v1/chat/completions");
  assert.equal(endpointFrom("http://localhost:8080/v1"), "http://localhost:8080/v1/chat/completions");
  assert.equal(endpointFrom("http://127.0.0.1:8080/v1"), "http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(endpointFrom("http://127.42.0.9/v1"), "http://127.42.0.9/v1/chat/completions");
  assert.equal(endpointFrom("http://[::1]:8080/v1"), "http://[::1]:8080/v1/chat/completions");
  for (const baseUrl of [
    "http://model.example/v1",
    "http://192.168.1.10/v1",
    "http://localhost.example/v1",
    "https://mock.example/v1/../admin",
    "https://mock.example/%2e%2e/admin",
    "https://mock.example/v1?route=other",
    "https://mock.example/v1#fragment",
    "https://user:password@mock.example/v1",
    "file:///tmp/model",
  ]) {
    assert.throws(() => endpointFrom(baseUrl), undefined, baseUrl);
  }
});

test("repository inspection reports Git metadata and only bounded safe tracked text", async () => {
  await withRepository(async (root) => {
    const snapshot = await inspectRepository(root);
    assert.equal(snapshot.root, await realpath(root));
    assert.equal(snapshot.branch, "fixture-main");
    assert.equal(snapshot.worktree, "clean");
    assert.ok(snapshot.context.includes('File "src/main.ts"'));
    assert.ok(snapshot.context.includes("1 | export function greeting()"));
    const mainBlock = snapshot.context.match(/File "src\/main\.ts"\n([\s\S]*?)(?:\n\n|$)/)?.[1] ?? "";
    assert.ok(mainBlock.includes("3 | }"));
    assert.ok(!mainBlock.includes("4 |"));
    assert.ok(snapshot.context.includes('File "README.md"'));
    assert.ok(!snapshot.context.includes("never-include-this"));
    assert.ok(!snapshot.context.includes("env-directory-secret"));
    assert.ok(!snapshot.context.includes("credential-directory-secret"));
    assert.ok(!snapshot.includedFiles.includes("src/config.ts"));
    assert.ok(!snapshot.includedFiles.includes("src/credential-assignments.ts"));
    assert.ok(!snapshot.includedFiles.includes("src/credential-database-url.ts"));
    assert.ok(!snapshot.context.includes("hunter2"));
    assert.ok(!snapshot.context.includes("short-test-key"));
    assert.ok(!snapshot.context.includes("fixture-refresh-token"));
    assert.ok(!snapshot.context.includes("fixture-client-secret"));
    assert.ok(!snapshot.context.includes("fixture-db-password"));
    assert.ok(!snapshot.context.includes("fixture_user:fixture_pass"));
    assert.ok(!snapshot.context.includes("outsideSecret"));
    assert.ok(!snapshot.context.includes("dependency"));
    assert.ok(!snapshot.context.includes("built"));
    assert.ok(!snapshot.context.includes("binary.ts"));
    assert.ok(!snapshot.context.includes("oversized.ts"));
    assert.ok(!snapshot.context.includes("outside-link.ts"));
    assert.ok(snapshot.contextBytes <= 24 * 1024);
    assert.ok(snapshot.includedFiles.length <= 6);

    const outsideDirectory = path.join(path.dirname(root), `${path.basename(root)}-outside-directory`);
    await rm(path.join(root, "src", "nested-safe"), { recursive: true, force: true });
    await symlink(outsideDirectory, path.join(root, "src", "nested-safe"), "dir");
    const parentLinkSnapshot = await inspectRepository(root);
    assert.ok(!parentLinkSnapshot.context.includes("outsideNested"));

    await writeFile(path.join(root, "src", "untracked.ts"), "export const untracked = 'must-not-be-read';\n");
    const untrackedSnapshot = await inspectRepository(root);
    assert.equal(untrackedSnapshot.worktree, "dirty");
    assert.ok(!untrackedSnapshot.context.includes("must-not-be-read"));

    await writeFile(path.join(root, "src", "main.ts"), "export function edited() { return true; }\n");
    const dirtySnapshot = await inspectRepository(root);
    assert.equal(dirtySnapshot.worktree, "dirty");
  });
});

test("default cancellation makes zero fetch calls and does not read the API key", async () => {
  await withRepository(async (root) => {
    let fetchCount = 0;
    let keyRead = false;
    const env = {
      OPENAI_MODEL: "mock-model",
      OPENAI_BASE_URL: "https://mock.example/v1",
      get OPENAI_API_KEY() {
        keyRead = true;
        throw new Error("API key must not be read before consent");
      },
    };
    const output = captureOutput();
    const exitCode = await runReadonlyCli({
      cwd: root,
      env,
      stdout: output.writer,
      confirmSend: async () => false,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("mock fetch must not be called");
      },
      question: "Explain the synthetic fixture",
    });
    assert.equal(exitCode, 0);
    assert.equal(fetchCount, 0);
    assert.equal(keyRead, false);
    assert.match(output.text, /https:\/\/mock\.example\/v1\/chat\/completions/);
    assert.match(output.text, /mock-model/);
    assert.match(output.text, /src\/main\.ts/);
    assert.match(output.text, /已取消；没有发起网络请求/);
  });
});

test("explicit consent sends exactly the complete immutable payload shown in preview", async () => {
  await withRepository(async (root) => {
    const output = captureOutput();
    let fetchCount = 0;
    let sentUrl = "";
    let sentBody = "";
    const key = "mock-only-auth-value";
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: {
        OPENAI_API_KEY: key,
        OPENAI_MODEL: "synthetic-model",
        OPENAI_BASE_URL: "https://mock.example/v1/",
      },
      stdout: output.writer,
      confirmSend: async () => true,
      question: "Explain only the synthetic source",
      fetchImpl: async (input, init) => {
        fetchCount += 1;
        sentUrl = String(input);
        sentBody = String(init?.body);
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${key}`);
        return Response.json({ choices: [{ message: { role: "assistant", content: JSON.stringify({
          understanding: [{ text: "提供问候函数。", citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] }],
          plan: [{ text: "核对调用方。", citations: [{ path: "README.md", startLine: 1, endLine: 2 }] }],
        }) } }] });
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCount, 1);
    assert.equal(sentUrl, "https://mock.example/v1/chat/completions");
    assert.ok(output.text.includes(sentBody), "the exact body string must have been previewed");
    const sentPayload = JSON.parse(sentBody) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
      response_format: { type: string; json_schema: { name: string; strict: boolean } };
    };
    assert.equal(sentPayload.model, "synthetic-model");
    assert.equal(sentPayload.response_format.type, "json_schema");
    assert.equal(sentPayload.response_format.json_schema.name, "readonly_code_understanding");
    assert.equal(sentPayload.response_format.json_schema.strict, true);
    assert.ok(sentPayload.messages[1].content.includes("fixture-only"));
    assert.ok(sentPayload.messages[1].content.includes("src/main.ts"));
    assert.ok(!sentPayload.messages[1].content.includes("never-include-this"));
    assert.ok(!sentBody.includes(key), "credentials must never appear in the payload");
    assert.match(output.text, /src\/main\.ts:1-3/);
    assert.match(output.text, /理解：\n1\. 已验证（引用结构）/);
    assert.match(output.text, /计划：\n1\. 已验证（引用结构）/);
    assert.match(output.text, /不证明引用在语义上支持该条目/);
    assert.match(output.text, /不会编辑文件/);
  });
});

test("inspect CLI accepts a replacement provider without changing approval or payload preview policy", async () => {
  await withRepository(async (root) => {
    const output = captureOutput();
    let providerCalls = 0;
    let deliveredRequest: { endpoint: string; serializedBody: string } | undefined;
    const responseContent = JSON.stringify({
      understanding: [{ text: "提供问候函数。", citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] }],
      plan: [{ text: "核对 README。", citations: [{ path: "README.md", startLine: 1, endLine: 2 }] }],
    });
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: { OPENAI_MODEL: "replacement-model", OPENAI_BASE_URL: "https://provider.example/v1" },
      stdout: output.writer,
      confirmSend: async () => true,
      provider: {
        send: async (request) => {
          providerCalls += 1;
          deliveredRequest = request;
          return Response.json({ choices: [{ message: { role: "assistant", content: responseContent } }] });
        },
      },
      fetchImpl: async () => { throw new Error("the OpenAI-compatible adapter must not be called"); },
    });

    assert.equal(exitCode, 0);
    assert.equal(providerCalls, 1);
    assert.equal(deliveredRequest?.endpoint, "https://provider.example/v1/chat/completions");
    assert.ok(output.text.includes(deliveredRequest?.serializedBody ?? ""));
    assert.match(output.text, /已验证（引用结构）/);
  });
});

test("unstructured model responses are marked unverified", async () => {
  await withRepository(async (root) => {
    for (const content of [
      "理解：代码提供问候函数。计划：检查调用者。",
      JSON.stringify({ understanding: [{ text: "缺少计划数组", citations: [] }] }),
    ]) {
      const output = captureOutput();
      const exitCode = await runReadonlyCli({
        cwd: root,
        env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
        stdout: output.writer,
        confirmSend: async () => true,
        fetchImpl: async () => Response.json({ choices: [{ message: { role: "assistant", content } }] }),
      });

      assert.equal(exitCode, 1, content);
      assert.match(output.text, /回答未验证\/未完成/);
      assert.doesNotMatch(output.text, /引用路径和行号已核对/);
      assert.doesNotMatch(output.text, /模型理解与短计划/);
      assert.match(output.text, /未验证的模型输出/);
    }
  });
});

test("each non-empty understanding and plan item is validated only against its own citations", async () => {
  await withRepository(async (root) => {
    const output = captureOutput();
    const content = JSON.stringify({
      understanding: [
        { text: "有效的独立理解条目。", citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] },
        { text: "没有引用的理解条目。", citations: [] },
        { text: "引用未包含文件。", citations: [{ path: "src/not-in-context.ts", startLine: 1, endLine: 1 }] },
        { text: "引用字段缺失的理解条目。" },
      ],
      plan: [
        { text: "有效计划条目。", citations: [{ path: "README.md", startLine: 1, endLine: 2 }] },
        { text: "行号越界的计划条目。", citations: [{ path: "src/main.ts", startLine: 99, endLine: 99 }] },
        { text: "第三步。", citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] },
        { text: "超出三步限制的条目。", citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] },
      ],
    });
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: output.writer,
      confirmSend: async () => true,
      fetchImpl: async () => Response.json({ choices: [{ message: { role: "assistant", content } }] }),
    });

    assert.equal(exitCode, 1);
    assert.match(output.text, /1\. 已验证（引用结构）：有效的独立理解条目/);
    assert.match(output.text, /2\. 未验证：没有引用的理解条目/);
    assert.match(output.text, /3\. 未验证：引用未包含文件/);
    assert.match(output.text, /4\. 未验证：引用字段缺失的理解条目/);
    assert.match(output.text, /1\. 已验证（引用结构）：有效计划条目/);
    assert.match(output.text, /2\. 未验证：行号越界的计划条目/);
    assert.match(output.text, /4\. 未验证：超出三步限制的条目/);
    assert.match(output.text, /没有提供来源引用/);
    assert.match(output.text, /缺少 citations 引用数组/);
    assert.match(output.text, /文件不在本次上下文中/);
    assert.match(output.text, /行号不在本次上下文范围内/);
  });
});

test("model ANSI, OSC, C0, and C1 controls are rendered as visible escapes", async () => {
  await withRepository(async (root) => {
    const output = captureOutput();
    const text = "ANSI \u001b[31mred\u001b[0m OSC \u001b]8;;https://example.invalid\u0007link\u001b]8;;\u001b\\ C1 \u009b31m C0 \u0000";
    const content = JSON.stringify({
      understanding: [{ text, citations: [{ path: "src/main.ts", startLine: 1, endLine: 3 }] }],
      plan: [{ text: "检查调用方。", citations: [{ path: "README.md", startLine: 1, endLine: 2 }] }],
    });
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: output.writer,
      confirmSend: async () => true,
      fetchImpl: async () => Response.json({ choices: [{ message: { role: "assistant", content } }] }),
    });

    assert.equal(exitCode, 0);
    assert.match(output.text, /\\x1B\[31mred\\x1B\[0m/);
    assert.match(output.text, /\\x1B\]8;;https:\/\/example\.invalid\\x07link/);
    assert.match(output.text, /\\x9B31m/);
    assert.match(output.text, /\\x00/);
    assert.doesNotMatch(output.text, /\u001b|\u009b|\u0000|\u0007/);
  });
});

test("remote HTTP endpoint is rejected before consent or any network request", async () => {
  await withRepository(async (root) => {
    let fetchCount = 0;
    const output = captureOutput();
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: { OPENAI_API_KEY: "must-not-be-read", OPENAI_BASE_URL: "http://model.example/v1" },
      stdout: output.writer,
      confirmSend: async () => { throw new Error("consent must not be requested for an invalid destination"); },
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not send to a remote HTTP endpoint");
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(fetchCount, 0);
    assert.match(output.text, /服务目标配置无效/);
    assert.doesNotMatch(output.text, /Bearer|must-not-be-read/);
  });
});

test("non-interactive default confirmation cancels instead of sending", async () => {
  await withRepository(async (root) => {
    const output = captureOutput();
    let fetchCount = 0;
    const exitCode = await runReadonlyCli({
      cwd: root,
      env: { OPENAI_API_KEY: "mock-only-key" },
      stdout: output.writer,
      stdin: Object.assign(new PassThrough(), { isTTY: false }),
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("must not send");
      },
    });
    assert.equal(exitCode, 0);
    assert.equal(fetchCount, 0);
    assert.match(output.text, /默认取消/);
    assert.match(output.text, /已取消；没有发起网络请求/);
  });
});
