import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, readlink, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePatchArguments, renderDiffForTerminal, runPatchCli } from "../src/patch-cli.js";

type Fixture = Readonly<{ root: string; outsideFile: string; existingWorktreePath: string; commandMarkers: readonly string[] }>;

function git(root: string, ...args: string[]): Buffer {
  return execFileSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "filter.fixture-marker.clean=",
    "-c", "filter.fixture-marker.smudge=",
    "-c", "filter.fixture-marker.process=",
    "-c", "filter.fixture-marker.required=false",
    ...args,
  ], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    },
  });
}

function setLocalGitConfig(root: string, key: string, value: string): void {
  execFileSync("git", ["config", "--local", key, value], { cwd: root, stdio: "ignore" });
}

async function createDirtyRepository(options: Readonly<{ worktreeConfig?: "unset" | "true" }> = {}): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "patch-cli-fixture-"));
  const existingWorktreePath = `${root}-existing-worktree`;
  const runGit = (...args: string[]) => git(root, ...args);
  runGit("init", "-b", "fixture-main");
  setLocalGitConfig(root, "user.email", "fixture@example.invalid");
  setLocalGitConfig(root, "user.name", "Synthetic Fixture");
  setLocalGitConfig(root, "core.autocrlf", "false");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "secrets"), { recursive: true });
  const outsideFile = `${root}-outside.ts`;
  const smudgeMarker = `${root}-smudge-ran`;
  const cleanMarker = `${root}-clean-ran`;
  const processMarker = `${root}-process-ran`;
  const hookMarker = `${root}-hook-ran`;
  const hooksDirectory = path.join(root, "fixture-hooks");
  await writeFile(outsideFile, "export const outside = 'never-read';\n");
  await mkdir(hooksDirectory, { recursive: true });
  await writeFile(path.join(root, "src", "main.ts"), 'export function greeting() {\n  return "before";\n}\n');
  await writeFile(path.join(root, "src", "whitespace.ts"), 'export function whitespace() {\r\n\treturn "before";\r\n}\r\n');
  await writeFile(path.join(root, ".gitattributes"), "src/main.ts filter=fixture-marker\n");
  const postCheckout = path.join(hooksDirectory, "post-checkout");
  await writeFile(postCheckout, `#!/bin/sh\nprintf executed > "${hookMarker}"\n`);
  await chmod(postCheckout, 0o755);
  await writeFile(path.join(root, "src", "outside-link.ts"), "export const linked = false;\n");
  await rm(path.join(root, "src", "outside-link.ts"));
  await symlink(outsideFile, path.join(root, "src", "outside-link.ts"));
  await writeFile(path.join(root, "README.md"), "# Fixture\nBaseline README.\n");
  await writeFile(path.join(root, ".env.local"), "FIXTURE_SECRET=never-include-this\n");
  await writeFile(path.join(root, "secrets", "token.ts"), "export const secret = 'never-include-this-either';\n");
  runGit("add", "-A");
  runGit("commit", "-m", "synthetic fixture");
  if (options.worktreeConfig === "true") setLocalGitConfig(root, "extensions.worktreeConfig", "true");
  runGit("worktree", "add", "--no-checkout", "--detach", existingWorktreePath, "HEAD");
  setLocalGitConfig(root, "filter.fixture-marker.clean", `touch ${cleanMarker}`);
  setLocalGitConfig(root, "filter.fixture-marker.smudge", `touch ${smudgeMarker}`);
  setLocalGitConfig(root, "filter.fixture-marker.process", `touch ${processMarker}`);
  setLocalGitConfig(root, "core.hooksPath", hooksDirectory);

  // Deliberately preserve all three source-worktree states while the tool bases its new worktree on HEAD.
  await writeFile(path.join(root, "src", "main.ts"), 'export function greeting() {\n  return "user unstaged change";\n}\n');
  await writeFile(path.join(root, "README.md"), "# Fixture\nUser staged change.\n");
  runGit("add", "README.md");
  await writeFile(path.join(root, "local-notes.txt"), "Untracked local note: do not copy.\n");
  return { root, outsideFile, existingWorktreePath, commandMarkers: [cleanMarker, smudgeMarker, processMarker, hookMarker] };
}

