import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  runFakeProviderTui,
  wrapTerminalText,
  type FakeProvider,
} from "../src/fake-provider-tui.js";

type FakeInput = PassThrough & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
};
type FakeOutput = PassThrough & {
  isTTY?: boolean;
  columns?: number;
};
type TerminalFixture = Readonly<{
  stdin: FakeInput;
  stdout: FakeOutput;
  getOutput: () => string;
  getRawMode: () => boolean;
}>;

function terminalFixture(columns = 80): TerminalFixture {
  const stdin = new PassThrough() as FakeInput;
  stdin.isTTY = true;
  let rawMode = false;
  stdin.setRawMode = (enabled) => { rawMode = enabled; };
  const stdout = new PassThrough() as FakeOutput;
  stdout.isTTY = true;
  stdout.columns = columns;
  let output = "";
  stdout.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  return { stdin, stdout, getOutput: () => output, getRawMode: () => rawMode };
}

function sendKeys(fixture: TerminalFixture, keys: string): void {
  fixture.stdin.write(keys);
}

function responseProvider(send: FakeProvider["send"]): FakeProvider {
  return { send };
}

function cellCount(text: string): number {
  return Array.from(text).reduce((total, character) => {
    const point = character.codePointAt(0) ?? 0;
    return total + (point >= 0x1100 && (point <= 0x115f || point >= 0x2e80) ? 2 : 1);
  }, 0);
}

test("inspect accepts a non-demo task, supports backspace editing, and requires request approval", async () => {
  const fixture = terminalFixture();
  let providerCalls = 0;
  let received: unknown;
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
    provider: responseProvider(async (request) => {
      providerCalls += 1;
      received = request;
      return { workflow: "inspect", summary: "fake result" };
    }),
  });
  sendKeys(fixture, "ihelo\u007flo\nybq");
  assert.equal(await run, 0);
  assert.equal(providerCalls, 1);
  assert.deepEqual(received, { workflow: "inspect", task: "hello", plan: "", files: [] });
  assert.match(fixture.getOutput(), /完整请求预览/);
  assert.match(fixture.getOutput(), /只读理解结果 — 已完成/);
  assert.equal(fixture.getRawMode(), false);
});

test("patch collects and edits task, plan, and exact files before scope confirmation", async () => {
  const fixture = terminalFixture();
  let providerCalls = 0;
  let received: unknown;
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
    provider: responseProvider(async (request) => {
      providerCalls += 1;
      received = request;
      return { workflow: "patch", diff: "--- fake diff\n+++ fake diff\n" };
    }),
  });
  sendKeys(fixture, "pInitial patch task\nInitial plan\nsrc/demo.ts\nt updated\n2 revised\nf\u007f\u007ftsx\n\nykq");
  assert.equal(await run, 0);
  assert.equal(providerCalls, 1);
  assert.deepEqual(received, {
    workflow: "patch",
    task: "Initial patch task updated",
    plan: "Initial plan revised",
    files: ["src/demo.tsx"],
  });
  assert.match(fixture.getOutput(), /补丁计划与精确文件范围复核/);
  assert.match(fixture.getOutput(), /src\/demo\.tsx/);
  assert.match(fixture.getOutput(), /完整请求预览/);
  assert.match(fixture.getOutput(), /Fake diff — 未应用到任何文件/);
  assert.match(fixture.getOutput(), /演示状态已保留/);
});

test("cancel and back during request preview return without a provider request", async (t) => {
  for (const [name, keys] of [["cancel", "iSummarize alpha\nnq"], ["back", "iSummarize beta\nbq"]] as const) {
    await t.test(name, async () => {
      const fixture = terminalFixture();
      let providerCalls = 0;
      const run = runFakeProviderTui({
        stdin: fixture.stdin,
        stdout: fixture.stdout,
        env: { TERM: "xterm" },
        provider: responseProvider(async () => {
          providerCalls += 1;
          return { workflow: "inspect", summary: "should not be reached" };
        }),
      });
      sendKeys(fixture, keys);
      assert.equal(await run, 0);
      assert.equal(providerCalls, 0);
      assert.match(fixture.getOutput(), /取消|已取消|结束/);
    });
  }
});

