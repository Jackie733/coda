import { createInterface, emitKeypressEvents, type Interface as ReadlineInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  ApplicationStateMachine,
  approvePatchScope,
  createApprovedFileScope,
  requestAfterApproval,
  type Provider,
} from "./application.js";
import { CONTEXT_LIMITS, isSafeRepositoryPath } from "./repo-context.js";
import { renderDiffForTerminal } from "./patch-cli.js";
import { visibleControls } from "./readonly-cli.js";
import { readSiwcTuiStatus } from "./siwc/ui-status.js";

export type FakeProviderRequest = Readonly<{
  workflow: "inspect" | "patch";
  task: string;
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
  | "editTask" | "editPlan" | "editFiles" | "invalid";

type Keypress = Readonly<{ name?: string; ctrl?: boolean }>;
type TerminalEvent =
  | Readonly<{ kind: "keypress"; text: string; key: Keypress }>
  | Readonly<{ kind: "line"; text: string }>;
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

const MAX_TASK_CHARS = 2_000;
const MAX_PLAN_CHARS = 2_000;
const MAX_FILES = CONTEXT_LIMITS.maxFiles;
const MAX_FILE_LIST_CHARS = MAX_FILES * 1_024 + (MAX_FILES - 1) * 2;
const SAFE_GIT_PATH_SEGMENT = /^[A-Za-z0-9._+@-]+$/;
const DISALLOWED_INPUT_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

function defaultFakeProvider(): FakeProvider {
  return Object.freeze({
    async send(request: FakeProviderRequest): Promise<FakeProviderResponse> {
      if (request.workflow === "inspect") {
        return Object.freeze({
          workflow: "inspect",
          summary: `这是本地 fake-provider 对任务“${request.task}”的模拟回复。未访问网络，也未读取或修改仓库文件。`,
        });
      }
      const file = request.files[0] ?? "synthetic/demo.ts";
      return Object.freeze({
        workflow: "patch",
        diff: `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-export const demo = false;\n+export const demo = true;\n`,
      });
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
    case "b": return "back";
    case "t": return "editTask";
    case "2": return "editPlan";
    case "f": return "editFiles";
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
  if (value === "t" || value === "task") return "editTask";
  if (value === "2" || value === "plan") return "editPlan";
  if (value === "f" || value === "files") return "editFiles";
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
  #pendingRaw: ((event: TerminalEvent | null) => void) | null = null;
  #pendingLine: ((event: TerminalEvent | null) => void) | null = null;
  #rawQueue: TerminalEvent[] = [];
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
    this.#keypressHandler = (text, key) => this.#dispatchRaw({ kind: "keypress", text, key });
    this.#endHandler = () => this.#closeInput();
    this.#resizeHandler = () => this.#draw();
    this.#lineCloseHandler = () => this.#closeInput();
    this.#lineSigintHandler = () => this.#dispatchLine({ kind: "keypress", text: "", key: { name: "escape" } });

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

  async readEvent(): Promise<TerminalEvent | null> {
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
        readline.question("> ", (answer) => this.#dispatchLine({ kind: "line", text: answer }));
      } catch {
        this.#dispatchLine(null);
      }
    });
  }

  async readAction(): Promise<TuiAction | null> {
    const event = await this.readEvent();
    if (!event) return null;
    return event.kind === "line" ? actionFromLine(event.text) : actionFromKeypress(event.key);
  }

  async readText(screen: string, label: string, prompt: string, initial: string, maxChars: number): Promise<string | null> {
    const characters = Array.from(initial);
    let cursor = characters.length;
    let notice = "";
    while (true) {
      const shown = `${characters.slice(0, cursor).join("")}|${characters.slice(cursor).join("")}`;
      const lines = [screen, "", `${label}：${visibleControls(shown)}`];
      if (notice) lines.push("", notice);
      this.show(lines.join("\n"), prompt);

      const event = await this.readEvent();
      if (!event) return null;
      if (event.kind === "line") {
        if (event.text.trim().toLowerCase() === ":cancel") return null;
        return event.text;
      }
      const { key, text } = event;
      if ((key.ctrl && key.name === "c") || key.name === "escape") return null;
      if (key.name === "return" || key.name === "enter") return characters.join("");
      if (key.name === "backspace") {
        if (cursor > 0) { characters.splice(cursor - 1, 1); cursor -= 1; }
        notice = "";
        continue;
      }
      if (key.name === "delete") {
        if (cursor < characters.length) characters.splice(cursor, 1);
        notice = "";
        continue;
      }
      if (key.name === "left") { cursor = Math.max(0, cursor - 1); continue; }
      if (key.name === "right") { cursor = Math.min(characters.length, cursor + 1); continue; }
      if (key.name === "home" || (key.ctrl && key.name === "a")) { cursor = 0; continue; }
      if (key.name === "end" || (key.ctrl && key.name === "e")) { cursor = characters.length; continue; }
      if (key.ctrl && key.name === "u") { characters.splice(0); cursor = 0; notice = ""; continue; }
      if (!text || DISALLOWED_INPUT_CONTROLS.test(text)) continue;
      const insertion = Array.from(text);
      if (characters.length + insertion.length > maxChars) {
        notice = `最多输入 ${maxChars} 个字符。`;
        continue;
      }
      characters.splice(cursor, 0, ...insertion);
      cursor += insertion.length;
      notice = "";
    }
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
    this.#input.pause();
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

  #dispatchRaw(event: TerminalEvent | null): void {
    if (this.#pendingRaw) {
      const resolve = this.#pendingRaw;
      this.#pendingRaw = null;
      resolve(event);
    } else if (event && !this.#closed) {
      this.#rawQueue.push(event);
    }
  }

  #dispatchLine(event: TerminalEvent | null): void {
    if (!this.#pendingLine) return;
    const resolve = this.#pendingLine;
    this.#pendingLine = null;
    resolve(event);
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

function menuScreen(selection: "inspect" | "patch", notice: string, siwcStatus: string): string {
  return [
    "Fake-provider TUI — 本地模拟，不会联网",
    "",
    notice ? `提示：${visibleControls(notice)}` : "选择演示流程：",
    `${selection === "inspect" ? ">" : " "} [I] 只读理解 (inspect)`,
    `${selection === "patch" ? ">" : " "} [P] 补丁审批与 diff (patch)`,
    "",
    ...siwcStatus.split("\n").map(visibleControls),
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

function scopeReviewScreen(request: FakeProviderRequest): string {
  return [
    "补丁计划与精确文件范围复核",
    "",
    `任务：${visibleControls(request.task)}`,
    `计划：${visibleControls(request.plan)}`,
    "批准的仓库相对路径：",
    ...request.files.map((file) => `  - ${visibleControls(file)}`),
    "",
    "可编辑任务、计划或文件范围；确认后仍需在完整请求预览中再次批准。",
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

async function editRequiredText(
  terminal: TuiTerminal,
  label: string,
  description: string,
  initial: string,
  maxChars: number,
): Promise<string | null> {
  let current = initial;
  let issue = "";
  while (true) {
    const screen = [description, issue].filter(Boolean).join("\n\n");
    const prompt = terminal.mode === "line"
      ? "输入完整字段；Enter 保存；输入 :cancel 取消本次编辑。"
      : "直接输入；Backspace/方向键可编辑；Enter 保存；Esc 取消本次编辑。";
    const value = await terminal.readText(screen, label, prompt, current, maxChars);
    if (value === null) return null;
    if (!value.trim()) {
      current = value;
      issue = "此项不能为空，请输入内容后按 Enter。";
      continue;
    }
    if (value.length > maxChars) {
      current = value;
      issue = `此项最多 ${maxChars} 个字符。`;
      continue;
    }
    if (DISALLOWED_INPUT_CONTROLS.test(value)) {
      current = value.replace(DISALLOWED_INPUT_CONTROLS, "");
      issue = "输入不能包含终端控制或方向格式字符。";
      continue;
    }
    return value.trim();
  }
}

function parseFileRange(value: string): readonly string[] {
  const rawFiles = value.split(",");
  if (!value.trim() || rawFiles.length === 0 || rawFiles.length > MAX_FILES) {
    throw new Error(`请输入 1–${MAX_FILES} 个精确文件路径，以逗号分隔。`);
  }
  const files = rawFiles.map((file) => file.trim());
  if (files.some((file) => !file)) throw new Error("文件范围不能包含空路径；请检查逗号分隔。 ");
  for (const file of files) {
    if (
      Buffer.byteLength(file, "utf8") > 1_024 ||
      !isSafeRepositoryPath(file) ||
      file.split("/").some((segment) => segment.length > 255 || !SAFE_GIT_PATH_SEGMENT.test(segment))
    ) {
      throw new Error(`不安全或不支持的仓库相对路径：${visibleControls(file)}`);
    }
  }
  try {
    return createApprovedFileScope(files).files;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "文件范围无效。");
  }
}

async function editFileRange(
  terminal: TuiTerminal,
  initial: readonly string[],
): Promise<readonly string[] | null> {
  let current = initial.join(", ");
  let issue = "";
  while (true) {
    const screen = [
      "输入合成演示仓库中的精确相对文件路径；不会检查或读取真实文件。",
      issue,
    ].filter(Boolean).join("\n\n");
    const prompt = terminal.mode === "line"
      ? "以逗号分隔多个路径；Enter 保存；输入 :cancel 取消本次编辑。"
      : "以逗号分隔多个路径；Enter 保存；Esc 取消本次编辑。";
    const value = await terminal.readText(screen, "文件范围", prompt, current, MAX_FILE_LIST_CHARS);
    if (value === null) return null;
    try {
      return parseFileRange(value);
    } catch (error) {
      current = value;
      issue = errorMessage(error);
    }
  }
}

function makeRequest(
  kind: "inspect" | "patch",
  task: string,
  plan: string,
  files: readonly string[],
): FakeProviderRequest {
  const exactFiles = kind === "patch" ? createApprovedFileScope(files).files : Object.freeze([]);
  return Object.freeze({ workflow: kind, task, plan, files: exactFiles });
}

async function runWorkflow(terminal: TuiTerminal, kind: "inspect" | "patch", provider: FakeProvider): Promise<WorkflowRunResult> {
  const taskInput = await editRequiredText(
    terminal,
    "任务",
    "请输入本次 fake-provider 演示任务。任务会出现在完整请求预览中。",
    "",
    MAX_TASK_CHARS,
  );
  if (taskInput === null) return { kind: "menu" };
  let task: string = taskInput;

  let plan = "";
  let files: readonly string[] = Object.freeze([]);
  if (kind === "patch") {
    const editedPlan = await editRequiredText(
      terminal,
      "计划",
      `请输入具体 patch 计划（最多 ${MAX_PLAN_CHARS} 个字符）。`,
      "",
      MAX_PLAN_CHARS,
    );
    if (editedPlan === null) return { kind: "menu" };
    plan = editedPlan;
    const editedFiles = await editFileRange(terminal, []);
    if (editedFiles === null) return { kind: "menu" };
    files = editedFiles;
  }

  const workflow = new ApplicationStateMachine(kind);
  let request = makeRequest(kind, task, plan, files);
  if (kind === "patch") {
    let scopeAction: TuiAction | null = null;
    const scopeOutcome = await approvePatchScope(workflow, async () => {
      while (true) {
        request = makeRequest(kind, task, plan, files);
        const action = await choose(
          terminal,
          scopeReviewScreen(request),
          "Enter/Y 确认精确范围；T 修改任务；2 修改计划；F 修改文件；N/Esc 取消；Q 退出。",
          ["enter", "approve", "editTask", "editPlan", "editFiles", "cancel", "back", "quit"],
        );
        if (action === "editTask") {
          const edited = await editRequiredText(terminal, "任务", "修改 patch 任务。", task, MAX_TASK_CHARS);
          if (edited !== null) task = edited;
          continue;
        }
        if (action === "editPlan") {
          const edited = await editRequiredText(terminal, "计划", `修改具体 patch 计划（最多 ${MAX_PLAN_CHARS} 个字符）。`, plan, MAX_PLAN_CHARS);
          if (edited !== null) plan = edited;
          continue;
        }
        if (action === "editFiles") {
          const edited = await editFileRange(terminal, files);
          if (edited !== null) files = edited;
          continue;
        }
        scopeAction = action;
        return action === "enter" || action === "approve";
      }
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
    "请先检查完整 diff，再选择保留或丢弃（仅保留演示状态）。",
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
  terminal.show("Fake-provider TUI — 本地模拟，不会联网\n正在读取脱敏的 SIWC 授权状态…", menuPrompt());
  let pendingMenuAction: Promise<TuiAction | null> | null = terminal.readAction();
  const siwcStatus = await readSiwcTuiStatus(env);
  const provider = options.provider ?? defaultFakeProvider();
  let selection: "inspect" | "patch" = "inspect";
  let notice = "";
  let exit = false;
  try {
    while (!exit) {
      let action: TuiAction | null;
      if (pendingMenuAction) {
        terminal.show(menuScreen(selection, notice, siwcStatus), menuPrompt());
        action = await pendingMenuAction;
        pendingMenuAction = null;
      } else {
        action = await choose(
          terminal,
          menuScreen(selection, notice, siwcStatus),
          menuPrompt(),
          ["inspect", "patch", "enter", "up", "down", "quit", "cancel"],
        );
      }
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
