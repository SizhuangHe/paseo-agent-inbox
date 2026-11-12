// Shapes of the queue's records. Field meanings are in DESIGN.md (Data model).

/**
 * `paseo` for Paseo sessions; `dsh` for cards filed from any other agent host through the CLI. The
 * value is stored in the database (a CHECK constraint) and in AGENT_QUEUE_SESSION, so it stays as is.
 */
export type Host = "paseo" | "dsh";
export type CardState = "open" | "done";
export type DoneBy = "agent" | "user";
export type TrackState = "running" | "returned" | "failed";
export type ReceiptStatus = "returned" | "failed";

/** Where a card or track comes from. Always taken from the host, never from agent input. */
export interface SessionIdentity {
  host: Host;
  sessionId: string;
}

/**
 * Which agent a card comes from, as the host reports it: display names rather than ids. Every field is
 * optional; the screen falls back to the raw provider, model and cwd.
 */
export interface AgentMeta {
  /** The host's display name for the provider, e.g. Paseo's "Claude Work" for a provider profile `claude-work`. */
  plan?: string | null;
  /** The model's display label, e.g. "Opus 5.5". */
  modelLabel?: string | null;
  /** The session's thinking option id and its label, e.g. "high". */
  effort?: string | null;
  effortLabel?: string | null;
  /** The session that started this one, when the host knows it. */
  parentSessionId?: string | null;
  /** The host's workspace (or project) display name. */
  workspace?: string | null;
}

/** Host session snapshot at filing time; refreshed on merge and after turns when a value is given. */
export interface SessionSnapshot {
  sessionTitle?: string | null;
  cwd?: string | null;
  provider?: string | null;
  model?: string | null;
  agent?: AgentMeta | null;
}

/** One answer the user can pick: a short button label and, optionally, what picking it does. */
export interface AskOption {
  label: string;
  effect?: string;
}

/** Fields an agent writes on an ask; `short`, `options`, `recommended` and `whyNow` are optional. */
export interface AskFields {
  /** The full question, shown when the ask is expanded. */
  question: string;
  /** The question in one line, naming the project and the thing. */
  short?: string;
  options?: AskOption[];
  /** Index into `options` of the recommended answer. */
  recommended?: number;
  /** Why the user should decide this now. */
  whyNow?: string;
  /** Free-text recommendation, from before `options` existed. */
  recommendation?: string;
  why?: string;
}

/** One answer a host permission request offers: allow or deny, under the host's own label and id. */
export interface PermissionChoice {
  id: string;
  label: string;
  behavior: "allow" | "deny";
}

/** One question of a host question request, answered with one of its option labels. */
export interface PermissionQuestion {
  header: string;
  question: string;
  options: string[];
}

/**
 * What a host permission ask (`perm:…`) offers, so the queue can answer it in place. Neither
 * `choices` nor `questions` means it can only be answered in the session.
 */
export interface HostPermission {
  /** The host's request id. */
  requestId: string;
  /** Tool, command, path or plan: the full request, shown when the ask is expanded. */
  detail?: string;
  choices?: PermissionChoice[];
  /** One pick per question; the last pick answers the request. */
  questions?: PermissionQuestion[];
}

export interface Ask extends AskFields {
  id: string;
  resolved: boolean;
  /** Replaced by a later filing of the session: kept (resolved) so ids are never reused, not shown. */
  dropped?: boolean;
  /** Host permission asks only. */
  permission?: HostPermission;
}

export interface Result {
  id: string;
  label: string;
  href?: string;
  note?: string;
  /** What to check there, in one line. */
  look?: string;
  resolved: boolean;
  /** Replaced by a later filing of the session: kept (resolved) so ids are never reused, not shown. */
  dropped?: boolean;
}

export interface Receipt {
  id: string;
  trackId?: string;
  title: string;
  status: ReceiptStatus;
  conclusion: string;
  /** The one-line version of `conclusion`. */
  line?: string;
  childRef?: string;
  resolved: boolean;
}

