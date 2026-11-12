// Send: the user's answer and reply go into the card's session as one message, as if the user had
// typed it there. A card holds one thing for the user, so Send answers that one ask (or replies to that
// result) and closes only that card, done by the user; the session's other cards stay. Older cards
// with several items send every pick at once and close with all of them (open permission requests excepted).
import { QueueInputError } from "agent-inbox-core";
import type { Card, Queue } from "agent-inbox-core";
import { askChoices, askKind, composeAnswerMessage, composeDiscussMessage, composeSkipMessage, type Picks } from "../shared/cards.ts";
import type { MessageLang } from "../shared/messages.ts";

export interface AnswerDeps {
  queue: Queue;
  /** Sends text into a Paseo session as a user message. */
  send(sessionId: string, text: string): Promise<void>;
  /** Language of the messages sent into sessions; English when left out. */
  lang?: MessageLang;
}

/** Checks the picks and reply against the card. */
function checkAnswer(card: Card, picks: Picks, reply: string): void {
  const ids = Object.keys(picks);
  if (card.state !== "open") throw new QueueInputError(["This card is already closed"]);
  if (card.host !== "paseo") throw new QueueInputError(["Only Paseo cards can be answered from the inbox; answer in the session"]);
  if (!ids.length && !reply.trim()) throw new QueueInputError(["Nothing to send: pick an answer or write a reply"]);
  const issues: string[] = [];
  for (const id of ids) {
    const ask = card.asks.find((candidate) => candidate.id === id && !candidate.dropped);
    const index = picks[id];
    if (!ask) issues.push(`${id} is not on this card`);
    else if (ask.resolved) issues.push(`${id} is already answered`);
    else if (askKind(ask) === "plain") issues.push(`${id} has no options; answer in the session`);
    else if (!Number.isInteger(index) || index < 0 || index >= askChoices(ask).length) issues.push(`${id} has no option ${index + 1}`);
  }
  if (issues.length) throw new QueueInputError(issues);
}

/** Sends the answers and reply, then closes the card. Returns the card as it is afterwards. */
export async function answerCard(deps: AnswerDeps, cardId: string, picks: Picks, reply = ""): Promise<Card> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  checkAnswer(card, picks, reply);
  await deps.send(card.sessionId, composeAnswerMessage(card, picks, reply, deps.lang));
  // The session may have closed the card while the message was on its way; the answers are sent either way.
  const now = deps.queue.get(cardId);
  return now && now.state === "open" ? deps.queue.handBack(cardId) : (now ?? card);
}

/**
 * Dismiss and Seen: close the card. A Paseo ask card first tells its session the ask was skipped (an
 * older card names every open ask); if that send fails, the error propagates and the card stays open.
 * Results, receipts and errors close silently. Open permission requests stay open (the session is
 * blocked on them), and so does an older card holding one until it is answered.
 */
export async function dismissCard(deps: AnswerDeps, cardId: string): Promise<Card> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  if (card.state !== "open") return card;
  const message = card.host === "paseo" ? composeSkipMessage(card, deps.lang) : null;
  if (message) await deps.send(card.sessionId, message);
  const now = deps.queue.get(cardId);
  return now && now.state === "open" ? deps.queue.handBack(cardId) : (now ?? card);
}

/**
 * Discuss: the user wants to talk the card over in its session first. One message asks the agent to
 * explain it in plain words and wait; then the card is tagged `discussingAt` and stays open (the agent
 * closes it once the user decides there). On a card already tagged nothing is sent again. If the send
 * fails, the error propagates and the card stays untagged. `sent` says whether a message went out.
 */
export async function discussCard(deps: AnswerDeps, cardId: string): Promise<{ card: Card; sent: boolean }> {
  const card = deps.queue.get(cardId);
  if (!card) throw new QueueInputError([`unknown card ${cardId}`]);
  if (card.state !== "open") throw new QueueInputError(["This card is already closed"]);
  if (card.host !== "paseo") throw new QueueInputError(["Only Paseo cards can be discussed from the inbox; open the session"]);
  const message = composeDiscussMessage(card, deps.lang);
  if (message === null) throw new QueueInputError(["Permission requests, failed turns and older cards have no Discuss"]);
  if (card.discussingAt) return { card, sent: false };
  await deps.send(card.sessionId, message);
  return { card: deps.queue.markDiscussing(cardId), sent: true };
}
