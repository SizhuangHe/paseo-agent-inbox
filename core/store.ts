// The card store: one SQLite file (WAL) shared by the Paseo plugin and the CLI (and through it, other hosts).
// Every write runs in an IMMEDIATE transaction, so separate processes can share the file.
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCardInput, parseResolveInput, parseTrackInput, QueueInputError } from "./rules.ts";
import type {
  AgentMeta,
  HostPermission,
  Ask,
  Card,
  DoneBy,
  Host,
  ItemInput,
  Receipt,
  ReceiptInput,
  ReceiptStatus,
  Result,
  SessionIdentity,
  SessionSnapshot,
  Timeline,
  Track,
  TrackState,
} from "./types.ts";

export const DEFAULT_DB_PATH = join(homedir(), ".local", "share", "agent-queue", "queue.db");

/** `AGENT_QUEUE_DB` overrides the default location (another file, tests, dry runs). */
export function defaultDbPath(): string {
  return process.env.AGENT_QUEUE_DB || DEFAULT_DB_PATH;
}

/** Card for a dispatch that came back to a session that had no open card. */
export const RECEIPT_CARD_ACTION = "Review returned work";

/** Ask ids with a prefix belong to the host (permissions, errors); agent asks are q1, q2, ... */
export const SYSTEM_ASK_PREFIX = { permission: "perm:", error: "err:" } as const;

/** Per-card item ids, numbered from 1 within each type: asks q1, results r1, receipts p1. */
export const ITEM_ID_PREFIX = { ask: "q", result: "r", receipt: "p" } as const;

type Migration = string | ((db: DatabaseSync) => void);

const MIGRATIONS: readonly Migration[] = [
  `CREATE TABLE cards (
     id TEXT PRIMARY KEY,
     host TEXT NOT NULL CHECK (host IN ('paseo', 'dsh')),
     session_id TEXT NOT NULL,
     session_title TEXT,
     cwd TEXT,
     provider TEXT,
     model TEXT,
     action TEXT NOT NULL,
     summary TEXT NOT NULL,
     context TEXT NOT NULL,
     asks TEXT NOT NULL DEFAULT '[]',
     results TEXT NOT NULL DEFAULT '[]',
     receipts TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL CHECK (state IN ('open', 'done')),
     first_ready_at TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     done_at TEXT,
     done_by TEXT CHECK (done_by IN ('agent', 'user'))
   );
   CREATE UNIQUE INDEX cards_one_open_per_session ON cards (host, session_id) WHERE state = 'open';
   CREATE INDEX cards_queue_order ON cards (state, first_ready_at);
   CREATE TABLE tracks (
     id TEXT PRIMARY KEY,
     host TEXT NOT NULL CHECK (host IN ('paseo', 'dsh')),
     parent_session_id TEXT,
     child_ref TEXT,
     title TEXT NOT NULL,
     started_at TEXT NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('running', 'returned', 'failed')),
     ended_at TEXT
   );
   CREATE INDEX tracks_by_state ON tracks (state, started_at);`,
  // 2: agent-written topic; null on cards the host created and on cards filed before it existed.
  `ALTER TABLE cards ADD COLUMN topic TEXT;`,
  // 3: receipts get ids (p1, p2, ...) and results and receipts get `resolved`, inside the existing
  // JSON items. No schema change, so code from before this version keeps reading and writing the file.
  (db) => {
    const rows = db.prepare("SELECT id, results, receipts FROM cards").all() as unknown as Pick<CardRow, "id" | "results" | "receipts">[];
    const update = db.prepare("UPDATE cards SET results = ?, receipts = ? WHERE id = ?");
    for (const row of rows) {
      const results = JSON.stringify(withItemIds(JSON.parse(row.results), ITEM_ID_PREFIX.result));
      const receipts = JSON.stringify(withItemIds(JSON.parse(row.receipts), ITEM_ID_PREFIX.receipt));
      if (results !== row.results || receipts !== row.receipts) update.run(results, receipts, row.id);
    }
  },
  // 4: agent-written timeline (JSON), null when a card has none. A nullable column, like topic:
  // older code ignores it, its updates leave it as it is and its inserts leave it null.
  `ALTER TABLE cards ADD COLUMN timeline TEXT;`,
  // 5: the host's agent meta (JSON), a nullable column handled like timeline.
  `ALTER TABLE cards ADD COLUMN agent TEXT;`,
  // 6: one card per item. A session may have several open cards, so the one-open-card-per-session
  // index goes (older code still running reads the first open card it finds, and works on that one);
  // `superseded_by` names the card a `replaces` filing put in a card's place, null otherwise.
  `DROP INDEX IF EXISTS cards_one_open_per_session;
   CREATE INDEX IF NOT EXISTS cards_by_session ON cards (host, session_id, state);
   ALTER TABLE cards ADD COLUMN superseded_by TEXT;`,
];