/** A step of the card's recall: `date` is M/D, e.g. 11/07. */
export interface TimelineStep {
  date?: string;
  text: string;
}

/** You asked → It did → Blocked: what the user asked, what the session did, where it waits for the user. */
export interface Timeline {
  asked: TimelineStep & { date: string };
  did: TimelineStep;
  stuck: { text: string };
}

export interface Card {
  id: string;
  host: Host;
  sessionId: string;
  sessionTitle: string | null;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  /** Null on cards filed before it existed and on cards from hosts that do not report it. */
  agent: AgentMeta | null;
  /** Short name of what the session is about; null only on cards filed before it existed. */
  topic: string | null;
  /** Null on cards filed without one (host cards, the CLI, cards from before it existed). */
  timeline: Timeline | null;
  action: string;
  summary: string;
  context: string;
  asks: Ask[];
  results: Result[];
  receipts: Receipt[];
  state: CardState;
  firstReadyAt: string;
  createdAt: string;
  updatedAt: string;
  doneAt: string | null;
  doneBy: DoneBy | null;
  /** The card a `replaces` filing put in this one's place; null unless this card was superseded. */
  supersededBy: string | null;
  /**
   * When the user pressed Discuss on the card (the session was asked to talk it over); null otherwise.
   * The card stays open until the session closes it or the user sends, sees or dismisses it.
   */
  discussingAt: string | null;
}

export interface Track {
  id: string;
  host: Host;
  /** Null when the dispatching session is unknown; the receipt then goes onto the child's own card. */
  parentSessionId: string | null;
  childRef: string | null;
  title: string;
  startedAt: string;
  state: TrackState;
  endedAt: string | null;
}

/** What an agent sends when it files a card. */
export type AskInput = AskFields;

export interface ResultInput {
  label: string;
  href?: string;
  note?: string;
  look?: string;
}

export interface ReceiptInput {
  trackId?: string;
  title: string;
  status: ReceiptStatus;
  conclusion: string;
  line?: string;
  childRef?: string;
}

/**
 * What an agent files: one card holds one thing for the user, so a filing carries exactly one of
 * `ask`, `result` or `receipt`. The older lists (`asks`, `results`, `receipts`) are still accepted and
 * split into one card per element, all with the filing's topic and timeline. `action`, `summary` and
 * `context` are required unless the filing has a `timeline`.
 */
export interface CardInput {
  topic: string;
  timeline?: Timeline;
  action?: string;
  summary?: string;
  context?: string;
  ask?: AskInput;
  result?: ResultInput;
  receipt?: ReceiptInput;
  /** An open card of the same session that this filing replaces: it closes, and the new card takes its place. */
  replaces?: string;
  asks?: AskInput[];
  results?: ResultInput[];
  receipts?: ReceiptInput[];
}

/** One thing for the user: what a card holds. */
export type ItemInput =
  | { kind: "ask"; ask: AskInput }
  | { kind: "result"; result: ResultInput }
  | { kind: "receipt"; receipt: ReceiptInput };

/** A validated filing: text fields a timeline stands in for are filled from it; one card per item. */
export interface ParsedCardInput {
  topic: string;
  timeline: Timeline | null;
  action: string;
  summary: string;
  context: string;
  items: ItemInput[];
  replaces: string | null;
}

/**
 * What `resolve` accepts: card ids (`cards`; `items` and `asks` are aliases that also take the item ids
 * of older multi-item cards), or `all` for every open card of the session.
 */
export interface ResolveInput {
  cards?: string[];
  items?: string[];
  asks?: string[];
  all?: boolean;
}

/** A validated resolve request: ids are card ids or item ids. */
export type ResolveRequest = { all: true } | { ids: string[] };

export interface TrackInput {
  title: string;
  childRef?: string;
}