async function withDirtyRepository<T>(callback: (fixture: Fixture) => Promise<T>, options: Readonly<{ worktreeConfig?: "unset" | "true" }> = {}): Promise<T> {
  const fixture = await createDirtyRepository(options);
  try {
    const result = await callback(fixture);
    for (const marker of fixture.commandMarkers) {
      await assert.rejects(
        readFile(marker),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
        `Git filter or hook unexpectedly ran and created ${marker}`,
      );
    }
    return result;
  } finally {
    try {
      const listing = git(fixture.root, "worktree", "list", "--porcelain").toString("utf8");
      for (const line of listing.split("\n")) {
        if (!line.startsWith("worktree ")) continue;
        const worktree = line.slice("worktree ".length);
        if (worktree === fixture.root) continue;
        try {
          git(fixture.root, "worktree", "remove", "--force", worktree);
        } catch {
          // Fixture cleanup is best effort; production cleanup behavior is asserted by each test.
        }
        if (worktree === fixture.existingWorktreePath) {
          await rm(worktree, { recursive: true, force: true });
        } else if (path.basename(path.dirname(worktree)).startsWith("cue-agent-patch-")) {
          await rm(path.dirname(worktree), { recursive: true, force: true });
        }
      }
    } catch {
      // The fixture may not have reached a valid Git repository.
    }
    await rm(fixture.root, { recursive: true, force: true });
    await rm(fixture.existingWorktreePath, { recursive: true, force: true });
    await rm(fixture.outsideFile, { force: true });
    for (const marker of fixture.commandMarkers) await rm(marker, { force: true });
  }
}

function optionalLocalGitConfig(root: string, key: string): string {
  try {
    return git(root, "config", "--local", "--get", key).toString("utf8").trim();
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1) return "UNSET";
    throw error;
  }
}

async function gitWorktreeRegistryState(root: string): Promise<Readonly<Record<string, string>>> {
  const commonDirectory = path.resolve(root, git(root, "rev-parse", "--git-common-dir").toString("utf8").trim());
  const registryDirectory = path.join(commonDirectory, "worktrees");
  const result: Record<string, string> = {};
  async function collect(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await collect(absolutePath, relativePath);
      else if (entry.isFile()) result[relativePath] = (await readFile(absolutePath)).toString("hex");
      else if (entry.isSymbolicLink()) result[relativePath] = `symlink:${await readlink(absolutePath)}`;
    }
  }
  await collect(registryDirectory, "");
  return result;
}

function assertRegistryEntriesUnchanged(before: Readonly<Record<string, string>>, after: Readonly<Record<string, string>>): void {
  for (const [entry, bytes] of Object.entries(before)) {
    assert.equal(after[entry], bytes, `pre-existing linked-worktree registry entry changed: ${entry}`);
  }
}

async function snapshotRepositoryFiles(root: string): Promise<Readonly<Record<string, string>>> {
  const result: Record<string, string> = {};
  async function collect(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!relativeDirectory && entry.name === ".git") continue;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await collect(absolutePath, relativePath);
      else if (entry.isFile()) result[relativePath] = (await readFile(absolutePath)).toString("hex");
      else if (entry.isSymbolicLink()) result[relativePath] = `symlink:${await readlink(absolutePath)}`;
    }
  }
  await collect(root, "");
  return result;
}

async function originState(root: string): Promise<Readonly<Record<string, string>>> {
  const commonDirectory = path.resolve(root, git(root, "rev-parse", "--git-common-dir").toString("utf8").trim());
  const configBytes = await readFile(path.join(commonDirectory, "config"));
  const indexPath = path.resolve(root, git(root, "rev-parse", "--git-path", "index").toString("utf8").trim());
  return {
    commonConfigBytes: configBytes.toString("hex"),
    commonConfigSha256: createHash("sha256").update(configBytes).digest("hex"),
    extensionsWorktreeConfig: optionalLocalGitConfig(root, "extensions.worktreeConfig"),
    coreSparseCheckout: optionalLocalGitConfig(root, "core.sparseCheckout"),
    repositoryFiles: JSON.stringify(await snapshotRepositoryFiles(root)),
    outsideTargetFile: (await readFile(`${root}-outside.ts`)).toString("hex"),
    head: git(root, "rev-parse", "HEAD").toString("utf8").trim(),
    branch: git(root, "rev-parse", "--abbrev-ref", "HEAD").toString("utf8").trim(),
    index: (await readFile(indexPath)).toString("hex"),
    status: git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").toString("hex"),
    stagedDiff: git(root, "diff", "--cached", "--binary", "HEAD").toString("hex"),
    unstagedDiff: git(root, "diff", "--binary").toString("hex"),
    mainFile: (await readFile(path.join(root, "src", "main.ts"))).toString("hex"),
    whitespaceFile: (await readFile(path.join(root, "src", "whitespace.ts"))).toString("hex"),
    readmeFile: (await readFile(path.join(root, "README.md"))).toString("hex"),
    untrackedFile: (await readFile(path.join(root, "local-notes.txt"))).toString("hex"),
  };
}

