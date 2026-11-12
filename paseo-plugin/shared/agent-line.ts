// Which agent a card comes from, as one muted line under its title:
// [logo] plan · model · effort · role, then the workspace. Pure, so the server, the screen and the
// UI harness share it.
import type { QueueCard, QueueTrack } from "./rpc.ts";

/** Provider logos the screen can draw; anything else gets a neutral dot. */
export type ProviderIconKey = "claude" | "codex" | "opencode";
const ICON_KEYS: readonly string[] = ["claude", "codex", "opencode"];

/**
 * The logo for a card: its provider by id, or by the built-in it is a profile of when the id extends
 * one (`claude-work` is a profile of `claude`).
 */
export function providerIconKey(card: Pick<QueueCard, "host" | "provider">): ProviderIconKey | null {
  const id = card.provider ?? "";
  if (ICON_KEYS.includes(id)) return id as ProviderIconKey;
  const base = id.split("-")[0];
  return ICON_KEYS.includes(base) ? (base as ProviderIconKey) : null;
}

/** A model id made readable when the host gives no label: `claude-opus-5-5` → `Opus 5.5`. */
export function shortModel(id: string | null): string | null {
  if (!id) return null;
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (claude) return `${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  return id.slice(id.lastIndexOf("/") + 1);
}

/** A path with the home directory shown as ~ (the home itself is just ~). */
export function tildify(path: string | null, home: string | null): string | null {
  if (!path) return null;
  if (!home) return path;
  const root = home.replace(/\/+$/, "");
  if (path === root) return "~";
  return path.startsWith(`${root}/`) ? `~${path.slice(root.length)}` : path;
}

/** Card sessions started by a registered dispatch: session id → dispatching session (null if unknown). */
export function trackParents(
  cards: readonly Pick<QueueCard, "host" | "sessionId">[],
  tracks: readonly Pick<QueueTrack, "host" | "childRef" | "parentSessionId" | "startedAt">[],
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const card of cards) {
    const matches = tracks.filter(
      (t) =>
        t.host === card.host &&
        t.childRef !== null &&
        (t.childRef === card.sessionId || (t.childRef.length >= 7 && card.sessionId.startsWith(t.childRef))) &&
        t.parentSessionId !== card.sessionId,
    );
    if (!matches.length) continue;
    const latest = matches.reduce((a, b) => (b.startedAt > a.startedAt ? b : a));
    out[card.sessionId] = latest.parentSessionId;
  }
  return out;
}

export interface AgentLineContext {
  cards: readonly QueueCard[];
  sessionTitles: Record<string, string>;
  childOf: Record<string, string | null>;
  home: string | null;
}

export interface AgentLine {
  icon: ProviderIconKey | null;
  /** plan, model, effort, role: each shown whole, never broken mid-item. */
  items: string[];
  workspace: string | null;
}

export function agentLine(card: QueueCard, context: AgentLineContext): AgentLine {
  const meta = card.agent ?? {};
  const plan = meta.plan || card.provider;
  const model = meta.modelLabel || shortModel(card.model);
  const effort = meta.effortLabel || meta.effort;
  let role = "main";
  const labelled = meta.parentSessionId;
  const parent = labelled ?? context.childOf[card.sessionId];
  if (labelled || card.sessionId in context.childOf) {
    if (parent) {
      const parentCard = context.cards.find((c) => c.host === card.host && c.sessionId === parent);
      const name = parentCard?.topic || context.sessionTitles[parent] || parentCard?.sessionTitle || parent.slice(0, 8);
      role = `child of ${name}`;
    } else {
      role = "child";
    }
  }
  return {
    icon: providerIconKey(card),
    items: [plan, model, effort, role].filter((item): item is string => !!item),
    workspace: meta.workspace || tildify(card.cwd, context.home),
  };
}