interface CardRow {
  id: string;
  host: Host;
  session_id: string;
  session_title: string | null;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  agent: string | null;
  topic: string | null;
  timeline: string | null;
  action: string;
  summary: string;
  context: string;
  asks: string;
  results: string;
  receipts: string;
  state: "open" | "done";
  first_ready_at: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  done_by: DoneBy | null;
  superseded_by: string | null;
}

interface TrackRow {
  id: string;
  host: Host;
  parent_session_id: string | null;
  child_ref: string | null;
  title: string;
  started_at: string;
  state: TrackState;
  ended_at: string | null;
}

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    host: row.host,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    agent: row.agent ? (JSON.parse(row.agent) as AgentMeta) : null,
    topic: row.topic,
    timeline: row.timeline ? (JSON.parse(row.timeline) as Timeline) : null,
    action: row.action,
    summary: row.summary,
    context: row.context,
    asks: JSON.parse(row.asks) as Ask[],
    results: withItemIds(JSON.parse(row.results) as Partial<Result>[], ITEM_ID_PREFIX.result) as Result[],
    receipts: withItemIds(JSON.parse(row.receipts) as Partial<Receipt>[], ITEM_ID_PREFIX.receipt) as Receipt[],
    state: row.state,
    firstReadyAt: row.first_ready_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    doneAt: row.done_at,
    doneBy: row.done_by,
    supersededBy: row.superseded_by ?? null,
  };
}

function toTrack(row: TrackRow): Track {
  return {
    id: row.id,
    host: row.host,
    parentSessionId: row.parent_session_id,
    childRef: row.child_ref,
    title: row.title,
    startedAt: row.started_at,
    state: row.state,
    endedAt: row.ended_at,
  };
}

function newId(prefix: string): string {
  return `${prefix}-${randomBytes(5).toString("hex")}`;
}