function captureOutput() {
  let value = "";
  return {
    writer: { write: (chunk: string | Uint8Array) => { value += String(chunk); return true; } },
    get text() { return value; },
  };
}

function patchContent(options: Readonly<{ path?: string; oldText?: string; newText?: string; citationPath?: string }> = {}): string {
  return JSON.stringify({
    patches: [{
      path: options.path ?? "src/main.ts",
      edits: [{
        oldText: options.oldText ?? 'export function greeting() {\n  return "before";\n}',
        newText: options.newText ?? 'export function greeting() {\n  return "after";\n}',
        reason: "更新问候函数的返回值。",
        citations: [{ path: options.citationPath ?? "src/main.ts", startLine: 1, endLine: 3 }],
      }],
    }],
  });
}

function mockResponse(content: string): Response {
  return Response.json({ choices: [{ message: { role: "assistant", content } }] });
}

function commonOptions(root: string, output: ReturnType<typeof captureOutput>, content: string, disposition: "keep" | "discard" | null) {
  let fetchCalls = 0;
  let sentBody = "";
  const options = {
    cwd: root,
    plan: "只更新 greeting 的返回值，不改变其他行为。",
    files: ["src/main.ts"],
    env: {
      OPENAI_API_KEY: "mock-only-key",
      OPENAI_MODEL: "mock-model",
      OPENAI_BASE_URL: "https://mock.example/v1",
    },
    stdout: output.writer,
    approvePlan: async () => true,
    confirmSend: async () => true,
    chooseDisposition: async () => disposition,
    fetchImpl: async (_input: RequestInfo | URL, init?: RequestInit) => {
      fetchCalls += 1;
      sentBody = String(init?.body ?? "");
      return mockResponse(content);
    },
  };
  return {
    options,
    get fetchCalls() { return fetchCalls; },
    get sentBody() { return sentBody; },
  };
}

function keptWorktreePath(output: string): string {
  const match = output.match(/已生成并保留隔离工作树（未提交）：([^\r\n]+)/);
  assert.ok(match, "keep flow should report the exact isolated worktree path");
  return match[1] as string;
}

test("diff renderer preserves LF boundaries and escapes terminal controls", () => {
  const rawDiff = "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n+fake\u001b]8;;https://bad.example\u0007link\u0007\r\t\u009b31m\u2028\u202e\nnext line\n";
  const rendered = renderDiffForTerminal(rawDiff);

  assert.equal(rendered.split("\n").length, rawDiff.split("\n").length);
  assert.ok(rendered.includes("\n--- a/file.ts\n+++ b/file.ts\n"));
  assert.ok(rendered.includes("+fake\\x1b]8;;https://bad.example\\x07link\\x07\\x0d\\x09\\x9b31m\\u2028\\u202e\nnext line\n"));
  assert.doesNotMatch(rendered, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u2029\u202a-\u202e\u2066-\u2069]/);
});

test("patch CLI requires an explicit plan and exact safe repository-relative file list", () => {
  assert.deepEqual(parsePatchArguments(["--plan", "Fix greeting", "--file", "src/main.ts"]), {
    plan: "Fix greeting",
    files: ["src/main.ts"],
  });
  for (const args of [
    [],
    ["--plan", "", "--file", "src/main.ts"],
    ["--plan", "Fix", "--file", "../src/main.ts"],
    ["--plan", "Fix", "--file", "/tmp/main.ts"],
    ["--plan", "Fix", "--file", "C:/tmp/main.ts"],
    ["--plan", "Fix", "--file", "src/*.ts"],
    ["--plan", "Fix", "--file", ".git/index"],
    ["--plan", "Fix", "--file", ".env.local"],
    ["--plan", "Fix", "--file", "src/main.ts", "--file", "src/main.ts"],
  ]) assert.throws(() => parsePatchArguments(args));
});

