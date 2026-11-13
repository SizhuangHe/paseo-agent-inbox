// Agent tools: queue_add, queue_track, queue_resolve. Session identity always comes from the
// MCP endpoint the plugin gave that session at launch, never from the agent's input. Schemas use
// core's LIMITS and countSentences, and core validates again, so tools and CLI share the rules.
import { charCount, countSentences, displayWidth, isHref, LIMITS, QueueInputError, soleItem, TIMELINE_DATE, WIDTHS } from "agent-inbox-core";
import type { Card, Filing, Queue, Track } from "agent-inbox-core";
import { z } from "zod";
import type { PaseoApi } from "./host.ts";
import { sessionSnapshot } from "./session.ts";

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => charCount(s) <= max, `at most ${max} characters`)
    .refine((s) => !/[\r\n]/.test(s), "one line");

const prose = (max: number, sentences?: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => charCount(s) <= max, `at most ${max} characters`)
    .refine((s) => sentences === undefined || countSentences(s) <= sentences, `at most ${sentences} sentences`);

/** One line of at most `max` display width: CJK 1, ASCII 0.5. */
const narrow = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .refine((s) => displayWidth(s) <= max, `at most ${max} wide (CJK 1, ASCII 0.5)`)
    .refine((s) => !/[\r\n]/.test(s), "one line");

const date = z.string().trim().regex(TIMELINE_DATE, "M/D, e.g. 11/07");

/** Optional text; an empty string counts as absent, as in core. */
const optional = (schema: z.ZodType<string>) =>
  z.union([z.literal(""), schema]).optional();

const optionInput = z
  .object({
    label: narrow(WIDTHS.optionLabel).describe("button text, ≤ 12 wide, e.g. Merge now"),
    effect: optional(narrow(WIDTHS.optionEffect)).describe("what picking it does, ≤ 40 wide, e.g. The new navigation goes live today"),
  })
  .strict();

const askInput = z
  .object({
    question: prose(LIMITS.questionChars).describe("the full question, shown when the user expands the ask"),
    short: narrow(WIDTHS.short).describe(
      "the question in one line, ≤ 30 wide, naming project and thing, no pronouns, e.g. Docs site: merge the redesign branches now?",
    ),
    options: z.array(optionInput).optional().describe("the answers the user can tap; without options the user answers in the session"),
    recommended: z.number().int().min(0).optional().describe("index into options of your pick; the user then only nods"),
    whyNow: optional(narrow(WIDTHS.whyNow)).describe("why decide now, ≤ 60 wide"),
    why: optional(prose(LIMITS.whyChars)).describe("why you recommend it, one sentence"),
    recommendation: optional(oneLine(LIMITS.recommendationChars)).describe("old free-text recommendation; use options + recommended"),
  })
  .strict()
  .refine((a) => a.recommended === undefined || a.recommended < (a.options?.length ?? 0), {
    message: "an index into options",
    path: ["recommended"],
  });

const resultInput = z
  .object({
    label: oneLine(LIMITS.labelChars).describe("what to look at, e.g. a file or page name"),
    href: optional(
      z.string().trim().refine(isHref, "an http(s) URL or an absolute path (/… or ~/…)"),
    ).describe("http(s) URL or absolute path (/… or ~/…); other schemes are rejected"),
    note: optional(prose(LIMITS.noteChars)).describe("what is there"),
    look: optional(narrow(WIDTHS.look)).describe("what to check there, ≤ 22 wide, e.g. Biggest change: the API reference"),
  })
  .strict();

const receiptInput = z
  .object({
    trackId: optional(z.string().trim()).describe("id from queue_track; closes that track"),
    title: oneLine(LIMITS.titleChars).describe("the dispatched work"),
    status: z.enum(["returned", "failed"]),
    conclusion: prose(LIMITS.conclusionChars, LIMITS.sentences).describe("its result, ≤ 3 sentences, after you verified it"),
    line: optional(narrow(WIDTHS.line)).describe("the conclusion in one line, ≤ 26 wide"),
    childRef: optional(z.string().trim()).describe("child agent id or other reference"),
  })
  .strict();

