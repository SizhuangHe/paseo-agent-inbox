// The overview's lineage: open cards grouped by the session that filed them, a child session nested
// under the session that started it, and the sessions grouped by workspace; plus what a folded row
// says and which rows start folded. Pure, so the screen and the tests share it.
import { workspaceName } from "./agent-line.ts";
import { isPermissionAsk } from "./cards.ts";
import type { QueueCard } from "./rpc.ts";

export interface SessionGroup {
  /** `host:sessionId`. */
  key: string;
  host: QueueCard["host"];
  sessionId: string;
  /** The session's open cards, in queue order. */
  cards: QueueCard[];
  /** A parent with no open cards, shown (muted) only so its children have a header to sit under. */
  placeholder: boolean;
  /** The oldest `firstReadyAt` in the group, its children included; null for a placeholder without children. */
  oldest: string | null;
  /** Child sessions, one level deep: a grandchild sits beside its parent under the top session. */
  children: SessionGroup[];
}

type CardLike = Pick<QueueCard, "host" | "sessionId" | "firstReadyAt" | "updatedAt" | "agent">;

const keyOf = (host: string, sessionId: string) => `${host}:${sessionId}`;

/**
 * The session that started this one: the host's parent label on the session's latest card, else the
 * dispatch that registered it (`childOf`, from tracks). Null for a top-level session.
 */
function parentOf(cards: readonly CardLike[], childOf: Record<string, string | null>): string | null {
  const latest = cards.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const parent = latest.agent?.parentSessionId ?? childOf[latest.sessionId] ?? null;
  return parent && parent !== latest.sessionId ? parent : null;
}

const minIso = (values: (string | null)[]) =>
  values.reduce<string | null>((a, b) => (b !== null && (a === null || b < a) ? b : a), null);

/**
 * Groups open cards (in queue order) by session. Each session nests under the top of its parent chain;
 * a parent with no open cards gets a placeholder group. Groups, and children within a group, are
 * ordered by their oldest card's `firstReadyAt`.
 */
export function groupSessions<C extends QueueCard>(cards: readonly C[], childOf: Record<string, string | null>): SessionGroup[] {
  const own = new Map<string, SessionGroup>();
  for (const card of cards) {
    const key = keyOf(card.host, card.sessionId);
    let group = own.get(key);
    if (!group) {
      group = { key, host: card.host, sessionId: card.sessionId, cards: [], placeholder: false, oldest: null, children: [] };
      own.set(key, group);
    }
    group.cards.push(card);
  }
  const parents = new Map<string, string | null>();
  for (const group of own.values()) {
    const parent = parentOf(group.cards, childOf);
    parents.set(group.key, parent ? keyOf(group.host, parent) : null);
  }
  /**
   * The top of a group's parent chain: a session without a known parent, or one with no open cards.
   * A chain that loops back (bad labels) leaves the group at the top itself.
   */
  const topOf = (key: string): string => {
    const seen = new Set([key]);
    let current = key;
    for (;;) {
      const parent = parents.get(current) ?? null;
      if (!parent) return current;
      if (seen.has(parent)) return key;
      seen.add(parent);
      current = parent;
      if (!own.has(current)) return current;
    }
  };

  const tops = new Map<string, SessionGroup>();
  for (const group of own.values()) {
    const top = topOf(group.key);
    if (top === group.key) {
      tops.set(group.key, group);
      continue;
    }
    let parent = own.get(top) ?? tops.get(top);
    if (!parent) {
      const sessionId = top.slice(top.indexOf(":") + 1);
      parent = { key: top, host: group.host, sessionId, cards: [], placeholder: true, oldest: null, children: [] };
      tops.set(top, parent);
    }
    parent.children.push(group);
  }
  for (const group of own.values()) group.oldest = minIso(group.cards.map((card) => card.firstReadyAt));
  const byOldest = (a: SessionGroup, b: SessionGroup) => (a.oldest ?? "").localeCompare(b.oldest ?? "");
  for (const top of tops.values()) {
    top.children.sort(byOldest);
    top.oldest = minIso([top.oldest, ...top.children.map((child) => child.oldest)]);
  }
  return [...tops.values()].sort(byOldest);
}