test("cancel sends nothing, does not read the API key, removes its isolated worktree, and preserves staged/unstaged/untracked origin state", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    let fetchCalls = 0;
    let keyRead = false;
    const exitCode = await runPatchCli({
      cwd: root,
      plan: "只更新 greeting 的返回值。",
      files: ["src/main.ts"],
      env: {
        OPENAI_MODEL: "mock-model",
        OPENAI_BASE_URL: "https://mock.example/v1",
        get OPENAI_API_KEY() { keyRead = true; throw new Error("must not read before approval"); },
      },
      stdout: output.writer,
      approvePlan: async () => true,
      confirmSend: async () => false,
      fetchImpl: async () => { fetchCalls += 1; throw new Error("mock fetch must not run"); },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCalls, 0);
    assert.equal(keyRead, false);
    assert.match(output.text, /已取消：未发送模型请求/);
    assert.match(output.text, /隔离工作树状态：已丢弃/);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("declining the exact plan and file scope creates no worktree and sends no request", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    let fetchCalls = 0;
    const exitCode = await runPatchCli({
      cwd: root,
      plan: "只更新 greeting 的返回值。",
      files: ["src/main.ts"],
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: output.writer,
      approvePlan: async () => false,
      confirmSend: async () => true,
      fetchImpl: async () => { fetchCalls += 1; throw new Error("mock fetch must not run"); },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCalls, 0);
    assert.match(output.text, /计划或文件范围未批准/);
    assert.match(output.text, /没有创建隔离工作树或发送请求/);
    assert.equal(git(root, "worktree", "list", "--porcelain").toString("utf8").split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("approved patch preview is the exact mock request, diff equals kept worktree, and origin worktree is unchanged", async () => {
  await withDirtyRepository(async ({ root, commandMarkers }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    assert.equal(before.extensionsWorktreeConfig, "UNSET");
    assert.equal(before.coreSparseCheckout, "UNSET");
    assert.ok(Object.keys(registryBefore).length > 0, "fixture must start with a pre-existing linked-worktree registry");
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent(), "keep");
    const exitCode = await runPatchCli(mock.options);

    assert.equal(exitCode, 0);
    assert.equal(mock.fetchCalls, 1);
    assert.equal(mock.sentBody.length > 0, true);
    assert.ok(output.text.includes(mock.sentBody), "the exact serialized request body must be previewed before sending");
    assert.match(output.text, /https:\/\/mock\.example\/v1\/chat\/completions/);
    assert.match(output.text, /只更新 greeting 的返回值/);
    assert.match(output.text, /src\/main\.ts/);
    assert.doesNotMatch(mock.sentBody, /never-include-this|user unstaged change|User staged change|Untracked local note|Baseline README/);
    assert.match(output.text, /候选补丁在隔离工作树中相对基准 HEAD 的完整 diff/);
    assert.match(output.text, /\n--- a\/src\/main\.ts\n\+\+\+ b\/src\/main\.ts\n/);
    assert.match(output.text, /\n-  return "before";\n\+  return "after";\n/);
    assert.match(output.text, /-  return "before";/);
    assert.match(output.text, /\+  return "after";/);
    assert.match(output.text, /引用：src\/main\.ts:1-3/);

    const worktree = keptWorktreePath(output.text);
    const materialized = await readdir(worktree);
    assert.deepEqual(materialized.sort(), [".git", "src"]);
    assert.deepEqual(await readdir(path.join(worktree, "src")), ["main.ts"]);
    assert.ok(!materialized.includes(".env.local"));
    assert.ok(!materialized.includes("secrets"));
    const exactDiff = git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "HEAD", "--", "src/main.ts").toString("utf8");
    assert.ok(exactDiff.length > 0);
    assert.ok(output.text.includes(exactDiff), "displayed diff must exactly match git diff in the kept worktree");
    assert.equal((await readFile(path.join(worktree, "src", "main.ts"), "utf8")).includes('return "after";'), true);
    assert.deepEqual(await originState(root), before);
    const registryAfter = await gitWorktreeRegistryState(root);
    assertRegistryEntriesUnchanged(registryBefore, registryAfter);
    assert.ok(Object.keys(registryAfter).length > Object.keys(registryBefore).length);
    for (const marker of commandMarkers) {
      await assert.rejects(
        readFile(marker),
        (error: unknown) => error instanceof Error && "code" in error && error.code === "ENOENT",
        `successful keep path must not run a Git hook or filter: ${marker}`,
      );
    }
  });
});

test("normal LF, CR, and TAB source plus multi-line patch text are accepted safely", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    assert.equal(before.extensionsWorktreeConfig, "true");
    assert.equal(before.coreSparseCheckout, "UNSET");
    const output = captureOutput();
    const original = 'export function whitespace() {\r\n\treturn "before";\r\n}\r\n';
    const replacement = 'export function whitespace() {\r\n\treturn "after";\r\n}\r\n';
    const response = JSON.stringify({
      patches: [{
        path: "src/whitespace.ts",
        edits: [{
          oldText: original.slice(0, -2),
          newText: replacement.slice(0, -2),
          reason: "保留 CRLF 与 TAB，只更新返回值。",
          citations: [{ path: "src/whitespace.ts", startLine: 1, endLine: 3 }],
        }],
      }],
    });
    let fetchCalls = 0;
    const exitCode = await runPatchCli({
      cwd: root,
      plan: "只更新 whitespace 函数的返回值。",
      files: ["src/whitespace.ts"],
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_MODEL: "mock-model", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: output.writer,
      approvePlan: async () => true,
      confirmSend: async () => true,
      chooseDisposition: async () => "keep",
      fetchImpl: async () => { fetchCalls += 1; return mockResponse(response); },
    });

    assert.equal(exitCode, 0);
    assert.equal(fetchCalls, 1);
    assert.match(output.text, /已生成并保留隔离工作树/);
    const worktree = keptWorktreePath(output.text);
    assert.equal(await readFile(path.join(worktree, "src", "whitespace.ts"), "utf8"), replacement);
    assert.match(output.text, /\\x09/);
    assert.match(output.text, /\\x0d/);
    assert.deepEqual(await originState(root), before);
    const registryAfter = await gitWorktreeRegistryState(root);
    assertRegistryEntriesUnchanged(registryBefore, registryAfter);
    assert.ok(Object.keys(registryAfter).length > Object.keys(registryBefore).length);
  }, { worktreeConfig: "true" });
});

