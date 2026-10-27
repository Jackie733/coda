import { createInterface, emitKeypressEvents, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  ApplicationStateMachine,
  approvePatchScope,
  requestAfterApproval,
  type Provider,
} from "./application.js";
import { renderDiffForTerminal } from "./patch-cli.js";
import { visibleControls } from "./readonly-cli.js";

export type FakeProviderRequest = Readonly<{
  workflow: "inspect" | "patch";
  plan: string;
  files: readonly string[];
}>;

export type FakeProviderResponse =
  | Readonly<{ workflow: "inspect"; summary: string }>
  | Readonly<{ workflow: "patch"; diff: string }>;

export type FakeProvider = Provider<FakeProviderRequest, FakeProviderResponse>;

type TuiInput = Readable & {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

type TuiOutput = Writable & {
  isTTY?: boolean;
  columns?: number;
};

type TuiAction =
  | "enter" | "cancel" | "back" | "up" | "down"
  | "inspect" | "patch" | "approve" | "keep" | "discard" | "restart" | "quit"
  | "invalid";

type Keypress = Readonly<{ name?: string; ctrl?: boolean }>;
type TerminalMode = "raw" | "line";
type WorkflowRunResult =
  | Readonly<{ kind: "menu" }>
  | Readonly<{ kind: "quit" }>
  | Readonly<{ kind: "recover"; message: string }>;

type FakeProviderTuiOptions = Readonly<{
  stdin?: TuiInput;
  stdout?: TuiOutput;
  env?: Readonly<Record<string, string | undefined>>;
  provider?: FakeProvider;
}>;

const DEMO_PLAN = "演示由状态机控制的请求审批与结果展示；不会修改文件。";
const DEMO_FILES = Object.freeze(["src/app.ts"]);
const DEFAULT_DIFF = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export const demo = false;\n+export const demo = true;\n";

function defaultFakeProvider(): FakeProvider {
  return Object.freeze({
    async send(request: FakeProviderRequest): Promise<FakeProviderResponse> {
      if (request.workflow === "inspect") {
        return Object.freeze({
          workflow: "inspect",
          summary: "这是本地 fake-provider 的模拟回复。未访问网络，也未读取或修改仓库文件。",
        });
      }
      return Object.freeze({ workflow: "patch", diff: DEFAULT_DIFF });
    },
  });
}

function cellWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0 || /\p{Mark}/u.test(character)) return 0;
  if (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f || codePoint === 0x2329 || codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  ) return 2;
  return 1;
}

export function wrapTerminalText(text: string, columns: number): string[] {
  const width = Number.isFinite(columns) && columns > 0 ? Math.max(1, Math.floor(columns)) : 80;
  const wrapped: string[] = [];
  for (const sourceLine of text.split("\n")) {
    if (sourceLine.length === 0) {
      wrapped.push("");
      continue;
    }
    let line = "";
    let used = 0;
    for (const character of Array.from(sourceLine)) {
      const characterWidth = cellWidth(character);
      if (used > 0 && used + characterWidth > width) {
        wrapped.push(line);
        line = "";
        used = 0;
      }
      line += character;
      used += characterWidth;
      if (used >= width) {
        wrapped.push(line);
        line = "";
        used = 0;
      }
    }
    if (line || used === 0) wrapped.push(line);
  }
  return wrapped;
}

function actionFromKeypress(key: Keypress): TuiAction {
  if (key.ctrl && key.name === "c") return "cancel";
  switch (key.name?.toLowerCase()) {
    case "return":
    case "enter": return "enter";
    case "escape": return "cancel";
    case "backspace":
    case "left": return "back";
    case "up": return "up";
    case "down": return "down";
    case "i": return "inspect";
    case "p": return "patch";
    case "y": return "approve";
    case "n": return "cancel";
    case "k": return "keep";
    case "d": return "discard";
    case "c": return "cancel";
    case "p": return "patch";
    case "b": return "back";
    case "r": return "restart";
    case "q": return "quit";
    default: return "invalid";
  }
}

