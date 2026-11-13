import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PaseoAgent, PaseoApi, PaseoProviderSnapshotResult } from "./host.ts";
import { agentMeta, providerInfo, sessionSnapshot } from "./session.ts";

const thinking = [
  { id: "high", label: "high" },
  { id: "xhigh", label: "xhigh" },
];
// Shaped like `paseo provider ls` / `provider models`: profiles carry their own label.
const SNAPSHOT = {
  entries: [
    { provider: "claude", status: "available", enabled: true, label: "Claude", models: [{ provider: "claude", id: "claude-opus-5-5", label: "Opus 5.5", thinkingOptions: thinking }] },
    { provider: "claude-work", status: "available", enabled: true, label: "Claude Work", models: [{ provider: "claude-work", id: "claude-opus-5-5", label: "Opus 5.5", thinkingOptions: thinking }] },
  ],
  generatedAt: "2026-11-12T00:00:00Z",
  requestId: "r",
} as unknown as PaseoProviderSnapshotResult;

const COMPACT = {
  entries: [{ provider: "opencode", status: "available", enabled: true, label: "OpenCode" }],
  compactSnapshot: {
    entries: [{ provider: "opencode", status: "available", enabled: true, label: "OpenCode", models: [{ id: "opencode-go/kimi-k3.1-pro", label: "Kimi K3.1 Pro", thinkingSet: 0 }] }],
    thinkingSets: [{ options: [{ id: "default", label: "Default" }, { id: "high", label: "High" }] }],
  },
  generatedAt: "2026-11-12T00:00:00Z",
  requestId: "r",
} as unknown as PaseoProviderSnapshotResult;

function agent(over: Partial<PaseoAgent> = {}): PaseoAgent {
  return {
    id: "a-1", provider: "claude-work", cwd: "/home/u", workspaceId: "wks_1", model: "claude-opus-5-5",
    thinkingOptionId: null, effectiveThinkingOptionId: "xhigh", title: "Flaky CI", labels: {},
    ...over,
  } as unknown as PaseoAgent;
}

function fakePaseo(snapshot: PaseoProviderSnapshotResult, a: PaseoAgent) {
  const calls = { providers: 0, workspaces: 0 };
  const paseo = {
    providers: { snapshot: async () => (calls.providers++, snapshot) },
    workspaces: { ref: () => ({ refresh: async () => (calls.workspaces++, { name: "api-server" }) }) },
    agents: { ref: () => ({ refresh: async () => ({ agent: a }) }) },
  } as unknown as PaseoApi;
  return { paseo, calls };
}

describe("provider info", () => {
  it("reads the provider label, model label and thinking options from full entries", () => {
    const info = providerInfo(SNAPSHOT, "claude-work", "claude-opus-5-5");
    assert.equal(info.label, "Claude Work");
    assert.equal(info.model?.label, "Opus 5.5");
    assert.deepEqual(info.model?.thinking.map((o) => o.id), ["high", "xhigh"]);
  });

  it("reads models from the compact snapshot and its shared thinking sets", () => {
    const info = providerInfo(COMPACT, "opencode", "opencode-go/kimi-k3.1-pro");
    assert.equal(info.label, "OpenCode");
    assert.equal(info.model?.label, "Kimi K3.1 Pro");
    assert.equal(info.model?.thinking[1].label, "High");
  });

  it("knows nothing about an unknown provider or model", () => {
    assert.deepEqual(providerInfo(SNAPSHOT, "pi", "x"), { label: null, model: null });
    assert.equal(providerInfo(SNAPSHOT, "claude", "claude-unknown").model, null);
    assert.deepEqual(providerInfo(null, "claude", "claude-opus-5-5"), { label: null, model: null });
  });
});

describe("agent meta", () => {
  it("names plan, model, the effort the session runs at, the parent label and the workspace", async () => {
    const { paseo } = fakePaseo(SNAPSHOT, agent());
    const meta = await agentMeta(paseo, agent({ labels: { "paseo.parent-agent-id": "p-1" } }));
    assert.deepEqual(meta, {
      plan: "Claude Work",
      modelLabel: "Opus 5.5",
      effort: "xhigh",
      effortLabel: "xhigh",
      parentSessionId: "p-1",
      workspace: "api-server",
    });
  });

  it("omits effort when the session reports none and has no workspace without an id", async () => {
    const a = agent({ effectiveThinkingOptionId: null, thinkingOptionId: null, workspaceId: undefined });
    const { paseo, calls } = fakePaseo(SNAPSHOT, a);
    const meta = await agentMeta(paseo, a);
    assert.equal(meta.effort, null);
    assert.equal(meta.workspace, null);
    assert.equal(calls.workspaces, 0);
  });

  it("caches the provider snapshot and workspace names between filings", async () => {
    const a = agent();
    const { paseo, calls } = fakePaseo(SNAPSHOT, a);
    await sessionSnapshot(paseo, "a-1");
    const snap = await sessionSnapshot(paseo, "a-1");
    assert.equal(calls.providers, 1);
    assert.equal(calls.workspaces, 1);
    assert.equal(snap.agent?.plan, "Claude Work");
    assert.equal(snap.model, "claude-opus-5-5");
  });

  it("takes the parent from the hook payload when the agent has no parent label", async () => {
    const { paseo } = fakePaseo(SNAPSHOT, agent());
    const snap = await sessionSnapshot(paseo, "a-1", { id: "a-1", workspaceId: null, parentAgentId: "p-2", provider: "claude", cwd: "/home/u", title: null });
    assert.equal(snap.agent?.parentSessionId, "p-2");
  });
});
