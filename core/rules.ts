// Input rules for agent-filed cards. The Paseo plugin builds its zod schemas from these
// constants and `countSentences`, so the tool and the CLI enforce the same rules.
import { homedir } from "node:os";
import type {
  AskInput,
  AskOption,
  ItemInput,
  ParsedCardInput,
  ReceiptInput,
  ReceiptStatus,
  ResolveInput,
  ResolveRequest,
  ResultInput,
  Timeline,
  TimelineStep,
  TrackInput,
} from "./types.ts";

export const LIMITS = {
  topicChars: 15,
  actionChars: 40,
  sentences: 3,
  textChars: 300,
  // The full question shows only when an ask is expanded; `short` is the line on screen.
  questionChars: 400,
  recommendationChars: 80,
  whyChars: 300,
  labelChars: 80,
  noteChars: 300,
  titleChars: 80,
  conclusionChars: 300,
} as const;

/**
 * Short fields the queue screen shows on one line, in display width (`displayWidth`): CJK and
 * other wide characters count 1, ASCII 0.5.
 */
export const WIDTHS = {
  timelineText: 18,
  stuckText: 20,
  short: 30,
  optionLabel: 12,
  optionEffect: 40,
  whyNow: 60,
  look: 22,
  line: 26,
} as const;

/** Timeline dates: M/D, e.g. 11/07 or 11/7. */
export const TIMELINE_DATE = /^(?:1[0-2]|0?[1-9])\/(?:3[01]|[12]\d|0?[1-9])$/;

export const RECEIPT_STATUSES: readonly ReceiptStatus[] = ["returned", "failed"];

export class QueueInputError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid queue input: ${issues.join("; ")}`);
    this.name = "QueueInputError";
    this.issues = issues;
  }
}

/** Length in characters as a reader counts them (code points, so CJK and emoji count once). */
export function charCount(text: string): number {
  return [...text].length;
}

/**
 * Width as text lays out on the queue screen: CJK, full-width and other wide characters count 1;
 * ASCII and other narrow characters (below U+2000, and half-width forms) count 0.5.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code < 0x2000 || (code >= 0xff61 && code <= 0xffdc) ? 0.5 : 1;
  }
  return width;
}

const SENTENCE_END = /[。！？!?]+["”’」』）)]*|\.(?=\s|$)/gu;

/** Number of sentences: text segments closed by 。！？!? or a period before whitespace / end. */
export function countSentences(text: string): number {
  let count = 0;
  let last = 0;
  for (const match of text.matchAll(SENTENCE_END)) {
    if (text.slice(last, match.index).trim()) count += 1;
    last = (match.index ?? 0) + match[0].length;
  }
  if (text.slice(last).trim()) count += 1;
  return count;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/** True for an http(s) URL. Any other scheme (javascript:, file:, vscode:, ...) is rejected. */
export function isHttpUrl(value: string): boolean {
  if (!HTTP_URL.test(value)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * A result link is an http(s) URL or an absolute path (`/…`, or `~/…` expanded to the home
 * directory). Anything else returns null and is rejected by validation, never dropped.
 */
export function normalizeHref(href: string): string | null {
  const value = href.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return isHttpUrl(value) ? value : null;
  if (value.startsWith("~/")) return homedir() + value.slice(1);
  if (value.startsWith("/")) return value;
  return null;
}

export function isHref(href: string): boolean {
  return normalizeHref(href) !== null;
}

type Issues = string[];
type Obj = Record<string, unknown>;

function isObject(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(value: Obj, allowed: readonly string[], path: string, issues: Issues) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path}${key}: unknown field`);
  }
}

function text(
  value: unknown,
  path: string,
  issues: Issues,
  rule: { maxChars?: number; maxWidth?: number; sentences?: number; singleLine?: boolean; optional?: boolean },
): string | undefined {
  if (value === undefined && rule.optional) return undefined;
  if (typeof value !== "string") {
    issues.push(`${path}: required text`);
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    if (rule.optional) return undefined;
    issues.push(`${path}: must not be empty`);
    return undefined;
  }
  if (rule.maxChars !== undefined && charCount(trimmed) > rule.maxChars) {
    issues.push(`${path}: at most ${rule.maxChars} characters`);
  }
  if (rule.maxWidth !== undefined && displayWidth(trimmed) > rule.maxWidth) {
    issues.push(`${path}: at most ${rule.maxWidth} wide (CJK 1, ASCII 0.5), is ${displayWidth(trimmed)}`);
  }
  if (rule.singleLine && /[\r\n]/.test(trimmed)) issues.push(`${path}: one line`);
  if (rule.sentences !== undefined && countSentences(trimmed) > rule.sentences) {
    issues.push(`${path}: at most ${rule.sentences} sentences`);
  }
  return trimmed;
}