test("empty task, plan, and file inputs are rejected before the explicit gates", async () => {
  const fixture = terminalFixture();
  let providerCalls = 0;
  let received: unknown;
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
    provider: responseProvider(async (request) => {
      providerCalls += 1;
      received = request;
      return { workflow: "patch", diff: "--- synthetic diff\n+++ synthetic diff\n" };
    }),
  });
  sendKeys(fixture, "p\nTask from user\n\nPlan from user\n\nsrc/synthetic.ts\n\nykq");
  assert.equal(await run, 0);
  assert.equal(providerCalls, 1);
  assert.deepEqual(received, {
    workflow: "patch",
    task: "Task from user",
    plan: "Plan from user",
    files: ["src/synthetic.ts"],
  });
  assert.match(fixture.getOutput(), /此项不能为空/);
  assert.match(fixture.getOutput(), /请输入 1–6 个精确文件路径/);
});

test("canceling task entry or refusing patch scope makes zero provider calls", async (t) => {
  await t.test("task entry cancellation", async () => {
    const fixture = terminalFixture();
    let providerCalls = 0;
    const run = runFakeProviderTui({
      stdin: fixture.stdin,
      stdout: fixture.stdout,
      env: { TERM: "xterm" },
      provider: responseProvider(async () => {
        providerCalls += 1;
        return { workflow: "inspect", summary: "unexpected" };
      }),
    });
    sendKeys(fixture, "i\u0003q");
    assert.equal(await run, 0);
    assert.equal(providerCalls, 0);
    assert.ok(!fixture.getOutput().includes("完整请求预览（仅发给本地 fake provider）"));
  });
  await t.test("patch scope refusal", async () => {
    const fixture = terminalFixture();
    let providerCalls = 0;
    const run = runFakeProviderTui({
      stdin: fixture.stdin,
      stdout: fixture.stdout,
      env: { TERM: "xterm" },
      provider: responseProvider(async () => {
        providerCalls += 1;
        return { workflow: "patch", diff: "unexpected" };
      }),
    });
    sendKeys(fixture, "pTask\nPlan\nsrc/synthetic.ts\nnq");
    assert.equal(await run, 0);
    assert.equal(providerCalls, 0);
    assert.match(fixture.getOutput(), /补丁计划与精确文件范围复核/);
    assert.ok(!fixture.getOutput().includes("完整请求预览（仅发给本地 fake provider）"));
  });
});

test("provider failure is visible and recovery requires a fresh explicit approval", async () => {
  const fixture = terminalFixture();
  let providerCalls = 0;
  const provider = responseProvider(async () => {
    providerCalls += 1;
    if (providerCalls === 1) throw new Error("simulated provider failure");
    return { workflow: "inspect", summary: "recovered" };
  });
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
    provider,
  });
  sendKeys(fixture, "iTask one\nyriTask two\nybq");
  assert.equal(await run, 0);
  assert.equal(providerCalls, 2);
  assert.match(fixture.getOutput(), /simulated provider failure/);
  assert.match(fixture.getOutput(), /重新开始会创建新的状态机/);
  assert.match(fixture.getOutput(), /完整请求预览/g);
});

test("diff control characters are rendered as visible text", async () => {
  const fixture = terminalFixture();
  const hostileDiff = "diff\n\u001b[2Jclear\n\u001b]0;owned title\u0007";
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
    provider: responseProvider(async () => ({ workflow: "patch", diff: hostileDiff })),
  });
  sendKeys(fixture, "pTask for escaping\nSafe synthetic plan\nsrc/demo.ts\n\nyykq");
  assert.equal(await run, 0);
  const output = fixture.getOutput();
  assert.match(output, /\\x1b\[2J/);
  assert.match(output, /\\x1b\]0;owned title\\x07/);
  assert.ok(!output.includes(`diff\n${String.fromCharCode(27)}[2Jclear`));
});

