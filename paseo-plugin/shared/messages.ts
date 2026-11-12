// The text the inbox sends into a session when the user answers, skips or discusses a card. It reads as the
// user's own words in that conversation, so it comes in the user's language: English by default,
// Chinese when the daemon runs with AGENT_INBOX_LANG=zh.

export type MessageLang = "en" | "zh";

/** The language a setting value names: `zh` (also `zh-CN`, `zh_TW`, …) is Chinese; anything else is English. */
export function messageLang(value: string | null | undefined): MessageLang {
  return /^zh(?:[-_]|$)/i.test(value?.trim() ?? "") ? "zh" : "en";
}

export interface MessageSet {
  /** First line when Send answers a card holding one ask. */
  answerHeader(topic: string): string;
  /** First line when Send replies to a result. */
  resultHeader(topic: string, label: string): string;
  /** First line when Send replies to returned work. */
  receiptHeader(topic: string, title: string): string;
  /** First line when Send answers an older card holding several items. */
  listHeader(topic: string): string;
  /** One answered ask: the question, the picked label, and whether it was the recommended one. */
  pick(question: string, label: string, recommended: boolean): string;
  /** The asks of an older card the user left unanswered. */
  unanswered(items: string[]): string;
  /** Dismiss on a card holding one ask. */
  skipOne(topic: string, question: string): string;
  /** Dismiss on an older card, naming every open ask. */
  skipList(topic: string, items: string[]): string;
  /** Discuss on an ask: explain it and the options, then wait. `line` is the ask's one line. */
  discussAsk(line: string): string;
  /** Discuss on a result or returned work: explain it, then wait. `line` is its label or title. */
  discussItem(line: string): string;
}

const EN_STOP = /[?.!…]$/;
const ZH_STOP = /[？?。]$/;

const en: MessageSet = {
  answerHeader: (topic) => `(Answer from the inbox to a question in "${topic}"; this card is closed)`,
  resultHeader: (topic, label) => `(Reply from the inbox to the result "${label}" in "${topic}"; this card is closed)`,
  receiptHeader: (topic, title) => `(Reply from the inbox to the returned work "${title}" in "${topic}"; this card is closed)`,
  listHeader: (topic) => `(Answers from the inbox to the card "${topic}"; this card is closed)`,
  pick: (question, label, recommended) => `${question} → ${label}${recommended ? " (recommended)" : ""}`,
  unanswered: (items) => {
    const list = items.join("; ");
    return `Not answered: ${list}${EN_STOP.test(list) ? "" : "."} Ask again later if needed.`;
  },
  skipOne: (topic, question) => {
    const stop = EN_STOP.test(question) ? "" : ".";
    return `(Skipped in the inbox, a question in "${topic}": ${question}${stop} Don't wait for me; if you really need my decision, ask again separately.)`;
  },
  skipList: (topic, items) => {
    const list = items.join("; ");
    const stop = EN_STOP.test(list) ? "" : ".";
    return `(Skipped in the inbox, the card "${topic}", not answered: ${list}${stop} Don't wait for me on these; if one really needs my decision, ask again separately.)`;
  },
  discussAsk: (line) =>
    `(From the inbox: I'd like to talk about "${line}" before deciding. In a few plain sentences, explain where it came from and the trade-offs of each option, then wait for me.)`,
  discussItem: (line) => `(From the inbox: I'd like to talk about "${line}". In a few plain sentences, explain where it came from, then wait for me.)`,
};

const zh: MessageSet = {
  answerHeader: (topic) => `（从队列回答「${topic}」的问题，这张卡已关闭）`,
  resultHeader: (topic, label) => `（从队列回复「${topic}」的结果「${label}」，这张卡已关闭）`,
  receiptHeader: (topic, title) => `（从队列回复「${topic}」的回执「${title}」，这张卡已关闭）`,
  listHeader: (topic) => `（从队列回答「${topic}」卡，这张卡已关闭）`,
  pick: (question, label, recommended) => {
    const join = /[？?]$/.test(question) ? "" : " ";
    return `${question}${join}→ ${label}${recommended ? "（推荐）" : ""}`;
  },
  unanswered: (items) => `没答的：${items.join("、")}；需要的话下次再问。`,
  skipOne: (topic, question) => {
    const stop = ZH_STOP.test(question) ? "" : "。";
    return `（从队列跳过「${topic}」的问题：${question}${stop}先不用等我；真需要我定，下次单独问。）`;
  },
  skipList: (topic, items) => {
    const list = items.join("；");
    const stop = ZH_STOP.test(list) ? "" : "。";
    return `（从队列跳过「${topic}」卡，没回答：${list}${stop}这些先不用等我；真需要我定，下次单独问。）`;
  },
  discussAsk: (line) => `（从队列：想先聊聊「${line}」再定。用几句白话讲清来龙去脉和各选项的利弊，然后等我。）`,
  discussItem: (line) => `（从队列：想先聊聊「${line}」。用几句白话讲清来龙去脉，然后等我。）`,
};

export const MESSAGES: Record<MessageLang, MessageSet> = { en, zh };