function list<T>(
  value: unknown,
  path: string,
  issues: Issues,
  item: (entry: unknown, path: string) => T | undefined,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    issues.push(`${path}: must be a list`);
    return [];
  }
  const out: T[] = [];
  value.forEach((entry, index) => {
    const parsed = item(entry, `${path}[${index}]`);
    if (parsed) out.push(parsed);
  });
  return out;
}

function option(entry: unknown, path: string, issues: Issues): AskOption | undefined {
  if (!isObject(entry)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  rejectUnknownKeys(entry, ["label", "effect"], `${path}.`, issues);
  const label = text(entry.label, `${path}.label`, issues, { maxWidth: WIDTHS.optionLabel, singleLine: true });
  const effect = text(entry.effect, `${path}.effect`, issues, { maxWidth: WIDTHS.optionEffect, singleLine: true, optional: true });
  if (!label) return undefined;
  return { label, ...(effect ? { effect } : {}) };
}

function ask(entry: unknown, path: string, issues: Issues): AskInput | undefined {
  if (!isObject(entry)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  rejectUnknownKeys(
    entry,
    ["question", "short", "options", "recommended", "whyNow", "recommendation", "why"],
    `${path}.`,
    issues,
  );
  const question = text(entry.question, `${path}.question`, issues, { maxChars: LIMITS.questionChars });
  const short = text(entry.short, `${path}.short`, issues, { maxWidth: WIDTHS.short, singleLine: true, optional: true });
  const optionCount = issues.length;
  const options = list(entry.options, `${path}.options`, issues, (item, itemPath) => option(item, itemPath, issues));
  const optionsValid = issues.length === optionCount;
  let recommended: number | undefined;
  if (entry.recommended !== undefined) {
    const value = entry.recommended;
    if (!Number.isInteger(value)) issues.push(`${path}.recommended: an index into options (0, 1, …)`);
    else if (!options.length && optionsValid) issues.push(`${path}.recommended: needs options`);
    else if ((value as number) < 0 || (value as number) >= options.length) {
      if (optionsValid) issues.push(`${path}.recommended: an index into options, 0 to ${options.length - 1}`);
    } else recommended = value as number;
  }
  const whyNow = text(entry.whyNow, `${path}.whyNow`, issues, { maxWidth: WIDTHS.whyNow, optional: true });
  const recommendation = text(entry.recommendation, `${path}.recommendation`, issues, {
    maxChars: LIMITS.recommendationChars,
    optional: true,
  });
  const why = text(entry.why, `${path}.why`, issues, { maxChars: LIMITS.whyChars, optional: true });
  if (!question) return undefined;
  return {
    question,
    ...(short ? { short } : {}),
    ...(options.length ? { options } : {}),
    ...(recommended !== undefined ? { recommended } : {}),
    ...(whyNow ? { whyNow } : {}),
    ...(recommendation ? { recommendation } : {}),
    ...(why ? { why } : {}),
  };
}

function result(entry: unknown, path: string, issues: Issues): ResultInput | undefined {
  if (!isObject(entry)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  rejectUnknownKeys(entry, ["label", "href", "note", "look"], `${path}.`, issues);
  const label = text(entry.label, `${path}.label`, issues, { maxChars: LIMITS.labelChars, singleLine: true });
  const rawHref = text(entry.href, `${path}.href`, issues, { maxChars: 2000, optional: true, singleLine: true });
  const note = text(entry.note, `${path}.note`, issues, { maxChars: LIMITS.noteChars, optional: true });
  const look = text(entry.look, `${path}.look`, issues, { maxWidth: WIDTHS.look, singleLine: true, optional: true });
  let href: string | undefined;
  if (rawHref) {
    href = normalizeHref(rawHref) ?? undefined;
    if (!href) issues.push(`${path}.href: an http(s) URL or an absolute path (/… or ~/…)`);
  }
  if (!label) return undefined;
  return { label, ...(href ? { href } : {}), ...(note ? { note } : {}), ...(look ? { look } : {}) };
}

function receipt(entry: unknown, path: string, issues: Issues): ReceiptInput | undefined {
  if (!isObject(entry)) {
    issues.push(`${path}: must be an object`);
    return undefined;
  }
  rejectUnknownKeys(entry, ["trackId", "title", "status", "conclusion", "line", "childRef"], `${path}.`, issues);
  const title = text(entry.title, `${path}.title`, issues, { maxChars: LIMITS.titleChars, singleLine: true });
  const conclusion = text(entry.conclusion, `${path}.conclusion`, issues, {
    maxChars: LIMITS.conclusionChars,
    sentences: LIMITS.sentences,
  });
  const line = text(entry.line, `${path}.line`, issues, { maxWidth: WIDTHS.line, singleLine: true, optional: true });
  const trackId = text(entry.trackId, `${path}.trackId`, issues, { maxChars: 200, optional: true, singleLine: true });
  const childRef = text(entry.childRef, `${path}.childRef`, issues, { maxChars: 200, optional: true, singleLine: true });
  const status = entry.status;
  if (status !== "returned" && status !== "failed") {
    issues.push(`${path}.status: "returned" or "failed"`);
    return undefined;
  }
  if (!title || !conclusion) return undefined;
  return {
    ...(trackId ? { trackId } : {}),
    title,
    status,
    conclusion,
    ...(line ? { line } : {}),
    ...(childRef ? { childRef } : {}),
  };
}

function step(
  value: unknown,
  path: string,
  issues: Issues,
  rule: { date: "required" | "optional" | "none"; maxWidth: number },
): TimelineStep | undefined {
  if (!isObject(value)) {
    issues.push(`${path}: required, an object`);
    return undefined;
  }
  rejectUnknownKeys(value, rule.date === "none" ? ["text"] : ["date", "text"], `${path}.`, issues);
  const stepText = text(value.text, `${path}.text`, issues, { maxWidth: rule.maxWidth, singleLine: true });
  let date: string | undefined;
  if (rule.date !== "none") {
    date = text(value.date, `${path}.date`, issues, { singleLine: true, optional: rule.date === "optional" });
    if (date && !TIMELINE_DATE.test(date)) issues.push(`${path}.date: M/D, e.g. 11/07`);
  }
  if (!stepText) return undefined;
  return { ...(date ? { date } : {}), text: stepText };
}

function timeline(value: unknown, issues: Issues): Timeline | undefined {
  if (!isObject(value)) {
    issues.push("timeline: must be an object");
    return undefined;
  }
  rejectUnknownKeys(value, ["asked", "did", "stuck"], "timeline.", issues);
  const asked = step(value.asked, "timeline.asked", issues, { date: "required", maxWidth: WIDTHS.timelineText });
  const did = step(value.did, "timeline.did", issues, { date: "optional", maxWidth: WIDTHS.timelineText });
  const stuck = step(value.stuck, "timeline.stuck", issues, { date: "none", maxWidth: WIDTHS.stuckText });
  if (!asked?.date || !did || !stuck) return undefined;
  return { asked: { date: asked.date, text: asked.text }, did, stuck: { text: stuck.text } };
}

const dated = (s: TimelineStep) => (s.date ? `${s.date} ${s.text}` : s.text);

/** What a timeline stands for in the older text fields: Blocked → action, It did → summary, You asked → context. */
export function timelineText(t: Timeline): { action: string; summary: string; context: string } {
  return { action: t.stuck.text, summary: dated(t.did), context: dated(t.asked) };
}

/**
 * Validates and normalizes an agent's filing. Throws QueueInputError listing every problem.
 * A filing holds one thing for the user (`ask`, `result` or `receipt`), or the older lists, which
 * become one card per element. `action`, `summary` and `context` are required unless there is a
 * `timeline`; when they are left out, they are filled from it (`timelineText`), so code that reads
 * only them keeps working.
 */
export function parseCardInput(value: unknown): ParsedCardInput {
  const issues: Issues = [];
  if (!isObject(value)) throw new QueueInputError(["card: must be an object"]);
  rejectUnknownKeys(
    value,
    ["topic", "timeline", "action", "summary", "context", "ask", "result", "receipt", "replaces", "asks", "results", "receipts"],
    "",
    issues,
  );
  const topic = text(value.topic, "topic", issues, { maxChars: LIMITS.topicChars, singleLine: true });
  const hasTimeline = value.timeline !== undefined;
  const recall = hasTimeline ? timeline(value.timeline, issues) : undefined;
  const action = text(value.action, "action", issues, {
    maxChars: LIMITS.actionChars,
    singleLine: true,
    optional: hasTimeline,
  });
  const summary = text(value.summary, "summary", issues, {
    maxChars: LIMITS.textChars,
    sentences: LIMITS.sentences,
    optional: hasTimeline,
  });
  const context = text(value.context, "context", issues, {
    maxChars: LIMITS.textChars,
    sentences: LIMITS.sentences,
    optional: hasTimeline,
  });
  const replaces = text(value.replaces, "replaces", issues, { maxChars: 200, singleLine: true, optional: true });

  const singles = (["ask", "result", "receipt"] as const).filter((key) => value[key] !== undefined);
  const lists = (["asks", "results", "receipts"] as const).filter((key) => value[key] !== undefined);
  const before = issues.length;
  const items: ItemInput[] = [];
  if (singles.length > 1) {
    issues.push(`${singles.join(", ")}: one card holds one thing for the user; file each in its own call`);
  } else if (singles.length && lists.length) {
    issues.push(`${singles[0]} and ${lists.join(", ")}: give one item, or the older lists, not both`);
  } else if (singles[0] === "ask") {
    const parsed = ask(value.ask, "ask", issues);
    if (parsed) items.push({ kind: "ask", ask: parsed });
  } else if (singles[0] === "result") {
    const parsed = result(value.result, "result", issues);
    if (parsed) items.push({ kind: "result", result: parsed });
  } else if (singles[0] === "receipt") {
    const parsed = receipt(value.receipt, "receipt", issues);
    if (parsed) items.push({ kind: "receipt", receipt: parsed });
  } else {
    for (const parsed of list(value.asks, "asks", issues, (entry, path) => ask(entry, path, issues))) items.push({ kind: "ask", ask: parsed });
    for (const parsed of list(value.results, "results", issues, (entry, path) => result(entry, path, issues))) {
      items.push({ kind: "result", result: parsed });
    }
    for (const parsed of list(value.receipts, "receipts", issues, (entry, path) => receipt(entry, path, issues))) {
      items.push({ kind: "receipt", receipt: parsed });
    }
  }
  if (issues.length === before && !items.length) {
    issues.push("give one of ask, result or receipt: a card holds one thing for the user (an open question is an ask without options)");
  }
  if (replaces && items.length > 1) issues.push("replaces: takes one item, not a list");
  if (issues.length || !topic) throw new QueueInputError(issues);
  const filled = recall ? timelineText(recall) : undefined;
  if (!filled && (!action || !summary || !context)) throw new QueueInputError(issues);
  return {
    topic,
    timeline: recall ?? null,
    action: action ?? filled!.action,
    summary: summary ?? filled!.summary,
    context: context ?? filled!.context,
    items,
    replaces: replaces ?? null,
  };
}

/** `cards`, `items` and `asks` all take card ids or item ids; the lists are merged. */
export function parseResolveInput(value: unknown): ResolveRequest {
  if (!isObject(value)) throw new QueueInputError(["resolve: must be an object"]);
  const issues: Issues = [];
  rejectUnknownKeys(value, ["cards", "items", "asks", "all"] satisfies (keyof ResolveInput)[], "", issues);
  const all = value.all === true;
  if (value.all !== undefined && typeof value.all !== "boolean") issues.push("all: true or false");
  const id = (entry: unknown, path: string) => text(entry, path, issues, { maxChars: 200, singleLine: true });
  const ids = [
    ...new Set([
      ...list(value.cards, "cards", issues, id),
      ...list(value.items, "items", issues, id),
      ...list(value.asks, "asks", issues, id),
    ]),
  ];
  if (!all && ids.length === 0) issues.push("give cards: [ids] or all: true");
  if (all && ids.length) issues.push("give either cards or all, not both");
  if (issues.length) throw new QueueInputError(issues);
  return all ? { all: true } : { ids };
}

export function parseTrackInput(value: unknown): TrackInput {
  if (!isObject(value)) throw new QueueInputError(["track: must be an object"]);
  const issues: Issues = [];
  rejectUnknownKeys(value, ["title", "childRef"], "", issues);
  const title = text(value.title, "title", issues, { maxChars: LIMITS.titleChars, singleLine: true });
  const childRef = text(value.childRef, "childRef", issues, { maxChars: 200, optional: true, singleLine: true });
  if (issues.length || !title) throw new QueueInputError(issues);
  return { title, ...(childRef ? { childRef } : {}) };
}