test("narrow screens wrap content and resize redraws without losing the active menu", async () => {
  const wrapped = wrapTerminalText("窄屏幕 Fake-provider menu", 12);
  assert.ok(wrapped.every((line) => cellCount(line) <= 12));

  const fixture = terminalFixture(32);
  const run = runFakeProviderTui({
    stdin: fixture.stdin,
    stdout: fixture.stdout,
    env: { TERM: "xterm" },
  });
  fixture.stdout.columns = 14;
  fixture.stdout.emit("resize");
  sendKeys(fixture, "q");
  assert.equal(await run, 0);
  assert.ok((fixture.getOutput().match(/\u001b\[2J/g) ?? []).length >= 2);
  assert.match(fixture.getOutput(), /Fake-provider TUI/);
});

test("TERM=dumb uses plain line input and non-TTY exits without waiting", async () => {
  const dumb = terminalFixture();
  const dumbRun = runFakeProviderTui({
    stdin: dumb.stdin,
    stdout: dumb.stdout,
    env: { TERM: "dumb" },
  });
  sendKeys(dumb, "q\n");
  assert.equal(await Promise.race([dumbRun, delay(1000).then(() => "timeout")]), 0);
  assert.ok(!dumb.getOutput().includes(String.fromCharCode(27)));

  const stdin = new PassThrough() as FakeInput;
  const stdout = new PassThrough() as FakeOutput;
  let output = "";
  let providerCalls = 0;
  stdout.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
  const exit = await Promise.race([
    runFakeProviderTui({
      stdin,
      stdout,
      provider: responseProvider(async () => {
        providerCalls += 1;
        return { workflow: "inspect", summary: "unexpected" };
      }),
    }),
    delay(1000).then(() => "timeout"),
  ]);
  assert.equal(exit, 0);
  assert.equal(providerCalls, 0);
  assert.match(output, /非 TTY，已安全退出/);
});

test("CLI completes a keyboard approval flow under a real PTY", { skip: process.platform !== "linux" || !existsSync("/usr/bin/script") }, async () => {
  const child = spawn("/usr/bin/script", ["-qec", "stty cols 100 rows 30; node --import tsx src/tui.ts", "/dev/null"], {
    cwd: process.cwd(),
    env: { ...process.env, TERM: "xterm-256color" },
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });

  const waitFor = async (text: string): Promise<void> => {
    const deadline = Date.now() + 5000;
    while (!output.includes(text)) {
      if (Date.now() >= deadline) throw new Error(`PTY did not show ${JSON.stringify(text)}; output=${output.slice(-1000)}`);
      await delay(20);
    }
  };
  try {
    await waitFor("选择演示流程");
    child.stdin.write("i");
    await waitFor("请输入本次 fake-provider 演示任务");
    child.stdin.write("PTY supplied task");
    child.stdin.write("\r");
    await waitFor("完整请求预览");
    child.stdin.write("y");
    await waitFor("只读理解结果");
    child.stdin.write("b");
    await waitFor("提示：流程结束或取消");
    child.stdin.write("q");
    assert.equal(child.stdin.writableEnded, false, "parent stdin must remain open after q");
    const code = await Promise.race([
      new Promise<number | null>((resolve) => child.once("close", (exitCode) => resolve(exitCode))),
      delay(2000).then(() => "timeout" as const),
    ]);
    assert.notEqual(code, "timeout", "PTY CLI should not hang");
    assert.equal(code, 0);
    assert.match(output, /Fake-provider TUI/);
    assert.match(output, /模拟回复/);
  } finally {
    child.kill("SIGKILL");
  }
});