test("discard removes generated isolated worktree without changing the source worktree", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    assert.equal(before.extensionsWorktreeConfig, "UNSET");
    assert.equal(before.coreSparseCheckout, "UNSET");
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent(), "discard");
    const exitCode = await runPatchCli(mock.options);

    assert.equal(exitCode, 0);
    assert.equal(mock.fetchCalls, 1);
    assert.match(output.text, /已生成后丢弃隔离补丁工作树/);
    assert.match(output.text, /隔离工作树状态：已丢弃/);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
    const listing = git(root, "worktree", "list", "--porcelain").toString("utf8");
    assert.equal(listing.split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
  });
});

test("failed git worktree removal returns non-zero, reports its exact path, and can be retried safely", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent(), "discard");
    let removeAttempts = 0;
    let attemptedRoot = "";
    let attemptedWorktree = "";
    const exitCode = await runPatchCli({
      ...mock.options,
      confirmSend: async () => false,
      cleanupOperations: {
        removeWorktree: async (repositoryRoot, worktreePath) => {
          removeAttempts += 1;
          attemptedRoot = repositoryRoot;
          attemptedWorktree = worktreePath;
          throw new Error("injected git worktree remove failure");
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(mock.fetchCalls, 0);
    assert.equal(removeAttempts, 1);
    assert.equal(attemptedRoot, root);
    assert.equal(path.basename(attemptedWorktree), "worktree");
    assert.ok(output.text.includes(attemptedWorktree), "the exact leftover worktree path must be reported");
    assert.match(output.text, /清理未完成：未能确认隔离工作树已移除/);
    assert.match(output.text, /worktree remove --force/);
    assert.match(output.text, /rmdir/);
    assert.match(output.text, /injected git worktree remove failure/);
    assert.match(output.text, /已取消：未发送模型请求，也未应用补丁/);
    assert.doesNotMatch(output.text, /隔离工作树状态：已丢弃|已生成后丢弃隔离补丁工作树/);
    assert.ok((await readFile(path.join(attemptedWorktree, "src", "main.ts"), "utf8")).includes('return "before";'));
    const listingAfterFailure = git(root, "worktree", "list", "--porcelain").toString("utf8");
    assert.ok(listingAfterFailure.includes(`worktree ${attemptedWorktree}`));
    assert.deepEqual(await originState(root), before);
    assertRegistryEntriesUnchanged(registryBefore, await gitWorktreeRegistryState(root));

    git(root, "worktree", "remove", "--force", attemptedWorktree);
    await rmdir(path.dirname(attemptedWorktree));
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("failed parent-directory removal reports the exact residual directory and can be retried without recursion", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent(), "discard");
    let attemptedParent = "";
    const exitCode = await runPatchCli({
      ...mock.options,
      cleanupOperations: {
        removeParentDirectory: async (parentDirectory) => {
          attemptedParent = parentDirectory;
          throw new Error("injected parent-directory removal failure");
        },
      },
    });

    assert.equal(exitCode, 1);
    assert.equal(mock.fetchCalls, 1);
    assert.ok(attemptedParent);
    assert.ok(output.text.includes(attemptedParent), "the exact residual parent path must be reported");
    assert.match(output.text, /隔离工作树已移除，但临时父目录未能清理/);
    assert.match(output.text, /rmdir/);
    assert.match(output.text, /不要使用递归删除/);
    assert.match(output.text, /injected parent-directory removal failure/);
    assert.doesNotMatch(output.text, /已生成后丢弃隔离补丁工作树/);
    assert.deepEqual(await readdir(attemptedParent), [], "only an empty task-owned parent directory should remain");
    const listingAfterFailure = git(root, "worktree", "list", "--porcelain").toString("utf8");
    assert.ok(!listingAfterFailure.includes(`worktree ${path.join(attemptedParent, "worktree")}`));
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);

    await rmdir(attemptedParent);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("unexpected disposition values fail closed instead of being treated as discard", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent(), "keep");
    const exitCode = await runPatchCli({
      ...mock.options,
      chooseDisposition: async () => "unexpected-value" as unknown as "keep" | "discard" | null,
    });

    assert.equal(exitCode, 1);
    assert.equal(mock.fetchCalls, 1);
    assert.match(output.text, /补丁流程失败/);
    assert.match(output.text, /保留\/丢弃回调返回无效值/);
    assert.doesNotMatch(output.text, /已生成并保留隔离工作树|已生成后丢弃隔离补丁工作树/);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
    const listing = git(root, "worktree", "list", "--porcelain").toString("utf8");
    assert.equal(listing.split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
  });
});

