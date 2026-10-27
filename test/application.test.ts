import assert from "node:assert/strict";
import test from "node:test";
import {
  ApplicationStateMachine,
  approvePatchScope,
  createApprovedFileScope,
  requestAfterApproval,
} from "../src/application.js";

const request = Object.freeze({ destination: "https://provider.example/request", payload: "the exact previewed bytes" });

test("inspect cancellation is terminal and never invokes a provider", async () => {
  const workflow = new ApplicationStateMachine("inspect");
  let providerCalls = 0;
  const outcome = await requestAfterApproval(
    workflow,
    request,
    async () => false,
    { send: async () => { providerCalls += 1; return "unexpected"; } },
  );

  assert.deepEqual(outcome, { kind: "cancelled" });
  assert.equal(providerCalls, 0);
  assert.equal(workflow.stage, "cancelled");
});

test("approved request sends the same provider-neutral payload and advances through typed stages", async () => {
  const workflow = new ApplicationStateMachine("inspect");
  let received: typeof request | undefined;
  const outcome = await requestAfterApproval(
    workflow,
    request,
    async () => true,
    { send: async (payload) => { received = payload; return { status: 200 }; } },
  );

  assert.deepEqual(received, request);
  assert.deepEqual(outcome, { kind: "response", response: { status: 200 } });
  assert.equal(workflow.stage, "provider-responded");
  workflow.completeInspect();
  assert.equal(workflow.stage, "completed");
});

test("approval errors and provider errors fail closed without a false completed state", async () => {
  const approvalWorkflow = new ApplicationStateMachine("inspect");
  let approvalProviderCalls = 0;
  const approvalOutcome = await requestAfterApproval(
    approvalWorkflow,
    request,
    async () => { throw new Error("approval unavailable"); },
    { send: async () => { approvalProviderCalls += 1; return "unexpected"; } },
  );
  assert.equal(approvalOutcome.kind, "approval-failed");
  assert.equal(approvalProviderCalls, 0);
  assert.equal(approvalWorkflow.stage, "failed");

  const providerWorkflow = new ApplicationStateMachine("inspect");
  const providerOutcome = await requestAfterApproval(
    providerWorkflow,
    request,
    async () => true,
    { send: async () => { throw new Error("provider unavailable"); } },
  );
  assert.equal(providerOutcome.kind, "provider-failed");
  assert.equal(providerWorkflow.stage, "failed");
});

test("patch cannot request before explicit scope approval and must review before disposition", async () => {
  const workflow = new ApplicationStateMachine("patch");
  let providerCalls = 0;
  await assert.rejects(
    requestAfterApproval(workflow, request, async () => true, {
      send: async () => { providerCalls += 1; return "unexpected"; },
    }),
    /请求预览必须在适当的工作流阶段产生/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(workflow.stage, "awaiting-scope-approval");

  const scope = await approvePatchScope(workflow, async () => true);
  assert.deepEqual(scope, { kind: "approved" });
  const outcome = await requestAfterApproval(workflow, request, async () => true, {
    send: async () => "candidate",
  });
  assert.deepEqual(outcome, { kind: "response", response: "candidate" });
  assert.throws(() => workflow.finishPatch("kept"), /必须先展示完整 diff/);
  assert.throws(() => workflow.reviewDiff(), /候选补丁生成后复核/);
  workflow.candidateReady();
  workflow.reviewDiff();
  workflow.finishPatch("kept");
  assert.equal(workflow.stage, "kept");
});

test("declining patch scope cancels before request preview or provider access", async () => {
  const workflow = new ApplicationStateMachine("patch");
  const scopeOutcome = await approvePatchScope(workflow, async () => false);
  assert.deepEqual(scopeOutcome, { kind: "cancelled" });
  assert.equal(workflow.stage, "cancelled");
  assert.throws(() => workflow.previewRequest(), /请求预览必须/);
});

test("approved file scope is immutable, exact, and rejects empty or duplicate path sets", () => {
  const supplied = ["src/main.ts", "test/main.test.ts"];
  const scope = createApprovedFileScope(supplied);
  supplied.push("src/unapproved.ts");

  assert.deepEqual(scope.files, ["src/main.ts", "test/main.test.ts"]);
  assert.ok(scope.includes("src/main.ts"));
  assert.ok(!scope.includes("src/unapproved.ts"));
  assert.ok(Object.isFrozen(scope.files));
  assert.throws(() => createApprovedFileScope([]), /至少包含一个有效路径/);
  assert.throws(() => createApprovedFileScope(["src/main.ts", "src/main.ts"]), /不能包含重复路径/);
});