const timelineInput = z
  .object({
    asked: z
      .object({ date, text: narrow(WIDTHS.timelineText) })
      .strict()
      .describe("You asked: when (M/D) and what the user asked for that led to this thing, ≤ 18 wide, e.g. Redesign the docs nav"),
    did: z
      .object({ date: date.optional(), text: narrow(WIDTHS.timelineText) })
      .strict()
      .describe("It did: what you have done on it, ≤ 18 wide, e.g. Built and tested 3 branches"),
    stuck: z
      .object({ text: narrow(WIDTHS.stuckText) })
      .strict()
      .describe("Blocked: what this card waits on from the user, ≤ 20 wide, e.g. Your call on merging now"),
  })
  .strict();

const ITEM_KEYS = ["ask", "result", "receipt"] as const;
const LIST_KEYS = ["asks", "results", "receipts"];

const addInput = z
  .object(
    {
      topic: oneLine(LIMITS.topicChars).describe(
        "this session's name: a short name in the user's language, ≤ 15 chars, e.g. Docs redesign, Flaky CI; the same on every card of this session",
      ),
      timeline: timelineInput.describe("three steps about this one thing, so the user remembers where it came from"),
      ask: askInput.optional().describe("a decision only the user can make"),
      result: resultInput.optional().describe("a result the user should look at"),
      receipt: receiptInput.optional().describe("dispatched work that came back, after you checked it"),
      replaces: optional(z.string().trim()).describe(
        "id of an open card of yours that this one replaces: that card closes and this one takes its place in the queue",
      ),
    },
    {
      // The older lists get a pointer to the new shape instead of a bare "unrecognized key".
      error: (issue) =>
        issue.code === "unrecognized_keys" && issue.keys.some((key) => LIST_KEYS.includes(key))
          ? "one card per call: give ask, result or receipt (singular); file each item in its own call"
          : undefined,
    },
  )
  .strict()
  .refine((v) => ITEM_KEYS.filter((key) => v[key] !== undefined).length === 1, {
    message: "give exactly one of ask, result or receipt: one card holds one thing for the user; file each in its own call",
    // Only on otherwise valid input, so the older lists get the one pointer above and not this as well.
    when: (payload) => payload.issues.length === 0,
  });

const trackInput = z
  .object({
    title: oneLine(LIMITS.titleChars).describe("short name of the dispatched work"),
    childRef: optional(z.string().trim()).describe("the child's Paseo agent id when started with `paseo run`; otherwise omit"),
  })
  .strict();

const ids = z.array(z.string().trim().min(1));

const resolveInput = z
  .object({
    cards: ids.optional().describe("ids of your cards that are handled, e.g. [\"c-1a2b3c4d5e\"]"),
    items: ids.optional().describe("alias of cards; also takes item ids (q1, r1, p1) of older multi-item cards"),
    asks: ids.optional().describe("alias of cards"),
    all: z.boolean().optional().describe("true: close every open card of this session"),
  })
  .strict()
  .refine((v) => (v.all === true) !== Boolean(v.cards?.length || v.items?.length || v.asks?.length), "give cards: [ids] or all: true");

/** How a card reads to its agent: its id, what it holds and that line. */
function cardRef(card: Card): string {
  const sole = soleItem(card);
  if (!sole) return `${card.id} (older card: ${[...card.asks, ...card.results, ...card.receipts].filter((i) => !i.resolved).map((i) => i.id).join(", ")})`;
  const line = sole.kind === "ask" ? (sole.item.short ?? sole.item.question) : sole.kind === "result" ? sole.item.label : sole.item.title;
  return `${card.id} ${sole.kind} "${line}"`;
}

function openCardsLine(cards: Card[]): string {
  return cards.length ? `Your open cards: ${cards.map(cardRef).join("; ")}.` : "You have no open cards.";
}

