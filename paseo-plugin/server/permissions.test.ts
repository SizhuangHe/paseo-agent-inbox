import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { Queue } from "agent-inbox-core";
import { onPermissionBefore } from "./hooks.ts";
import { answerPermission, permissionInfo } from "./permissions.ts";

const SESSION = "agent-a";
const A = { host: "paseo", sessionId: SESSION } as const;

const bash: AgentPermissionRequest = {
  id: "req-1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  description: "Push the branch",
  input: { command: "git push origin main" },
};

const question: AgentPermissionRequest = {
  id: "req-2",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: {
    questions: [
      { header: "Branch", question: "Which branch?", options: [{ label: "main" }, { label: "dev", description: "the test one" }] },
      { header: "Push", question: "Push now?", options: [{ label: "Yes" }, { label: "No" }] },
    ],
  },
};

const plan: AgentPermissionRequest = {
  id: "req-3",
  provider: "claude",
  name: "ExitPlanMode",
  kind: "plan",
  metadata: { planText: "1. Do it" },
  actions: [
    { id: "reject", label: "Keep planning", behavior: "deny" },
    { id: "implement", label: "Implement", behavior: "allow", variant: "primary" },
  ],
};

/** A fake Paseo SDK: which requests are pending, and what the plugin answered. */
function fakePaseo(pending: AgentPermissionRequest[] | null) {
  const responses: { sessionId: string; requestId: string; response: AgentPermissionResponse }[] = [];
  const state = { pending, failNext: null as Error | null, clearOnFail: false };
  return {
    state,
    responses,
    pending: async () => state.pending,
    respond: async (sessionId: string, requestId: string, response: AgentPermissionResponse) => {
      if (state.failNext) {
        const error = state.failNext;
        state.failNext = null;
        if (state.clearOnFail) state.pending = [];
        throw error;
      }
      responses.push({ sessionId, requestId, response });
      state.pending = (state.pending ?? []).filter((request) => request.id !== requestId);
    },
  };
}

/** A card holding the permission ask the hook files for `request`. */
function cardWith(request: AgentPermissionRequest) {
  const queue = new Queue({ path: ":memory:" });
  const card = queue.addSystemAsk(
    A,
    {},
    { id: `perm:${request.id}`, question: `Permission: ${request.name}`, permission: permissionInfo(request) },
    { action: "Approve permission", summary: request.name, context: "The session is paused until this is answered." },
  );
  return { queue, card };
}

describe("permissionInfo", () => {
  it("offers Paseo's own buttons: Deny and Accept for a tool, the request's actions for a plan", () => {
    const tool = permissionInfo(bash);
    assert.deepEqual(tool.choices, [
      { id: "reject", label: "Deny", behavior: "deny" },
      { id: "accept", label: "Accept", behavior: "allow" },
    ]);
    assert.equal(tool.detail, "Bash\nPush the branch\ngit push origin main");
    assert.deepEqual(permissionInfo(plan).choices?.map((c) => c.label), ["Keep planning", "Implement"]);
    assert.equal(permissionInfo(plan).detail, "ExitPlanMode\n1. Do it");
  });

  it("offers one row of options per question, and nothing for multi-select questions", () => {
    assert.deepEqual(permissionInfo(question).questions, [
      { header: "Branch", question: "Which branch?", options: ["main", "dev"] },
      { header: "Push", question: "Push now?", options: ["Yes", "No"] },
    ]);
    assert.equal(permissionInfo(question).choices, undefined);
    const multi = { ...question, input: { questions: [{ header: "H", question: "Q?", options: [{ label: "a" }], multiSelect: true }] } };
    assert.deepEqual(permissionInfo(multi), { requestId: "req-2", detail: "AskUserQuestion" });
  });

  it("is stored on the ask the permission hook files", async () => {
    const queue = new Queue({ path: ":memory:" });
    const paseo = { agents: { ref: () => ({ refresh: async () => null }) } } as never;
    await onPermissionBefore(queue, { agent: { id: SESSION, workspaceId: null, parentAgentId: null, provider: "claude", cwd: "/tmp", title: "t" }, request: bash }, paseo);
    const ask = queue.openCards(A)[0]?.asks[0];
    assert.equal(ask?.id, "perm:req-1");
    assert.deepEqual(ask?.permission, permissionInfo(bash));
  });
});