function nextNumber(ids: readonly (string | undefined)[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    const match = new RegExp(`^${prefix}(\\d+)$`).exec(id ?? "");
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Gives items written without an id or `resolved` (before schema version 3, or by older code that
 * is still running) the next free id and `resolved: false`. Items are only ever appended, so ids
 * that come from array order stay the same on every read until a write stores them.
 */
function withItemIds<T extends { id?: string; resolved?: boolean }>(items: T[], prefix: string) {
  let next = nextNumber(items.map((item) => item.id), prefix);
  return items.map((item) => ({ ...item, id: item.id ?? `${prefix}${next++}`, resolved: item.resolved === true }));
}

/** A new card's items: the one item it holds, numbered 1 in its type (q1, r1, p1) unless an id is given. */
function itemBody(item: ItemInput, id?: string): Pick<Card, "asks" | "results" | "receipts"> {
  switch (item.kind) {
    case "ask":
      return { asks: [{ id: id ?? `${ITEM_ID_PREFIX.ask}1`, ...item.ask, resolved: false }], results: [], receipts: [] };
    case "result":
      return { asks: [], results: [{ id: id ?? `${ITEM_ID_PREFIX.result}1`, ...item.result, resolved: false }], receipts: [] };
    case "receipt":
      return { asks: [], results: [], receipts: [{ id: id ?? `${ITEM_ID_PREFIX.receipt}1`, ...item.receipt, resolved: false }] };
  }
}

/** The line that names an item for the user: an ask's `short` (else its question), a result's label, a receipt's title. */
function inputLine(item: ItemInput): string {
  if (item.kind === "ask") return (item.ask.short ?? item.ask.question).trim();
  return item.kind === "result" ? item.result.label : item.receipt.title;
}

/** The one item a card holds, or null for older cards with several (or none). Replaced items do not count. */
export function soleItem(
  card: Pick<Card, "asks" | "results" | "receipts">,
): { kind: "ask"; item: Ask } | { kind: "result"; item: Result } | { kind: "receipt"; item: Receipt } | null {
  const asks = card.asks.filter((a) => !a.dropped);
  const results = card.results.filter((r) => !r.dropped);
  if (asks.length + results.length + card.receipts.length !== 1) return null;
  if (asks.length) return { kind: "ask", item: asks[0] };
  if (results.length) return { kind: "result", item: results[0] };
  return { kind: "receipt", item: card.receipts[0] };
}

/** An open card the filing updates in place: it holds one agent item of the same kind under the same line. */
function sameItem(card: Card, item: ItemInput): boolean {
  const sole = soleItem(card);
  if (!sole || sole.kind !== item.kind || isSystemAsk(sole.item as Ask)) return false;
  const line =
    sole.kind === "ask" ? (sole.item.short ?? sole.item.question).trim() : sole.kind === "result" ? sole.item.label : sole.item.title;
  return line === inputLine(item);
}

function isSystemAsk(ask: Ask): boolean {
  return Object.values(SYSTEM_ASK_PREFIX).some((prefix) => ask.id.startsWith(prefix));
}

/** Every item on a card: asks, results, receipts. */
function cardItems(card: Pick<Card, "asks" | "results" | "receipts">): (Ask | Result | Receipt)[] {
  return [...card.asks, ...card.results, ...card.receipts];
}

/** A card with at least one item, all resolved, has nothing left for the user. */
function allResolved(card: Pick<Card, "asks" | "results" | "receipts">): boolean {
  const items = cardItems(card);
  return items.length > 0 && items.every((item) => item.resolved);
}

function resolveItems<T extends { id: string; resolved: boolean }>(items: T[], ids: ReadonlySet<string>): T[] {
  return items.map((item) => (ids.has(item.id) && !item.resolved ? { ...item, resolved: true } : item));
}

export interface QueueOptions {
  /** Database file; defaults to `defaultDbPath()`. `:memory:` works for tests. */
  path?: string;
  /** Clock, for tests. */
  now?: () => Date;
}

/** What a filing did with one item: a new card, an open card updated in place, or a new card in a replaced one's place. */
export interface Filing {
  card: Card;
  outcome: "created" | "updated" | "replaced";
  /** The card `replaces` closed, for `replaced`. */
  replaced: string | null;
}

export interface AddResult {
  /** One per item, in filing order: one for a filing with `ask`, `result` or `receipt`, one per element of the older lists. */
  cards: Filing[];
}

export interface ResolveResult {
  /** The cards the call named or touched, as they are now (closed ones included). */
  cards: Card[];
  /** The session's cards still open afterwards, in queue order. */
  open: Card[];
}

export interface ReturnTrackResult {
  track: Track;
  card: Card | null;
}

const NO_SNAPSHOT = { sessionTitle: null, cwd: null, provider: null, model: null, agent: null };

/** Open permission requests: the session is blocked on them, so only an answer (or the host) closes them. */
const pendingPermission = (item: Ask | Result | Receipt) => !item.resolved && item.id.startsWith(SYSTEM_ASK_PREFIX.permission);

export class Queue {
  readonly path: string;
  #db: DatabaseSync;
  #now: () => Date;
  #lastStamp = 0;

  constructor(options: QueueOptions = {}) {
    this.path = options.path ?? defaultDbPath();
    this.#now = options.now ?? (() => new Date());
    if (this.path !== ":memory:") mkdirSync(dirname(this.path), { recursive: true });
    this.#db = new DatabaseSync(this.path);
    this.#db.exec("PRAGMA busy_timeout = 5000");
    if (this.path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL");
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  // ---- cards ------------------------------------------------------------

  /**
   * Files an agent's filing: one card per item. With `replaces`, the named open card of the session
   * closes as superseded and the new card takes its place in the queue (its `firstReadyAt`). Otherwise
   * an open card of the session holding an item of the same kind under the same line (`short`, label,
   * title) is updated in place; else a new card opens.
   */
  add(identity: SessionIdentity, snapshot: SessionSnapshot, input: unknown): AddResult {
    const filing = parseCardInput(input);
    return this.#tx(() => {
      for (const item of filing.items) {
        const trackId = item.kind === "receipt" ? item.receipt.trackId : undefined;
        if (trackId && !this.#trackRow(trackId)) {
          throw new QueueInputError([`receipt: unknown trackId ${trackId}`]);
        }
      }
      const replaced = filing.replaces ? this.#replaceable(identity, filing.replaces) : null;
      const text = {
        topic: filing.topic,
        timeline: filing.timeline,
        action: filing.action,
        summary: filing.summary,
        context: filing.context,
      };
      const cards: Filing[] = [];
      for (const item of filing.items) {
        const now = this.#stamp();
        const siblings = this.#openCards(identity);
        const latest = siblings.reduce<Card | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
        const who = this.#snapshotFields(snapshot, latest ?? NO_SNAPSHOT);
        const same = replaced ? undefined : siblings.find((card) => sameItem(card, item));
        if (replaced) {
          const id = this.#insertCard(identity, who, now, { ...text, ...itemBody(item) }, replaced.firstReadyAt);
          this.#settle(replaced, "agent", now, id);
          cards.push({ card: this.#card(id), outcome: "replaced", replaced: replaced.id });
        } else if (same) {
          const sole = soleItem(same);
          this.#writeCard({ ...same, ...who, ...text, ...itemBody(item, sole?.item.id), updatedAt: now });
          cards.push({ card: this.#card(same.id), outcome: "updated", replaced: null });
        } else {
          const id = this.#insertCard(identity, who, now, { ...text, ...itemBody(item) });
          cards.push({ card: this.#card(id), outcome: "created", replaced: null });
        }
        if (item.kind === "receipt" && item.receipt.trackId) this.#endTrack(item.receipt.trackId, item.receipt.status, now);
      }
      return { cards };
    });
  }

  /**
   * The agent resolves what it handled: whole cards by id, or items of older multi-item cards by item id
   * (each card closes once every item on it is resolved); `all` closes every open card of the session.
   * Closing a whole card leaves open permission requests alone (the card closes when they are answered).
   * A named card that is already closed is left as it is. An unknown or ambiguous id rejects the whole call.
   */
  resolve(identity: SessionIdentity, input: unknown): ResolveResult {
    const request = parseResolveInput(input);
    return this.#tx(() => {
      const open = this.#openCards(identity);
      const now = this.#stamp();
      const touched: string[] = [];
      if ("all" in request) {
        for (const card of open) {
          this.#settle(card, "agent", now);
          touched.push(card.id);
        }
        return { cards: touched.map((id) => this.#card(id)), open: this.#openCards(identity) };
      }
      const whole = new Set<string>();
      const items = new Map<string, Set<string>>();
      const issues: string[] = [];
      for (const id of request.ids) {
        const named = this.get(id);
        if (named) {
          if (named.host !== identity.host || named.sessionId !== identity.sessionId) issues.push(`${id} is not a card of this session`);
          else if (named.state === "open") whole.add(id);
          else touched.push(id);
          continue;
        }
        const holders = open.filter((card) => cardItems(card).some((item) => item.id === id));
        if (holders.length === 1) items.set(holders[0].id, (items.get(holders[0].id) ?? new Set()).add(id));
        else if (holders.length > 1) issues.push(`${id} is on several open cards (${holders.map((c) => c.id).join(", ")}): pass card ids`);
        else issues.push(`unknown id ${id}`);
      }
      if (issues.length) {
        const known = open.map((card) => `${card.id} [${cardItems(card).map((item) => item.id).join(", ")}]`);
        throw new QueueInputError([...issues, `this session's open cards: ${known.join("; ") || "none"}`]);
      }
      for (const card of open) {
        if (whole.has(card.id)) {
          this.#settle(card, "agent", now);
          touched.push(card.id);
          continue;
        }
        const ids = items.get(card.id);
        if (!ids) continue;
        const next: Card = {
          ...card,
          asks: resolveItems(card.asks, ids),
          results: resolveItems(card.results, ids),
          receipts: resolveItems(card.receipts, ids),
          updatedAt: now,
        };
        this.#writeCard(allResolved(next) ? { ...next, state: "done", doneAt: now, doneBy: "agent" } : next);
        touched.push(card.id);
      }
      return { cards: touched.map((id) => this.#card(id)), open: this.#openCards(identity) };
    });
  }

  /**
   * The user is done with the card (Send, Seen or Dismiss): every open item is resolved and the card
   * closes as done by the user. Open permission requests are left alone: the session is still blocked
   * on them, so the card stays open until each is answered (then `resolveSystemAsks` closes it).
   */
  handBack(cardId: string): Card {
    return this.#tx(() => {
      const card = this.#card(cardId);
      if (card.state !== "open") throw new QueueInputError([`card ${cardId} is not open`]);
      this.#settle(card, "user", this.#stamp());
      return this.#card(cardId);
    });
  }

  /** `Later`: moves an open card to the tail of the queue. */
  snooze(cardId: string): Card {
    return this.#tx(() => {
      const card = this.#card(cardId);
      if (card.state !== "open") return card;
      const now = this.#stamp();
      this.#writeCard({ ...card, firstReadyAt: now, updatedAt: now });
      return this.#card(cardId);
    });
  }

  /** `Dismiss` (by: user) or an agent closing its card. Idempotent. */
  done(cardId: string, by: DoneBy): Card {
    return this.#tx(() => {
      const card = this.#card(cardId);
      if (card.state === "done") return card;
      const now = this.#stamp();
      this.#writeCard({ ...card, state: "done", doneAt: now, doneBy: by, updatedAt: now });
      return this.#card(cardId);
    });
  }

  get(cardId: string): Card | null {
    const row = this.#db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId) as CardRow | undefined;
    return row ? toCard(row) : null;
  }

  /** The session's open cards, in queue order. */
  openCards(identity: SessionIdentity): Card[] {
    return this.#openCards(identity);
  }

  /** The topic the session's agent wrote last, on any of its cards; null when it never wrote one. */
  sessionTopic(identity: SessionIdentity): string | null {
    const row = this.#db
      .prepare(
        "SELECT topic FROM cards WHERE host = ? AND session_id = ? AND topic IS NOT NULL ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(identity.host, identity.sessionId) as { topic: string } | undefined;
    return row?.topic ?? null;
  }

  /** Open cards in queue order (FIFO by firstReadyAt), or done cards newest first. */
  list(options: { state?: "open" | "done"; limit?: number } = {}): Card[] {
    const state = options.state ?? "open";
    const order = state === "open" ? "first_ready_at, created_at, rowid" : "done_at DESC, rowid DESC";
    const limit = options.limit ? ` LIMIT ${Math.max(1, Math.floor(options.limit))}` : "";
    const rows = this.#db
      .prepare(`SELECT * FROM cards WHERE state = ? ORDER BY ${order}${limit}`)
      .all(state) as unknown as CardRow[];
    return rows.map(toCard);
  }

  /** Refreshes the session snapshot on every open card of the session. Returns those cards. */
  refreshSnapshot(identity: SessionIdentity, snapshot: SessionSnapshot): Card[] {
    return this.#tx(() =>
      this.#openCards(identity).map((card) => {
        this.#writeCard({ ...card, ...this.#snapshotFields(snapshot, card) });
        return this.#card(card.id);
      }),
    );
  }

  // ---- host-owned asks (permissions, errors) -----------------------------

  /**
   * Files a host ask (id `perm:…` / `err:…`) as its own card, under the session's last topic; the same
   * ask filed again updates its card.
   */
  addSystemAsk(
    identity: SessionIdentity,
    snapshot: SessionSnapshot,
    ask: { id: string; question: string; permission?: HostPermission },
    fallback: { action: string; summary: string; context: string },
  ): Card {
    return this.#tx(() => {
      const now = this.#stamp();
      const open = this.#openCards(identity);
      const holder = open.find((card) => card.asks.some((a) => a.id === ask.id));
      if (holder) {
        const asks = holder.asks.map((a) => (a.id === ask.id ? { ...a, ...ask, resolved: false } : a));
        this.#writeCard({ ...holder, ...this.#snapshotFields(snapshot, holder), asks, updatedAt: now });
        return this.#card(holder.id);
      }
      const latest = open.reduce<Card | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
      const id = this.#insertCard(identity, this.#snapshotFields(snapshot, latest ?? NO_SNAPSHOT), now, {
        topic: this.sessionTopic(identity),
        timeline: null,
        ...fallback,
        asks: [{ ...ask, resolved: false }],
        results: [],
        receipts: [],
      });
      return this.#card(id);
    });
  }

  /** Resolves host asks on the session's open cards; each card closes once every item on it is resolved. */
  resolveSystemAsks(identity: SessionIdentity, match: { ids?: string[]; prefix?: string }): Card[] {
    return this.#tx(() => {
      const hit = (a: Ask) =>
        isSystemAsk(a) &&
        !a.resolved &&
        ((match.ids?.includes(a.id) ?? false) || (match.prefix ? a.id.startsWith(match.prefix) : false));
      const touched: Card[] = [];
      for (const card of this.#openCards(identity)) {
        if (!card.asks.some(hit)) continue;
        const now = this.#stamp();
        const asks = card.asks.map((a) => (hit(a) ? { ...a, resolved: true } : a));
        const nothingLeft = allResolved({ ...card, asks });
        this.#writeCard({
          ...card,
          asks,
          updatedAt: now,
          ...(nothingLeft ? { state: "done" as const, doneAt: now, doneBy: "agent" as const } : {}),
        });
        touched.push(this.#card(card.id));
      }
      return touched;
    });
  }

  // ---- tracks -----------------------------------------------------------

  /**
   * Registers dispatched work. `parentSessionId` is the dispatching session, or null when it is
   * unknown (then the receipt goes onto a card for the child session itself).
   */
  track(
    host: Host,
    parentSessionId: string | null,
    input: unknown,
    options: { startedAt?: string } = {},
  ): Track {
    const request = parseTrackInput(input);
    if (!parentSessionId && !request.childRef) {
      throw new QueueInputError(["a track without a parent session needs childRef"]);
    }
    return this.#tx(() => {
      const id = newId("t");
      const startedAt = options.startedAt ?? this.#stamp();
      this.#db
        .prepare(
          `INSERT INTO tracks (id, host, parent_session_id, child_ref, title, started_at, state, ended_at)
           VALUES (?, ?, ?, ?, ?, ?, 'running', NULL)`,
        )
        .run(id, host, parentSessionId, request.childRef ?? null, request.title, startedAt);
      return this.#track(id);
    });
  }

  getTrack(trackId: string): Track | null {
    const row = this.#trackRow(trackId);
    return row ? toTrack(row) : null;
  }

  listTracks(options: { state?: TrackState | "all" } = {}): Track[] {
    const state = options.state ?? "running";
    const rows = (
      state === "all"
        ? this.#db.prepare("SELECT * FROM tracks ORDER BY started_at, rowid").all()
        : this.#db.prepare("SELECT * FROM tracks WHERE state = ? ORDER BY started_at, rowid").all(state)
    ) as unknown as TrackRow[];
    return rows.map(toTrack);
  }

  /** Running tracks whose childRef is this agent id or a prefix of it (short ids from `paseo ls`). */
  runningTracksForChild(host: Host, agentId: string): Track[] {
    return this.listTracks({ state: "running" }).filter(
      (t) =>
        t.host === host &&
        t.childRef !== null &&
        (t.childRef === agentId || (t.childRef.length >= 7 && agentId.startsWith(t.childRef))),
    );
  }

  /**
   * Dispatched work came back: marks the track and files its receipt as a card of the dispatching
   * session (or the child's own session when the parent is unknown), under that session's last topic.
   * A track that already ended is left as it is.
   */
  returnTrack(
    trackId: string,
    outcome: { status: ReceiptStatus; conclusion: string },
    targetSnapshot: SessionSnapshot = {},
  ): ReturnTrackResult {
    return this.#tx(() => {
      const track = this.#track(trackId);
      if (track.state !== "running") return { track, card: null };
      const target = track.parentSessionId ?? track.childRef;
      if (!target) throw new QueueInputError([`track ${trackId} has neither parent nor childRef`]);
      const identity = { host: track.host, sessionId: target };
      const conclusion = outcome.conclusion.trim() || (outcome.status === "failed" ? "Failed" : "Done");
      const receipt: ReceiptInput = {
        trackId: track.id,
        title: track.title,
        status: outcome.status,
        conclusion,
        ...(track.childRef ? { childRef: track.childRef } : {}),
      };
      const now = this.#stamp();
      const open = this.#openCards(identity);
      const latest = open.reduce<Card | null>((a, b) => (!a || b.updatedAt > a.updatedAt ? b : a), null);
      const cardId = this.#insertCard(identity, this.#snapshotFields(targetSnapshot, latest ?? NO_SNAPSHOT), now, {
        topic: this.sessionTopic(identity),
        timeline: null,
        action: RECEIPT_CARD_ACTION,
        summary: conclusion,
        context: track.title,
        ...itemBody({ kind: "receipt", receipt }),
      });
      this.#endTrack(track.id, outcome.status, now);
      return { track: this.#track(track.id), card: this.#card(cardId) };
    });
  }

  // ---- internals --------------------------------------------------------

  #migrate(): void {
    const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const step = MIGRATIONS[index];
        if (typeof step === "string") this.#db.exec(step);
        else step(this.#db);
        this.#db.exec(`PRAGMA user_version = ${index + 1}`);
        this.#db.exec("COMMIT");
      } catch (error) {
        this.#db.exec("ROLLBACK");
        throw error;
      }
    }
  }

  #tx<T>(work: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.#db.exec("COMMIT");
      return value;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Strictly increasing timestamps within this process, so snooze always moves to the tail. */
  #stamp(): string {
    let ms = this.#now().getTime();
    if (ms <= this.#lastStamp) ms = this.#lastStamp + 1;
    this.#lastStamp = ms;
    return new Date(ms).toISOString();
  }

  #snapshotFields(snapshot: SessionSnapshot, current: Pick<Card, "sessionTitle" | "cwd" | "provider" | "model" | "agent">) {
    return {
      sessionTitle: snapshot.sessionTitle ?? current.sessionTitle,
      cwd: snapshot.cwd ?? current.cwd,
      provider: snapshot.provider ?? current.provider,
      model: snapshot.model ?? current.model,
      agent: snapshot.agent ?? current.agent,
    };
  }

  #openCards(identity: SessionIdentity): Card[] {
    const rows = this.#db
      .prepare("SELECT * FROM cards WHERE host = ? AND session_id = ? AND state = 'open' ORDER BY first_ready_at, created_at, rowid")
      .all(identity.host, identity.sessionId) as unknown as CardRow[];
    return rows.map(toCard);
  }

  /** An open card of the session that a filing may replace. */
  #replaceable(identity: SessionIdentity, cardId: string): Card {
    const card = this.get(cardId);
    if (!card || card.host !== identity.host || card.sessionId !== identity.sessionId) {
      throw new QueueInputError([`replaces: ${cardId} is not a card of this session`]);
    }
    if (card.state !== "open") {
      throw new QueueInputError([
        `replaces: card ${cardId} is already closed (answered, dismissed or resolved); file without replaces if this still needs the user`,
      ]);
    }
    if (card.asks.some(pendingPermission)) {
      throw new QueueInputError([`replaces: card ${cardId} waits on a permission request; it closes once that is answered`]);
    }
    return card;
  }

  /**
   * Closes a card as done by `by`: every item is resolved except open permission requests, which keep
   * the card open until they are answered. `supersededBy` records the card that took its place.
   */
  #settle(card: Card, by: DoneBy, now: string, supersededBy: string | null = null): void {
    const settled = new Set(cardItems(card).filter((item) => !pendingPermission(item)).map((item) => item.id));
    const waiting = card.asks.some(pendingPermission);
    this.#writeCard({
      ...card,
      asks: resolveItems(card.asks, settled),
      results: resolveItems(card.results, settled),
      receipts: resolveItems(card.receipts, settled),
      updatedAt: now,
      ...(waiting ? {} : { state: "done" as const, doneAt: now, doneBy: by, supersededBy: supersededBy ?? card.supersededBy }),
    });
  }

  #card(cardId: string): Card {
    const card = this.get(cardId);
    if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
    return card;
  }

  #trackRow(trackId: string): TrackRow | undefined {
    return this.#db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId) as TrackRow | undefined;
  }

  #track(trackId: string): Track {
    const row = this.#trackRow(trackId);
    if (!row) throw new QueueInputError([`unknown track ${trackId}`]);
    return toTrack(row);
  }

  #endTrack(trackId: string, status: ReceiptStatus, now: string): void {
    this.#db
      .prepare("UPDATE tracks SET state = ?, ended_at = ? WHERE id = ? AND state = 'running'")
      .run(status, now, trackId);
  }

  #insertCard(
    identity: SessionIdentity,
    snapshot: SessionSnapshot,
    now: string,
    body: Pick<Card, "topic" | "timeline" | "action" | "summary" | "context" | "asks" | "results" | "receipts">,
    firstReadyAt: string = now,
  ): string {
    const id = newId("c");
    this.#db
      .prepare(
        `INSERT INTO cards (id, host, session_id, session_title, cwd, provider, model, agent, topic, timeline, action,
           summary, context, asks, results, receipts, state, first_ready_at, created_at, updated_at, done_at, done_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL)`,
      )
      .run(
        id,
        identity.host,
        identity.sessionId,
        snapshot.sessionTitle ?? null,
        snapshot.cwd ?? null,
        snapshot.provider ?? null,
        snapshot.model ?? null,
        snapshot.agent ? JSON.stringify(snapshot.agent) : null,
        body.topic,
        body.timeline ? JSON.stringify(body.timeline) : null,
        body.action,
        body.summary,
        body.context,
        JSON.stringify(body.asks),
        JSON.stringify(body.results),
        JSON.stringify(body.receipts),
        firstReadyAt,
        now,
        now,
      );
    return id;
  }

  #writeCard(card: Card): void {
    this.#db
      .prepare(
        `UPDATE cards SET session_title = ?, cwd = ?, provider = ?, model = ?, agent = ?, topic = ?, timeline = ?, action = ?,
           summary = ?, context = ?, asks = ?, results = ?, receipts = ?, state = ?, first_ready_at = ?, updated_at = ?,
           done_at = ?, done_by = ?, superseded_by = ?
         WHERE id = ?`,
      )
      .run(
        card.sessionTitle,
        card.cwd,
        card.provider,
        card.model,
        card.agent ? JSON.stringify(card.agent) : null,
        card.topic,
        card.timeline ? JSON.stringify(card.timeline) : null,
        card.action,
        card.summary,
        card.context,
        JSON.stringify(card.asks),
        JSON.stringify(card.results),
        JSON.stringify(card.receipts),
        card.state,
        card.firstReadyAt,
        card.updatedAt,
        card.doneAt,
        card.doneBy,
        card.supersededBy,
        card.id,
      );
  }
}

export function openQueue(options: QueueOptions = {}): Queue {
  return new Queue(options);
}
