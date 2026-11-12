// Card helpers shared by the inbox screen and the plugin server: the card title, how an ask is
// answered (its kind and choices), and the message the inbox sends into the session. The message is
// conversation text in the user's voice, not UI, so its language is a setting (see messages.ts).
// Structural types, so both core cards and RPC cards fit.
import { MESSAGES, type MessageLang } from "./messages.ts";

export interface ChoiceLike {
  label: string;
  effect?: string;
}

export interface AskLike {
  id: string;
  question: string;
  short?: string;
  options?: ChoiceLike[];
  recommended?: number;
  recommendation?: string;
  resolved: boolean;
  dropped?: boolean;
}

export interface CardLike {
  sessionId: string;
  sessionTitle: string | null;
  topic: string | null;
  asks: AskLike[];
  results: { id: string; label: string; resolved: boolean; dropped?: boolean }[];
  receipts: { id: string; title: string; resolved: boolean }[];
}

/** What a card holds: one ask, result or receipt (`item`), or null for an older card with several. */
export type SingleItem<C extends CardLike> =
  | { kind: "ask"; item: C["asks"][number] }
  | { kind: "result"; item: C["results"][number] }
  | { kind: "receipt"; item: C["receipts"][number] };

/** The one item a card holds; null for older multi-item cards (and cards with none). Replaced items do not count. */
export function singleItem<C extends CardLike>(card: C): SingleItem<C> | null {
  const asks = card.asks.filter((ask) => !ask.dropped);
  const results = card.results.filter((result) => !result.dropped);
  if (asks.length + results.length + card.receipts.length !== 1) return null;
  if (asks.length) return { kind: "ask", item: asks[0] };
  if (results.length) return { kind: "result", item: results[0] };
  return { kind: "receipt", item: card.receipts[0] };
}

/** An ask the agent wrote (q1, q2, …), not one the host filed (`perm:`, `err:`). */
export const isAgentAsk = (ask: { id: string }) => /^q\d+$/.test(ask.id);

/**
 * Card title: the agent's topic. Cards the host created (permission, failure, receipts) and
 * cards filed before topics existed fall back to the Paseo title, then the dispatched work.
 */
export function cardTitle(card: CardLike): string {
  return (
    card.topic?.trim() ||
    card.sessionTitle?.trim() ||
    card.receipts[0]?.title.trim() ||
    card.sessionId.slice(0, 8)
  );
}

/**
 * The page "Open session" opens for a card from an external host: the configured URL, with each
 * `{session}` replaced by the card's session id.
 */
export function externalSessionUrl(template: string, sessionId: string): string {
  return template.split("{session}").join(encodeURIComponent(sessionId));
}

/** What the user can pick: the agent's options, or an old free-text recommendation as one option. */
export function askChoices(ask: AskLike): ChoiceLike[] {
  if (ask.options?.length) return ask.options;
  if (ask.recommendation) return [{ label: ask.recommendation }];
  return [];
}

/** Index of the recommended choice, or null when the agent recommends none. */
export function recommendedChoice(ask: AskLike): number | null {
  if (ask.options?.length) {
    const index = ask.recommended;
    return index !== undefined && index >= 0 && index < ask.options.length ? index : null;
  }
  return ask.recommendation ? 0 : null;
}

/**
 * think (Decide): choices, none recommended. nod (Approve): a recommended choice, preselected.
 * plain: nothing to pick (host asks, old asks without a recommendation); answered in the session.
 */
export type AskKind = "think" | "nod" | "plain";

export function askKind(ask: AskLike): AskKind {
  if (!askChoices(ask).length) return "plain";
  return recommendedChoice(ask) === null ? "think" : "nod";
}