describe("answerPermission", () => {
  it("answers a choice at once with the response Paseo's app sends, and resolves the ask", async () => {
    const { queue, card } = cardWith(bash);
    const paseo = fakePaseo([bash]);
    const result = await answerPermission({ queue, ...paseo }, card.id, "perm:req-1", { actionId: "accept" });
    assert.equal(result.outcome, "allowed");
    assert.deepEqual(paseo.responses, [{ sessionId: SESSION, requestId: "req-1", response: { behavior: "allow", selectedActionId: "accept" } }]);
    assert.equal(result.card?.state, "done", "the permission was the only item on the card");

    const denied = cardWith(bash);
    const again = fakePaseo([bash]);
    assert.equal((await answerPermission({ queue: denied.queue, ...again }, denied.card.id, "perm:req-1", { actionId: "reject" })).outcome, "denied");
    assert.deepEqual(again.responses[0].response, { behavior: "deny", selectedActionId: "reject", message: "Denied by user" });
  });

  it("answers a question request with one label per header, keeping the request's input", async () => {
    const { queue, card } = cardWith(question);
    const paseo = fakePaseo([question]);
    const result = await answerPermission({ queue, ...paseo }, card.id, "perm:req-2", { answers: { Branch: "dev", Push: "No" } });
    assert.equal(result.outcome, "sent");
    assert.deepEqual(paseo.responses[0].response, {
      behavior: "allow",
      updatedInput: { ...question.input, answers: { Branch: "dev", Push: "No" } },
    });
  });

  it("sends nothing for a request that is no longer pending, and resolves the ask", async () => {
    const { queue, card } = cardWith(bash);
    const paseo = fakePaseo([]);
    const result = await answerPermission({ queue, ...paseo }, card.id, "perm:req-1", { actionId: "accept" });
    assert.equal(result.outcome, "stale");
    assert.equal(paseo.responses.length, 0);
    assert.equal(queue.get(card.id)?.asks[0].resolved, true);

    const gone = cardWith(bash);
    const noSession = fakePaseo(null);
    assert.equal((await answerPermission({ queue: gone.queue, ...noSession }, gone.card.id, "perm:req-1", { actionId: "accept" })).outcome, "stale");
    assert.equal(noSession.responses.length, 0);
  });

  it("reports a request answered in the session while the response was on its way as stale", async () => {
    const { queue, card } = cardWith(bash);
    const paseo = fakePaseo([bash]);
    paseo.state.failNext = new Error("No pending permission request with id 'req-1'");
    paseo.state.clearOnFail = true;
    const result = await answerPermission({ queue, ...paseo }, card.id, "perm:req-1", { actionId: "accept" });
    assert.equal(result.outcome, "stale");
    assert.equal(queue.get(card.id)?.asks[0].resolved, true);
  });

  it("passes an error on and keeps the ask open while the request is still pending", async () => {
    const { queue, card } = cardWith(bash);
    const paseo = fakePaseo([bash]);
    paseo.state.failNext = new Error("daemon unreachable");
    await assert.rejects(answerPermission({ queue, ...paseo }, card.id, "perm:req-1", { actionId: "accept" }), /daemon unreachable/);
    assert.equal(queue.get(card.id)?.asks[0].resolved, false);
    assert.equal(queue.get(card.id)?.state, "open");
  });

  it("rejects answers the request does not offer, without responding", async () => {
    const { queue, card } = cardWith(question);
    const paseo = fakePaseo([question]);
    const reject = (answer: Parameters<typeof answerPermission>[3], pattern: RegExp) =>
      assert.rejects(answerPermission({ queue, ...paseo }, card.id, "perm:req-2", answer), pattern);
    await reject({ actionId: "accept" }, /not offered/);
    await reject({ answers: { Branch: "dev" } }, /No answer for "Push"/);
    await reject({ answers: { Branch: "prod", Push: "Yes" } }, /"prod" is not an option/);
    await assert.rejects(answerPermission({ queue, ...paseo }, card.id, "q1", { actionId: "accept" }), /no permission request q1/);
    assert.equal(paseo.responses.length, 0);
  });
});
