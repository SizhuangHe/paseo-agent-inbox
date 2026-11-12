// Reads Paseo session details for cards: snapshot fields and the last assistant paragraph.
import type { PaseoAgent, PaseoApi, PaseoProviderSnapshotResult } from "@getpaseo/client";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import type { AgentMeta, SessionSnapshot } from "agent-inbox-core";

const LOOKUP_TIMEOUT_MS = 5_000;
const PROVIDERS_TTL_MS = 10 * 60_000;
const WORKSPACE_TTL_MS = 60_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

interface Cached<T> {
  value: T;
  at: number;
}

/** Provider snapshots and workspace names per daemon connection, so a card filing costs no extra calls. */
const catalogs = new WeakMap<
  PaseoApi,
  { providers?: Cached<PaseoProviderSnapshotResult | null>; workspaces: Map<string, Cached<string | null>> }
>();

function catalogFor(paseo: PaseoApi) {
  let catalog = catalogs.get(paseo);
  if (!catalog) catalogs.set(paseo, (catalog = { workspaces: new Map() }));
  return catalog;
}

async function providerSnapshot(paseo: PaseoApi): Promise<PaseoProviderSnapshotResult | null> {
  const catalog = catalogFor(paseo);
  if (catalog.providers && Date.now() - catalog.providers.at < PROVIDERS_TTL_MS) return catalog.providers.value;
  const value = await withTimeout(paseo.providers.snapshot(), LOOKUP_TIMEOUT_MS);
  // A failed lookup is retried on the next filing rather than cached.
  if (value) catalog.providers = { value, at: Date.now() };
  return value ?? catalog.providers?.value ?? null;
}

async function workspaceName(paseo: PaseoApi, workspaceId: string): Promise<string | null> {
  const catalog = catalogFor(paseo);
  const hit = catalog.workspaces.get(workspaceId);
  if (hit && Date.now() - hit.at < WORKSPACE_TTL_MS) return hit.value;
  const workspace = await withTimeout(paseo.workspaces.ref(workspaceId).refresh(), LOOKUP_TIMEOUT_MS);
  const value = workspace?.name || null;
  catalog.workspaces.set(workspaceId, { value, at: Date.now() });
  return value;
}

interface ModelInfo {
  label: string | null;
  thinking: { id: string; label: string }[];
}

/** A provider's display name and one of its models, from either form of the provider snapshot. */
export function providerInfo(
  snapshot: PaseoProviderSnapshotResult | null,
  provider: string,
  model: string | null,
): { label: string | null; model: ModelInfo | null } {
  if (!snapshot) return { label: null, model: null };
  const entry = snapshot.entries.find((e) => e.provider === provider);
  const matches = (m: { id: string; aliases?: string[] }) => model !== null && (m.id === model || !!m.aliases?.includes(model));
  let info: ModelInfo | null = null;
  const full = entry?.models?.find(matches);
  if (full) {
    info = { label: full.label || null, thinking: full.thinkingOptions ?? [] };
  } else if (snapshot.compactSnapshot) {
    const packed = snapshot.compactSnapshot;
    const found = packed.entries.find((e) => e.provider === provider)?.models?.find(matches);
    if (found) {
      const set = found.thinkingSet === undefined ? undefined : packed.thinkingSets[found.thinkingSet];
      info = { label: found.label || null, thinking: set?.options ?? [] };
    }
  }
  const label = entry?.label || snapshot.compactSnapshot?.entries.find((e) => e.provider === provider)?.label || null;
  return { label, model: info };
}

/**
 * Who the agent is, in Paseo's own words: the provider's display name (the plan, e.g. "Claude Work"),
 * the model label, the effort it runs at, its parent session and its workspace name.
 */
export async function agentMeta(paseo: PaseoApi, agent: PaseoAgent): Promise<AgentMeta> {
  const model = agent.runtimeInfo?.model || agent.model || null;
  // The effective option is the one the session runs at; `thinkingOptionId` is only an explicit choice.
  const effort = agent.effectiveThinkingOptionId ?? agent.thinkingOptionId ?? null;
  const [providers, workspace] = await Promise.all([
    providerSnapshot(paseo),
    agent.workspaceId ? workspaceName(paseo, agent.workspaceId) : Promise.resolve(null),
  ]);
  const info = providerInfo(providers, agent.provider, model);
  return {
    plan: info.label,
    modelLabel: info.model?.label ?? null,
    effort,
    effortLabel: (effort && info.model?.thinking.find((o) => o.id === effort)?.label) || null,
    // Paseo labels an agent started from another session (`paseo run` reads PASEO_AGENT_ID) with its parent; not `--detach` runs.
    parentSessionId: agent.labels?.[PARENT_AGENT_ID_LABEL]?.trim() || null,
    workspace,
  };
}

/** Title, cwd, provider, model and agent meta of a Paseo agent; falls back to the hook payload. */
export async function sessionSnapshot(
  paseo: PaseoApi,
  agentId: string,
  fallback?: PluginHookAgent,
): Promise<SessionSnapshot> {
  const refreshed = await withTimeout(paseo.agents.ref(agentId).refresh(), LOOKUP_TIMEOUT_MS);
  const agent = refreshed?.agent;
  if (agent) {
    const meta = await agentMeta(paseo, agent);
    return {
      sessionTitle: agent.title ?? fallback?.title ?? null,
      cwd: agent.cwd ?? fallback?.cwd ?? null,
      provider: agent.provider ?? fallback?.provider ?? null,
      model: agent.runtimeInfo?.model || agent.model || null,
      agent: { ...meta, parentSessionId: meta.parentSessionId ?? fallback?.parentAgentId ?? null },
    };
  }
  if (!fallback) return {};
  return {
    sessionTitle: fallback.title,
    cwd: fallback.cwd,
    provider: fallback.provider,
    ...(fallback.parentAgentId ? { agent: { parentSessionId: fallback.parentAgentId } } : {}),
  };
}

/** Assistant text after the latest user message; tool calls between messages start a new paragraph. */
export function latestAssistantText(items: readonly AgentTimelineItem[]): string {
  let text = "";
  let gap = false;
  for (const item of items) {
    if (item.type === "user_message") {
      text = "";
      gap = false;
    } else if (item.type === "assistant_message") {
      if (gap && text) text += "\n\n";
      text += item.text;
      gap = false;
    } else if (item.type !== "reasoning") {
      gap = true;
    }
  }
  return text.trim();
}

/** The last non-empty paragraph of a text. */
export function lastParagraph(text: string): string {
  const blocks = text
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  return blocks.at(-1) ?? "";
}

/** The child's last paragraph, read from the tail of its timeline. */
export async function lastAssistantParagraph(paseo: PaseoApi, agentId: string): Promise<string> {
  const page = await withTimeout(
    paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200 }),
    LOOKUP_TIMEOUT_MS * 2,
  );
  if (!page) return "";
  return lastParagraph(latestAssistantText(page.entries.map((entry) => entry.item)));
}

/** Session titles by id, cached briefly so the polling list does not hit the daemon each time. */
export class TitleCache {
  #entries = new Map<string, { title: string | null; at: number }>();
  #ttlMs: number;

  constructor(ttlMs = 60_000) {
    this.#ttlMs = ttlMs;
  }

  async get(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const hit = this.#entries.get(agentId);
    if (hit && Date.now() - hit.at < this.#ttlMs) return hit.title;
    const refreshed = await withTimeout(paseo.agents.ref(agentId).refresh(), LOOKUP_TIMEOUT_MS);
    const title = refreshed?.agent?.title ?? null;
    this.#entries.set(agentId, { title, at: Date.now() });
    return title;
  }
}
