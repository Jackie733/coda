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
    assert.ok(!snapshot.context.includes("hunter2"));
    assert.ok(!snapshot.context.includes("short-test-key"));
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
        return Response.json({ choices: [{ message: { role: "assistant", content: "理解：`src/main.ts:1-3` 提供问候函数。\n计划：核对调用方，然后检查测试。" } }] });
      },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCount, 1);
    assert.equal(sentUrl, "https://mock.example/v1/chat/completions");
    assert.ok(output.text.includes(sentBody), "the exact body string must have been previewed");
    const sentPayload = JSON.parse(sentBody) as { model: string; messages: Array<{ role: string; content: string }> };
    assert.equal(sentPayload.model, "synthetic-model");
    assert.ok(sentPayload.messages[1].content.includes("fixture-only"));
    assert.ok(sentPayload.messages[1].content.includes("src/main.ts"));
    assert.ok(!sentPayload.messages[1].content.includes("never-include-this"));
    assert.ok(!sentBody.includes(key), "credentials must never appear in the payload");
    assert.match(output.text, /src\/main\.ts:1-3/);
    assert.match(output.text, /不会编辑文件/);
  });
});

test("model answers without citations or with out-of-context citations are marked unverified", async () => {
  await withRepository(async (root) => {
    for (const content of [
      "理解：代码提供问候函数。计划：检查调用者。",
      "理解：代码提供问候函数。依据 `src/not-in-context.ts:1`。",
      "理解：代码提供问候函数。依据 `src/main.ts:99`。",
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
      assert.match(output.text, /未验证的模型文本/);
    }
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