function actionFromLine(line: string): TuiAction {
  const value = line.trim().toLowerCase();
  if (!value || value === "enter" || value === "yes" || value === "y") return value === "y" || value === "yes" ? "approve" : "enter";
  if (["cancel", "no", "n", "c", "esc", "escape"].includes(value)) return "cancel";
  if (["back", "b", "left", "backspace"].includes(value)) return "back";
  if (["up", "arrowup"].includes(value)) return "up";
  if (["down", "arrowdown"].includes(value)) return "down";
  if (value === "i" || value === "inspect") return "inspect";
  if (value === "p" || value === "patch") return "patch";
  if (value === "k" || value === "keep") return "keep";
  if (value === "d" || value === "discard") return "discard";
  if (value === "r" || value === "restart") return "restart";
  if (value === "q" || value === "quit") return "quit";
  return "invalid";
}

class TuiTerminal {
  readonly mode: TerminalMode;
  readonly #input: TuiInput;
  readonly #output: TuiOutput;
  readonly #readline: ReadlineInterface | null;
  #screen = "";
  #prompt = "";
  #pendingRaw: ((action: TuiAction | null) => void) | null = null;
  #pendingLine: ((action: TuiAction | null) => void) | null = null;
  #rawQueue: TuiAction[] = [];
  #closed = false;
  readonly #keypressHandler: (text: string, key: Keypress) => void;
  readonly #endHandler: () => void;
  readonly #resizeHandler: () => void;
  readonly #lineCloseHandler: () => void;
  readonly #lineSigintHandler: () => void;

