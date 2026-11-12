// The overview's lineage: open cards grouped by the session that filed them, a child session nested
// under the session that started it. Pure, so the screen and the tests share it.
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