/** The card a group's header speaks for: its most recently updated one (topic and agent are current there). */
export function latestCard<C extends Pick<QueueCard, "updatedAt">>(cards: readonly C[]): C | null {
  return cards.reduce<C | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
}

/** A workspace in the overview: the session groups whose session runs there. */
export interface WorkspaceGroup {
  /** The Paseo workspace name, else the cwd with home as ~; also its fold key. */
  name: string;
  /** Top-level session groups, children nested as `groupSessions` left them, in its order. */
  sessions: SessionGroup[];
  /** The oldest `firstReadyAt` of every card in it, children's included. */
  oldest: string | null;
}

/** The name for sessions whose cards carry neither a workspace nor a cwd. */
export const NO_WORKSPACE = "No workspace";

/**
 * Groups session groups (as `groupSessions` returns them) by workspace: the one on the session's
 * latest card, or for a placeholder parent on its children's latest card. A child stays under its
 * parent wherever it runs itself: lineage wins. Workspaces are ordered by their oldest card; sessions
 * keep their order inside.
 */
export function groupWorkspaces(groups: readonly SessionGroup[], home: string | null): WorkspaceGroup[] {
  const byName = new Map<string, WorkspaceGroup>();
  for (const group of groups) {
    const latest = latestCard(group.cards) ?? latestCard(group.children.flatMap((child) => child.cards));
    const name = (latest && workspaceName(latest, home)) || NO_WORKSPACE;
    let workspace = byName.get(name);
    if (!workspace) {
      workspace = { name, sessions: [], oldest: null };
      byName.set(name, workspace);
    }
    workspace.sessions.push(group);
    workspace.oldest = minIso([workspace.oldest, group.oldest]);
  }
  return [...byName.values()].sort((a, b) => (a.oldest ?? "").localeCompare(b.oldest ?? ""));
}

/** The most pressing thing under a row, for its one status dot: a pending permission, else a decision, else something to review or returned work. */
export type FoldStatus = "permission" | "decide" | "review";

/** What a workspace row or a folded session header says about the open cards under it. */
export interface FoldSummary {
  /** Top-level sessions; a child counts with its parent. */
  sessions: number;
  /** Open cards, children's included. */
  waiting: number;
  /** Pending permission requests. */
  permissions: number;
  oldest: string | null;
  /** Null when nothing is open. */
  status: FoldStatus | null;
}

/** Counts every open card under the groups, whether or not a fold hides it. */
export function summarize(groups: readonly SessionGroup[]): FoldSummary {
  const cards = groups.flatMap((group) => [...group.cards, ...group.children.flatMap((child) => child.cards)]);
  const asks = cards.flatMap((card) => card.asks.filter((ask) => !ask.resolved && !ask.dropped));
  const permissions = asks.filter(isPermissionAsk).length;
  const status: FoldStatus | null = permissions ? "permission" : asks.length ? "decide" : cards.length ? "review" : null;
  return { sessions: groups.length, waiting: cards.length, permissions, oldest: minIso(groups.map((group) => group.oldest)), status };
}

/** Up to this many open cards the overview starts expanded; above it every workspace starts folded. */
export const EXPANDED_UP_TO = 10;

export const workspaceFoldedByDefault = (openCards: number) => openCards > EXPANDED_UP_TO;

/** Fold keys: one namespace for workspaces (by name), one for sessions (by group key). */
export const workspaceFoldKey = (workspace: Pick<WorkspaceGroup, "name">) => `workspace:${workspace.name}`;
export const sessionFoldKey = (group: Pick<SessionGroup, "key">) => `session:${group.key}`;

/**
 * Whether a row is folded: what the user last chose for its key, else its default (a workspace by
 * the open-card count, a session header expanded).
 */
export function isFolded(chosen: ReadonlyMap<string, boolean>, key: string, byDefault: boolean): boolean {
  return chosen.get(key) ?? byDefault;
}