test("patch CLI accepts a replacement provider while retaining exact preview, scope, and disposition gates", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const output = captureOutput();
    let providerCalls = 0;
    let fetchCalls = 0;
    let deliveredRequest: { endpoint: string; serializedBody: string } | undefined;
    const exitCode = await runPatchCli({
      cwd: root,
      plan: "只更新 greeting 的返回值。",
      files: ["src/main.ts"],
      env: { OPENAI_MODEL: "replacement-model", OPENAI_BASE_URL: "https://provider.example/v1" },
      stdout: output.writer,
      approvePlan: async () => true,
      confirmSend: async () => true,
      chooseDisposition: async () => "discard",
      provider: {
        send: async (request) => {
          providerCalls += 1;
          deliveredRequest = request;
          return mockResponse(patchContent());
        },
      },
      fetchImpl: async () => { fetchCalls += 1; throw new Error("the OpenAI-compatible adapter must not be called"); },
    });

    assert.equal(exitCode, 0);
    assert.equal(providerCalls, 1);
    assert.equal(fetchCalls, 0);
    assert.equal(deliveredRequest?.endpoint, "https://provider.example/v1/chat/completions");
    assert.ok(output.text.includes(deliveredRequest?.serializedBody ?? ""));
    assert.match(output.text, /候选补丁在隔离工作树中相对基准 HEAD 的完整 diff/);
    assert.match(output.text, /已生成后丢弃隔离补丁工作树/);
    assert.deepEqual(await originState(root), before);
  });
});

test("malformed model patches fail closed and preserve origin state", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const invalidResponses = [
      patchContent({ path: "README.md" }),
      patchContent({ path: "../README.md" }),
      patchContent({ oldText: "not present in selected HEAD" }),
      patchContent({ citationPath: "../README.md" }),
      "not JSON",
    ];

    for (const content of invalidResponses) {
      const output = captureOutput();
      const mock = commonOptions(root, output, content, "keep");
      const exitCode = await runPatchCli(mock.options);
      assert.equal(exitCode, 1, content);
      assert.equal(mock.fetchCalls, 1);
      assert.doesNotMatch(output.text, /已保留隔离工作树|已生成后丢弃隔离补丁工作树/);
      assert.match(output.text, /补丁流程失败/);
      assert.deepEqual(await originState(root), before);
      assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
      assert.equal(git(root, "worktree", "list", "--porcelain").toString("utf8").split("\n").filter((line) => line.startsWith("worktree ")).length, 2);
    }
  });
});

