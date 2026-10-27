export type WorkflowKind = "inspect" | "patch";

export type WorkflowStage =
  | "ready"
  | "awaiting-scope-approval"
  | "scope-approved"
  | "request-previewed"
  | "request-approved"
  | "provider-requested"
  | "provider-responded"
  | "candidate-ready"
  | "diff-reviewed"
  | "completed"
  | "cancelled"
  | "failed"
  | "kept"
  | "discarded";

export interface Provider<Request, Response> {
  send(request: Request): Promise<Response>;
}

export type ApprovedRequestOutcome<Response> =
  | Readonly<{ kind: "response"; response: Response }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "approval-failed"; error: unknown }>
  | Readonly<{ kind: "provider-failed"; error: unknown }>;

export type ScopeApprovalOutcome =
  | Readonly<{ kind: "approved" }>
  | Readonly<{ kind: "cancelled" }>
  | Readonly<{ kind: "approval-failed"; error: unknown }>;

const TERMINAL_STAGES = new Set<WorkflowStage>([
  "completed",
  "cancelled",
  "failed",
  "kept",
  "discarded",
]);

export class ApplicationStateMachine {
  readonly kind: WorkflowKind;
  #stage: WorkflowStage;

  constructor(kind: WorkflowKind) {
    this.kind = kind;
    this.#stage = kind === "inspect" ? "ready" : "awaiting-scope-approval";
  }

  get stage(): WorkflowStage {
    return this.#stage;
  }

  approveScope(approved: boolean): void {
    this.#require(this.kind === "patch" && this.#stage === "awaiting-scope-approval", "文件范围只能在 patch 计划审批阶段决定。");
    this.#stage = approved ? "scope-approved" : "cancelled";
  }

  previewRequest(): void {
    const canPreview = this.kind === "inspect"
      ? this.#stage === "ready"
      : this.#stage === "scope-approved";
    this.#require(canPreview, "请求预览必须在适当的工作流阶段产生。");
    this.#stage = "request-previewed";
  }

  authorizeRequest(approved: boolean): void {
    this.#require(this.#stage === "request-previewed", "只有已展示的完整请求才能请求发送批准。");
    this.#stage = approved ? "request-approved" : "cancelled";
  }

  startProviderRequest(): void {
    this.#require(this.#stage === "request-approved", "未获明确批准，不得启动 provider 请求。");
    this.#stage = "provider-requested";
  }

  receiveProviderResponse(): void {
    this.#require(this.#stage === "provider-requested", "只能接收已启动 provider 请求的结果。");
    this.#stage = "provider-responded";
  }

  completeInspect(): void {
    this.#require(this.kind === "inspect" && this.#stage === "provider-responded", "inspect 只能在收到 provider 响应后完成。");
    this.#stage = "completed";
  }

  candidateReady(): void {
    this.#require(this.kind === "patch" && this.#stage === "provider-responded", "patch 候选只能在收到 provider 响应后生成。");
    this.#stage = "candidate-ready";
  }

  reviewDiff(): void {
    this.#require(this.kind === "patch" && this.#stage === "candidate-ready", "patch diff 只能在候选补丁生成后复核。");
    this.#stage = "diff-reviewed";
  }

  finishPatch(disposition: "kept" | "discarded" | "cancelled"): void {
    this.#require(this.kind === "patch" && this.#stage === "diff-reviewed", "patch 必须先展示完整 diff，再决定保留或丢弃。");
    this.#stage = disposition;
  }

  fail(): void {
    if (!TERMINAL_STAGES.has(this.#stage)) this.#stage = "failed";
  }

  #require(condition: boolean, message: string): asserts condition {
    if (!condition) throw new Error(message);
  }
}

export type ApprovedFileScope = Readonly<{
  files: readonly string[];
  includes: (path: string) => boolean;
}>;

export function createApprovedFileScope(files: readonly string[]): ApprovedFileScope {
  if (files.length === 0 || files.some((file) => typeof file !== "string" || file.length === 0)) {
    throw new Error("批准文件范围必须至少包含一个有效路径。");
  }
  const exactFiles = [...files];
  const allowed = new Set(exactFiles);
  if (allowed.size !== exactFiles.length) throw new Error("批准文件范围不能包含重复路径。");
  return Object.freeze({
    files: Object.freeze(exactFiles),
    includes: (candidate: string) => allowed.has(candidate),
  });
}

export async function approvePatchScope(
  workflow: ApplicationStateMachine,
  approve: () => Promise<boolean>,
): Promise<ScopeApprovalOutcome> {
  try {
    const approved = await approve();
    if (approved !== true && approved !== false) throw new TypeError("计划/文件审批回调返回无效值。");
    workflow.approveScope(approved);
    return approved ? { kind: "approved" } : { kind: "cancelled" };
  } catch (error) {
    workflow.fail();
    return { kind: "approval-failed", error };
  }
}

export async function requestAfterApproval<Request, Response>(
  workflow: ApplicationStateMachine,
  request: Request,
  approve: () => Promise<boolean>,
  provider: Provider<Request, Response>,
): Promise<ApprovedRequestOutcome<Response>> {
  workflow.previewRequest();
  let approved: boolean;
  try {
    const decision: unknown = await approve();
    if (decision !== true && decision !== false) throw new TypeError("发送审批回调返回无效值。");
    approved = decision;
  } catch (error) {
    workflow.fail();
    return { kind: "approval-failed", error };
  }

  workflow.authorizeRequest(approved);
  if (!approved) return { kind: "cancelled" };

  workflow.startProviderRequest();
  try {
    const response = await provider.send(request);
    workflow.receiveProviderResponse();
    return { kind: "response", response };
  } catch (error) {
    workflow.fail();
    return { kind: "provider-failed", error };
  }
}