/** Asks in screen order: Decide (think and plain) first, then Approve (nod), each in filing order. */
export function screenOrder<T extends AskLike>(asks: readonly T[]): T[] {
  return [...asks.filter((ask) => askKind(ask) !== "nod"), ...asks.filter((ask) => askKind(ask) === "nod")];
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** The question as one line: `short`, or for old asks the question cut to 40 characters. */
export function questionLine(ask: AskLike): string {
  if (ask.short?.trim()) return collapse(ask.short);
  const chars = [...collapse(ask.question)];
  return chars.length > 40 ? `${chars.slice(0, 40).join("")}…` : chars.join("");
}

/** Picks: ask id → index into `askChoices(ask)`. */
export type Picks = Record<string, number>;

/** The agent's own asks still open on the card (not host asks, not replaced ones). */
export function openAgentAsks<T extends AskLike>(asks: readonly T[]): T[] {
  return asks.filter((ask) => !ask.resolved && !ask.dropped && isAgentAsk(ask));
}

/** `question → label (recommended)`, the way a pick reads in the message. */
function pickLine(ask: AskLike, index: number, lang: MessageLang): string {
  const label = collapse(askChoices(ask)[index]?.label ?? "");
  return MESSAGES[lang].pick(questionLine(ask), label, recommendedChoice(ask) === index);
}

/**
 * The message Send puts into the session, which closes the card. A card holding one ask sends the
 * question with the pick (or just the question when the user only wrote a reply), then the reply:
 *
 *   (Answer from the inbox to a question in "Docs site redesign"; this card is closed)
 *   Docs site: ship the new navigation? → Ship behind a flag (recommended)
 *   Keep the old sidebar for one release
 *
 * A result or receipt card sends the reply under a header naming it. Older multi-item cards send one
 * line per picked ask, then the asks left unanswered, then the reply (`composeListAnswer`).
 */
export function composeAnswerMessage(card: CardLike, picks: Picks, reply = "", lang: MessageLang = "en"): string {
  const text = reply.trim();
  const single = singleItem(card);
  const title = cardTitle(card);
  const say = MESSAGES[lang];
  if (single?.kind === "ask" && isAgentAsk(single.item)) {
    const ask = single.item;
    const index = picks[ask.id];
    const line = typeof index === "number" ? pickLine(ask, index, lang) : questionLine(ask);
    return [say.answerHeader(title), line, ...(text ? [text] : [])].join("\n");
  }
  if (single?.kind === "result") return [say.resultHeader(title, single.item.label), ...(text ? [text] : [])].join("\n");
  if (single?.kind === "receipt") return [say.receiptHeader(title, single.item.title), ...(text ? [text] : [])].join("\n");
  return composeListAnswer(card, picks, text, lang);
}

/**
 * Send on an older multi-item card: it lists the picks, names the asks left unanswered, and ends with
 * the user's reply, if any:
 *
 *   (Answers from the inbox to the card "Docs site redesign"; this card is closed)
 *   q2 Docs site: merge the redesign branches? → Merge now
 *   Not answered: q3 Docs site: archive the old blog posts? Ask again later if needed.
 *   Tell me before the release goes out
 */
function composeListAnswer(card: CardLike, picks: Picks, text: string, lang: MessageLang): string {
  const say = MESSAGES[lang];
  const order = screenOrder(openAgentAsks(card.asks));
  const lines = order.filter((ask) => typeof picks[ask.id] === "number").map((ask) => `${ask.id} ${pickLine(ask, picks[ask.id], lang)}`);
  const unanswered = order.filter((ask) => typeof picks[ask.id] !== "number");
  if (unanswered.length) lines.push(say.unanswered(unanswered.map((ask) => `${ask.id} ${questionLine(ask)}`)));
  return [say.listHeader(cardTitle(card)), ...lines, ...(text ? [text] : [])].join("\n");
}

/**
 * The message Dismiss puts into the session when the card still has an open ask: that the user skipped
 * it and the agent should not wait on it. Null when there is none (Dismiss is silent).
 *
 *   (Skipped in the inbox, a question in "Docs site redesign": Docs site: ship the new navigation?
 *   Don't wait for me; if you really need my decision, ask again separately.)
 */
export function composeSkipMessage(card: CardLike, lang: MessageLang = "en"): string | null {
  const say = MESSAGES[lang];
  const single = singleItem(card);
  if (single) {
    if (single.kind !== "ask" || !openAgentAsks([single.item]).length) return null;
    return say.skipOne(cardTitle(card), questionLine(single.item));
  }
  const skipped = screenOrder(openAgentAsks(card.asks));
  if (!skipped.length) return null;
  return say.skipList(cardTitle(card), skipped.map((ask) => `${ask.id} ${questionLine(ask)}`));
}