test("oversized response stream is cancelled before full buffering, JSON parsing, or patch application", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    let pullCalls = 0;
    let cancelled = false;
    let tailChunkDelivered = false;
    let jsonCalls = 0;
    let dispositionCalls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pullCalls += 1;
        if (pullCalls <= 2) controller.enqueue(new Uint8Array(300 * 1024));
        else {
          tailChunkDelivered = true;
          controller.enqueue(new Uint8Array(16));
          controller.close();
        }
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0, size: (chunk) => chunk.byteLength });
    const response = new Response(body, { status: 200 });
    Object.defineProperty(response, "json", {
      value: async () => {
        jsonCalls += 1;
        return { choices: [{ message: { content: patchContent() } }] };
      },
    });
    const exitCode = await runPatchCli({
      cwd: root,
      plan: "只更新 greeting 的返回值。",
      files: ["src/main.ts"],
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_MODEL: "mock-model", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: output.writer,
      approvePlan: async () => true,
      confirmSend: async () => true,
      chooseDisposition: async () => { dispositionCalls += 1; return "keep"; },
      fetchImpl: async () => response,
    });

    assert.equal(exitCode, 1);
    assert.equal(pullCalls, 2);
    assert.equal(cancelled, true);
    assert.equal(tailChunkDelivered, false);
    assert.equal(jsonCalls, 0);
    assert.equal(dispositionCalls, 0);
    assert.match(output.text, /HTTP 响应超过 524288 字节上限/);
    assert.doesNotMatch(output.text, /已生成并保留隔离工作树|候选补丁在隔离工作树中相对基准 HEAD 的完整 diff/);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("absolute, traversal, excluded-secret, .git, and symlink paths are rejected before any model request", async () => {
  await withDirtyRepository(async ({ root }) => {
    for (const file of ["../README.md", path.join(root, "src", "main.ts"), ".env.local", ".git/index"]) {
      const output = captureOutput();
      let fetchCalls = 0;
      const exitCode = await runPatchCli({
        cwd: root,
        plan: "仅修改用户批准的目标文件。",
        files: [file],
        env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
        stdout: output.writer,
        confirmSend: async () => true,
        fetchImpl: async () => { fetchCalls += 1; return mockResponse(patchContent()); },
      });
      assert.equal(exitCode, 2, file);
      assert.equal(fetchCalls, 0, file);
      assert.match(output.text, /未启动补丁流程/);
    }
    const symlinkOutput = captureOutput();
    let symlinkFetchCalls = 0;
    const symlinkExit = await runPatchCli({
      cwd: root,
      plan: "仅修改用户批准的目标文件。",
      files: ["src/outside-link.ts"],
      env: { OPENAI_API_KEY: "mock-only-key", OPENAI_BASE_URL: "https://mock.example/v1" },
      stdout: symlinkOutput.writer,
      approvePlan: async () => true,
      confirmSend: async () => true,
      fetchImpl: async () => { symlinkFetchCalls += 1; return mockResponse(patchContent()); },
    });
    assert.equal(symlinkExit, 1);
    assert.equal(symlinkFetchCalls, 0);
    assert.match(symlinkOutput.text, /符号链接/);
  });
});

test("terminal controls in model edits are rejected and never printed raw", async () => {
  await withDirtyRepository(async ({ root }) => {
    const before = await originState(root);
    const registryBefore = await gitWorktreeRegistryState(root);
    const output = captureOutput();
    const mock = commonOptions(root, output, patchContent({ newText: 'return "\u001b[31mred\u001b[0m";' }), "discard");
    const exitCode = await runPatchCli(mock.options);

    assert.equal(exitCode, 1);
    assert.doesNotMatch(output.text, /\u001b/);
    assert.match(output.text, /补丁流程失败/);
    assert.deepEqual(await originState(root), before);
    assert.deepEqual(await gitWorktreeRegistryState(root), registryBefore);
  });
});

test("patch argument parser does not treat commands or extra options as executable input", () => {
  assert.throws(() => parsePatchArguments(["--plan", "Fix", "--file", "src/main.ts", "--run", "echo unsafe"]));
});