  constructor(input: TuiInput, output: TuiOutput, term: string | undefined) {
    this.#input = input;
    this.#output = output;
    this.mode = term?.toLowerCase() === "dumb" || typeof input.setRawMode !== "function" ? "line" : "raw";
    this.#keypressHandler = (_text, key) => this.#dispatchRaw(actionFromKeypress(key));
    this.#endHandler = () => this.#closeInput();
    this.#resizeHandler = () => this.#draw();
    this.#lineCloseHandler = () => this.#closeInput();
    this.#lineSigintHandler = () => this.#dispatchLine("cancel");

    if (this.mode === "raw") {
      emitKeypressEvents(input);
      input.setRawMode?.(true);
      input.resume();
      input.on("keypress", this.#keypressHandler);
      input.once("end", this.#endHandler);
      input.once("close", this.#endHandler);
      this.#readline = null;
    } else {
      const readline = createInterface({ input, output, terminal: false });
      readline.on("close", this.#lineCloseHandler);
      readline.on("SIGINT", this.#lineSigintHandler);
      this.#readline = readline;
    }
    output.on("resize", this.#resizeHandler);
  }

  show(screen: string, prompt: string): void {
    this.#screen = screen;
    this.#prompt = prompt;
    this.#draw();
  }

  async readAction(): Promise<TuiAction | null> {
    if (this.#closed) return null;
    if (this.mode === "raw") {
      const queued = this.#rawQueue.shift();
      if (queued) return queued;
      return new Promise((resolve) => { this.#pendingRaw = resolve; });
    }
    const readline = this.#readline;
    if (!readline) return null;
    return new Promise((resolve) => {
      this.#pendingLine = resolve;
      try {
        readline.question("> ", (answer) => this.#dispatchLine(actionFromLine(answer)));
      } catch {
        this.#dispatchLine(null);
      }
    });
  }

  close(): void {
    this.#output.off("resize", this.#resizeHandler);
    if (this.mode === "raw") {
      this.#input.off("keypress", this.#keypressHandler);
      this.#input.off("end", this.#endHandler);
      this.#input.off("close", this.#endHandler);
      this.#input.setRawMode?.(false);
      this.#output.write("\n");
    } else {
      this.#readline?.off("close", this.#lineCloseHandler);
      this.#readline?.off("SIGINT", this.#lineSigintHandler);
      this.#readline?.close();
    }
  }

  #draw(): void {
    if (!this.#screen) return;
    const columns = this.#output.columns ?? 80;
    const lines = wrapTerminalText(this.#screen, columns);
    const promptLines = wrapTerminalText(this.#prompt, columns);
    const content = `${lines.join("\n")}\n\n${promptLines.join("\n")}\n`;
    if (this.mode === "raw") this.#output.write(`\u001b[2J\u001b[H${content}`);
    else this.#output.write(`\n${content}`);
  }

  #dispatchRaw(action: TuiAction): void {
    if (this.#pendingRaw) {
      const resolve = this.#pendingRaw;
      this.#pendingRaw = null;
      resolve(action);
    } else if (!this.#closed) {
      this.#rawQueue.push(action);
    }
  }

  #dispatchLine(action: TuiAction | null): void {
    if (!this.#pendingLine) return;
    const resolve = this.#pendingLine;
    this.#pendingLine = null;
    resolve(action);
  }

  #closeInput(): void {
    this.#closed = true;
    if (this.#pendingRaw) {
      const resolve = this.#pendingRaw;
      this.#pendingRaw = null;
      resolve(null);
    }
    this.#dispatchLine(null);
  }
}

function menuScreen(selection: "inspect" | "patch", notice: string): string {
  return [
    "Fake-provider TUI — 本地模拟，不会联网",
    "",
    notice ? `提示：${visibleControls(notice)}` : "选择演示流程：",
    `${selection === "inspect" ? ">" : " "} [I] 只读理解 (inspect)`,
    `${selection === "patch" ? ">" : " "} [P] 补丁审批与 diff (patch)`,
    "",
    "整个演示不会读取真实仓库文件、调用 API 或修改文件。",
  ].join("\n");
}

function menuPrompt(): string {
  return "↑/↓ 选择，Enter 开始；I/P 快捷键；Q 退出。";
}

function approvalPrompt(): string {
  return "Enter/Y 明确批准；N/Esc/Backspace 取消当前流程并返回菜单。";
}

function errorMessage(error: unknown): string {
  return visibleControls(error instanceof Error ? error.message : "未知错误");
}

function requestPreview(request: FakeProviderRequest): string {
  return [
    "完整请求预览（仅发给本地 fake provider）：",
    JSON.stringify(request, null, 2),
    "",
    "只有在此处明确批准后才会调用 fake provider；取消不会发出 provider 请求。",
  ].join("\n");
}

function errorScreen(message: string): string {
  return [
    "演示未完成",
    "",
    `错误：${visibleControls(message)}`,
    "",
    "重新开始会创建新的状态机，并再次要求每一步明确批准。",
  ].join("\n");
}

async function choose(
  terminal: TuiTerminal,
  screen: string,
  prompt: string,
  allowed: readonly TuiAction[],
  onPresented?: () => void,
): Promise<TuiAction | null> {
  let notice = "";
  let presented = false;
  while (true) {
    terminal.show(notice ? `${screen}\n\n${notice}` : screen, prompt);
    if (!presented) {
      presented = true;
      onPresented?.();
    }
    const action = await terminal.readAction();
    if (action === null) return null;
    if (allowed.includes(action)) return action;
    notice = "按键无效；状态未改变，请使用屏幕列出的按键。";
  }
}

async function recoveryChoice(terminal: TuiTerminal, message: string): Promise<"restart" | "quit"> {
  while (true) {
    const action = await choose(
      terminal,
      errorScreen(message),
      "R 重新开始（重新审批）；Q 退出。",
      ["restart", "quit"],
    );
    if (action === "restart") return "restart";
    if (action === "quit" || action === null) return "quit";
  }
}

async function runWorkflow(terminal: TuiTerminal, kind: "inspect" | "patch", provider: FakeProvider): Promise<WorkflowRunResult> {
  const workflow = new ApplicationStateMachine(kind);
  const request: FakeProviderRequest = Object.freeze({
    workflow: kind,
    plan: DEMO_PLAN,
    files: kind === "patch" ? DEMO_FILES : Object.freeze([]),
  });

  if (kind === "patch") {
    let scopeAction: TuiAction | null = null;
    const scopeOutcome = await approvePatchScope(workflow, async () => {
      const action = await choose(
        terminal,
        [
          "补丁计划与文件范围审批",
          "",
          `计划：${DEMO_PLAN}`,
          `精确文件范围：${DEMO_FILES.join(", ")}`,
          "",
          "批准范围只允许继续到请求预览；这一步本身不会发送请求。",
        ].join("\n"),
        approvalPrompt(),
        ["enter", "approve", "cancel", "back", "quit"],
      );
      scopeAction = action;
      return action === "enter" || action === "approve";
    });
    if (scopeOutcome.kind === "approval-failed") return { kind: "recover", message: errorMessage(scopeOutcome.error) };
    if (scopeOutcome.kind === "cancelled") return { kind: scopeAction === "quit" ? "quit" : "menu" };
  }

  let requestApprovalAction: TuiAction | null = null;
  const outcome = await requestAfterApproval(
    workflow,
    request,
    async () => {
      const action = await choose(
        terminal,
        requestPreview(request),
        approvalPrompt(),
        ["enter", "approve", "cancel", "back", "quit"],
      );
      requestApprovalAction = action;
      return action === "enter" || action === "approve";
    },
    provider,
  );
  if (outcome.kind === "approval-failed") return { kind: "recover", message: errorMessage(outcome.error) };
  if (outcome.kind === "cancelled") return { kind: requestApprovalAction === "quit" ? "quit" : "menu" };
  if (outcome.kind === "provider-failed") return { kind: "recover", message: errorMessage(outcome.error) };

  if (kind === "inspect") {
    if (outcome.response.workflow !== "inspect") {
      workflow.fail();
      return { kind: "recover", message: "fake provider 返回了与当前流程不匹配的响应类型。" };
    }
    workflow.completeInspect();
    const action = await choose(
      terminal,
      [
        "只读理解结果 — 已完成",
        "",
        visibleControls(outcome.response.summary),
        "",
        "模拟完成；没有运行命令或修改文件。",
      ].join("\n"),
      "Enter/Back 返回菜单；Q 退出。",
      ["enter", "back", "quit"],
    );
    return { kind: action === "quit" || action === null ? "quit" : "menu" };
  }

  if (outcome.response.workflow !== "patch") {
    workflow.fail();
    return { kind: "recover", message: "fake provider 返回了与当前流程不匹配的响应类型。" };
  }
  workflow.candidateReady();
  const diffScreen = [
    "Fake diff — 未应用到任何文件",
    "",
    renderDiffForTerminal(outcome.response.diff),
    "",
    "请先检查完整 diff，再选择保留（仅保留演示状态）或丢弃。",
  ].join("\n");
  const disposition = await choose(
    terminal,
    diffScreen,
    "K 保留演示状态；D 丢弃；C/Esc/Backspace 取消并返回菜单。",
    ["keep", "discard", "cancel", "back", "quit"],
    () => workflow.reviewDiff(),
  );
  if (disposition === "quit" || disposition === null || disposition === "cancel" || disposition === "back") {
    workflow.finishPatch("cancelled");
    return { kind: disposition === "quit" ? "quit" : "menu" };
  }
  workflow.finishPatch(disposition === "keep" ? "kept" : "discarded");
  const action = await choose(
    terminal,
    [
      disposition === "keep" ? "演示状态已保留" : "演示状态已丢弃",
      "",
      "这只是内存中的状态；没有写入文件、Git index 或 worktree。",
    ].join("\n"),
    "Enter/Back 返回菜单；Q 退出。",
    ["enter", "back", "quit"],
  );
  return { kind: action === "quit" || action === null ? "quit" : "menu" };
}

export async function runFakeProviderTui(options: FakeProviderTuiOptions = {}): Promise<number> {
  const input = options.stdin ?? process.stdin;
  const output = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  if (input.isTTY !== true || output.isTTY !== true) {
    output.write("Fake-provider TUI 需要交互终端；当前非 TTY，已安全退出，没有请求 provider。\n");
    return 0;
  }

  const terminal = new TuiTerminal(input, output, env.TERM);
  const provider = options.provider ?? defaultFakeProvider();
  let selection: "inspect" | "patch" = "inspect";
  let notice = "";
  let exit = false;
  try {
    while (!exit) {
      const action = await choose(
        terminal,
        menuScreen(selection, notice),
        menuPrompt(),
        ["inspect", "patch", "enter", "up", "down", "quit", "cancel"],
      );
      notice = "";
      if (action === null || action === "quit" || action === "cancel") break;
      if (action === "up" || action === "down") {
        selection = selection === "inspect" ? "patch" : "inspect";
        continue;
      }
      if (action === "inspect" || action === "patch") selection = action;
      const result = await runWorkflow(terminal, selection, provider);
      if (result.kind === "quit") exit = true;
      else if (result.kind === "recover") {
        const recovery = await recoveryChoice(terminal, result.message);
        if (recovery === "quit") exit = true;
      } else {
        notice = "流程结束或取消；没有执行未批准的 provider 请求。";
      }
    }
  } finally {
    terminal.close();
  }
  return 0;
}
