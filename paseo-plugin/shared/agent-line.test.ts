import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentLine, providerIconKey, shortModel, tildify, trackParents } from "./agent-line.ts";
import type { QueueCard } from "./rpc.ts";

const base: QueueCard = {
  id: "c-1", host: "paseo", sessionId: "s-main", sessionTitle: "docs redesign", cwd: "/home/u", provider: "claude",
  model: "claude-opus-5-5", agent: null, topic: "Docs redesign", timeline: null, action: "a", summary: "s", context: "c",
  asks: [], results: [], receipts: [], state: "open", firstReadyAt: "2026-11-12T00:00:00Z", createdAt: "2026-11-12T00:00:00Z",
  updatedAt: "2026-11-12T00:00:00Z", doneAt: null, doneBy: null,
};
const ctx = (over: Partial<Parameters<typeof agentLine>[1]> = {}) => ({ cards: [base], sessionTitles: {}, childOf: {}, home: "/home/u", ...over });

describe("agent line", () => {
  it("uses the host's names: plan, model label, effort, main, workspace", () => {
    const card = { ...base, agent: { plan: "Claude Work", modelLabel: "Opus 5.5", effort: "high", effortLabel: "high", workspace: "docs-site" } };
    assert.deepEqual(agentLine(card, ctx()), { icon: "claude", items: ["Claude Work", "Opus 5.5", "high", "main"], workspace: "docs-site" });
  });

  it("falls back to the provider id, a shortened model id and the cwd with ~; omits a missing effort", () => {
    assert.deepEqual(agentLine({ ...base, cwd: "/home/u/docs-site" }, ctx()), {
      icon: "claude",
      items: ["claude", "Opus 5.5", "main"],
      workspace: "~/docs-site",
    });
    assert.equal(agentLine(base, ctx()).workspace, "~", "the home itself shows as ~");
  });

  it("a child names its parent by the parent's open card topic, else the parent session title", () => {
    const child = { ...base, id: "c-2", sessionId: "s-child", topic: "Link check", agent: { parentSessionId: "s-main" } };
    assert.equal(agentLine(child, ctx({ cards: [base, child] })).items.at(-1), "child of Docs redesign");
    const orphan = { ...child, agent: { parentSessionId: "s-gone" } };
    assert.equal(agentLine(orphan, ctx({ sessionTitles: { "s-gone": "Flaky CI" } })).items.at(-1), "child of Flaky CI");
  });

  it("falls back to dispatch tracks when the host gives no parent; an unknown dispatcher reads child", () => {
    const child = { ...base, sessionId: "s-child" };
    assert.equal(agentLine(child, ctx({ childOf: { "s-child": "s-main" } })).items.at(-1), "child of Docs redesign");
    assert.equal(agentLine(child, ctx({ childOf: { "s-child": null } })).items.at(-1), "child");
  });

  it("cards from an external host read like any other: their provider, model and a logo by provider", () => {
    const external = { ...base, host: "dsh" as const, provider: "acme-agent", model: "acme-large" };
    assert.deepEqual(agentLine(external, ctx()).items, ["acme-agent", "acme-large", "main"]);
    assert.equal(agentLine(external, ctx()).icon, null);
    assert.equal(agentLine({ ...external, provider: "codex" }, ctx()).icon, "codex");
  });
});

describe("agent line helpers", () => {
  it("picks a logo by provider id, or the built-in a profile extends; unknown gets none", () => {
    assert.equal(providerIconKey({ host: "paseo", provider: "claude-work" }), "claude");
    assert.equal(providerIconKey({ host: "paseo", provider: "opencode" }), "opencode");
    assert.equal(providerIconKey({ host: "paseo", provider: "codex" }), "codex");
    assert.equal(providerIconKey({ host: "paseo", provider: "pi-mistral-studio" }), null);
    assert.equal(providerIconKey({ host: "paseo", provider: null }), null);
  });

  it("shortens model ids", () => {
    assert.equal(shortModel("claude-opus-5-5"), "Opus 5.5");
    assert.equal(shortModel("claude-haiku-5-5"), "Haiku 5.5");
    assert.equal(shortModel("opencode-go/kimi-k3.1-pro"), "kimi-k3.1-pro");
    assert.equal(shortModel(null), null);
  });

  it("shows paths under home with ~", () => {
    assert.equal(tildify("/home/u/projects/docs", "/home/u/"), "~/projects/docs");
    assert.equal(tildify("/home/uv", "/home/u"), "/home/uv");
    assert.equal(tildify("/tmp/x", null), "/tmp/x");
  });

  it("finds a card's dispatcher from tracks: full or short child ids, latest wins, a self-reference is ignored", () => {
    const cards = [{ host: "paseo" as const, sessionId: "19c6a3c1-5607" }, { host: "paseo" as const, sessionId: "690534b5-4824" }];
    const tracks = [
      { host: "paseo" as const, childRef: "19c6a3c", parentSessionId: "p-old", startedAt: "2026-11-10T00:00:00Z" },
      { host: "paseo" as const, childRef: "19c6a3c1-5607", parentSessionId: "p-new", startedAt: "2026-11-11T00:00:00Z" },
      { host: "paseo" as const, childRef: "690534b5-4824", parentSessionId: "690534b5-4824", startedAt: "2026-11-11T00:00:00Z" },
    ];
    assert.deepEqual(trackParents(cards, tracks), { "19c6a3c1-5607": "p-new" });
  });
});