function describeFiling(filing: Filing): string {
  const { card, outcome, replaced } = filing;
  if (outcome === "updated") return `Updated card ${cardRef(card)} in place (an open card of yours already had this line).`;
  if (outcome === "replaced") return `Filed card ${cardRef(card)} in place of ${replaced}, which is now closed.`;
  return `Filed card ${cardRef(card)}.`;
}

function describeTrack(track: Track): string {
  return track.childRef
    ? `Track ${track.id} registered for ${track.childRef}. When its turn ends, its result is filed as a card in the inbox.`
    : `Track ${track.id} registered. When the work is back and you have checked it, file it with queue_add receipt: { trackId: "${track.id}", ... }.`;
}

export interface ToolContext {
  agentId: string;
  paseo: PaseoApi | null;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface QueueTool {
  name: string;
  title: string;
  description: string;
  input: z.ZodType;
  run(input: unknown, context: ToolContext): Promise<ToolResult>;
}

function tool<Schema extends z.ZodType>(definition: {
  name: string;
  title: string;
  description: string;
  input: Schema;
  run(input: z.output<Schema>, context: ToolContext): Promise<ToolResult> | ToolResult;
}): QueueTool {
  return {
    ...definition,
    async run(input, context) {
      try {
        return await definition.run(input as z.output<Schema>, context);
      } catch (error) {
        if (error instanceof QueueInputError) return { isError: true, text: error.message };
        throw error;
      }
    },
  };
}

export function createQueueTools(getQueue: () => Queue): QueueTool[] {
  return [
    tool({
      name: "queue_add",
      title: "File a card in the user's inbox",
      description:
        "File a card when the next step is the user's: a decision only the user can make, a result the user should look at, or dispatched work that came back; not what you can decide yourself, questions inside a discussion the user is actively having with you, or physical tasks the user has to do (those belong in their to-do list). " +
        "One call files one card with exactly one ask, result or receipt and its own timeline about that thing (topic is this session's name, the same on all its cards); filing the same short, result label or receipt title again updates that card in place, and replaces: <card id> closes an open card and puts this one in its place. " +
        "Write it in the user's language, facts only, in plain words for someone who has forgotten this work, then say in your reply that you filed or updated the card, e.g. \"Filed to the inbox: …\".",
      input: addInput,
      async run(input, { agentId, paseo }) {
        const identity = { host: "paseo" as const, sessionId: agentId };
        const snapshot = paseo ? await sessionSnapshot(paseo, agentId) : {};
        const queue = getQueue();
        const { cards } = queue.add(identity, snapshot, input);
        return {
          text: `${cards.map(describeFiling).join(" ")} ${openCardsLine(queue.openCards(identity))} Resolve each with queue_resolve cards: [id] as soon as it is handled.`,
        };
      },
    }),
    tool({
      name: "queue_track",
      title: "Register dispatched work",
      description:
        "Call when you dispatch work (a `paseo run` child or a subagent) so the user sees it under Running. " +
        "With childRef (the Paseo agent id) its result is filed as a card automatically when it finishes; " +
        "otherwise file the result yourself with queue_add receipt.trackId after you have checked it.",
      input: trackInput,
      run(input, { agentId }) {
        return { text: describeTrack(getQueue().track("paseo", agentId, input)) };
      },
    }),
    tool({
      name: "queue_resolve",
      title: "Close your handled cards",
      description:
        "Close your cards as soon as they are handled, in the same turn: the user answered in this conversation, saw the result, you did what the user decided, or the card no longer needs the user. " +
        "Pass cards: [card ids] (the ids queue_add returned), or all: true for every open card of this session; a card the user already sent back is closed already.",
      input: resolveInput,
      run(input, { agentId }) {
        const { cards, open } = getQueue().resolve({ host: "paseo", sessionId: agentId }, input);
        const closed = cards.filter((card) => card.state === "done").map((card) => card.id);
        const head = closed.length ? `Closed ${closed.join(", ")}.` : "Nothing closed.";
        return { text: `${head} ${openCardsLine(open)}` };
      },
    }),
  ];
}
