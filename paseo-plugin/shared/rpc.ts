// RPC contracts between the queue screen and the plugin subprocess.
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const AskOptionSchema = z.object({
  label: z.string(),
  effect: z.string().optional(),
});

/** What a host permission ask offers (see core HostPermission). */
export const HostPermissionSchema = z.object({
  requestId: z.string(),
  detail: z.string().optional(),
  choices: z.array(z.object({ id: z.string(), label: z.string(), behavior: z.enum(["allow", "deny"]) })).optional(),
  questions: z.array(z.object({ header: z.string(), question: z.string(), options: z.array(z.string()) })).optional(),
});

export const AskSchema = z.object({
  id: z.string(),
  question: z.string(),
  short: z.string().optional(),
  options: z.array(AskOptionSchema).optional(),
  recommended: z.number().int().optional(),
  whyNow: z.string().optional(),
  recommendation: z.string().optional(),
  why: z.string().optional(),
  resolved: z.boolean(),
  dropped: z.boolean().optional(),
  permission: HostPermissionSchema.optional(),
});

export const ResultSchema = z.object({
  id: z.string(),
  label: z.string(),
  href: z.string().optional(),
  note: z.string().optional(),
  look: z.string().optional(),
  resolved: z.boolean(),
  dropped: z.boolean().optional(),
});

export const ReceiptSchema = z.object({
  id: z.string(),
  trackId: z.string().optional(),
  title: z.string(),
  status: z.enum(["returned", "failed"]),
  conclusion: z.string(),
  line: z.string().optional(),
  childRef: z.string().optional(),
  resolved: z.boolean(),
});

const TimelineStepSchema = z.object({ date: z.string().optional(), text: z.string() });

export const TimelineSchema = z.object({
  asked: TimelineStepSchema.extend({ date: z.string() }),
  did: TimelineStepSchema,
  stuck: z.object({ text: z.string() }),
});

/** Which agent a card comes from, in the host's display names (see core AgentMeta). */
export const AgentMetaSchema = z.object({
  plan: z.string().nullable().optional(),
  modelLabel: z.string().nullable().optional(),
  effort: z.string().nullable().optional(),
  effortLabel: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
  workspace: z.string().nullable().optional(),
});

export const CardSchema = z.object({
  id: z.string(),
  host: z.enum(["paseo", "dsh"]),
  sessionId: z.string(),
  sessionTitle: z.string().nullable(),
  cwd: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  agent: AgentMetaSchema.nullable(),
  topic: z.string().nullable(),
  timeline: TimelineSchema.nullable(),
  action: z.string(),
  summary: z.string(),
  context: z.string(),
  asks: z.array(AskSchema),
  results: z.array(ResultSchema),
  receipts: z.array(ReceiptSchema),
  state: z.enum(["open", "done"]),
  firstReadyAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  doneAt: z.string().nullable(),
  doneBy: z.enum(["agent", "user"]).nullable(),
  /** The card that replaced this one (`replaces`); null otherwise. Optional: older daemons do not send it. */
  supersededBy: z.string().nullable().optional(),
});

export const TrackSchema = z.object({
  id: z.string(),
  host: z.enum(["paseo", "dsh"]),
  parentSessionId: z.string().nullable(),
  childRef: z.string().nullable(),
  title: z.string(),
  startedAt: z.string(),
  state: z.enum(["running", "returned", "failed"]),
  endedAt: z.string().nullable(),
});

export type QueueCard = z.infer<typeof CardSchema>;
export type QueueAsk = z.infer<typeof AskSchema>;
export type QueueTrack = z.infer<typeof TrackSchema>;

/** Open cards in queue order plus running dispatches; `now` is the daemon clock for wait times. */
export const listQueue = defineRpc({
  name: "queue.list",
  input: z.object({}),
  output: z.object({
    now: z.string(),
    cards: z.array(CardSchema),
    tracks: z.array(TrackSchema),
    /**
     * Names for the sessions tracks and child cards point to, keyed by session id: the topic that
     * session's agent filed under last, else the host's title for it.
     */
    sessionTitles: z.record(z.string(), z.string()),
    /**
     * Card sessions that a registered dispatch started, with the dispatching session (null when it
     * is unknown). The fallback for children the host does not label with a parent.
     */
    childOf: z.record(z.string(), z.string().nullable()),
    /** The daemon's home directory, to show a cwd as ~/…. */
    home: z.string().nullable(),
    /**
     * What "Open session" opens for a card from an external host (`{session}` stands for its session id);
     * null hides the button there. Optional: older daemons do not send it.
     */
    externalUrl: z.string().nullable().optional(),
  }),
});

export const snoozeCard = defineRpc({
  name: "queue.snooze",
  input: z.object({ cardId: z.string() }),
  output: z.object({ card: CardSchema }),
});

/**
 * Dismiss: closes the card. When it still has open agent asks on a Paseo card, it first tells the
 * session which ones were skipped; if that send fails, the card stays open.
 */
export const markCardDone = defineRpc({
  name: "queue.done",
  input: z.object({ cardId: z.string() }),
  output: z.object({ card: CardSchema }),
});

/**
 * Send: sends the picks (ask id → option index) and the reply into the card's session as one message,
 * then hands the card back (every item resolved, card closed). Paseo cards only.
 */
export const sendAnswers = defineRpc({
  name: "queue.answer",
  input: z.object({
    cardId: z.string(),
    picks: z.record(z.string(), z.number().int().min(0)),
    /** The user's own words, sent as the message's last line. */
    reply: z.string().max(4000).optional(),
  }),
  output: z.object({ card: CardSchema }),
});

/** The user's answer to a permission ask: one choice (its id), or one option label per question header. */
export const PermissionAnswerSchema = z.union([
  z.object({ actionId: z.string() }),
  z.object({ answers: z.record(z.string(), z.string()) }),
]);
export type PermissionAnswer = z.infer<typeof PermissionAnswerSchema>;

/** allowed / denied: a choice went through; sent: question answers did; stale: no longer pending, nothing sent. */
export const PermissionOutcomeSchema = z.enum(["allowed", "denied", "sent", "stale"]);
export type PermissionOutcome = z.infer<typeof PermissionOutcomeSchema>;

/**
 * Answers a permission ask right away, apart from Send: the session is blocked on it. `stale` means
 * the request was no longer pending, so nothing was sent and the ask is resolved.
 */
export const answerPermission = defineRpc({
  name: "queue.permission",
  input: z.object({
    cardId: z.string(),
    askId: z.string(),
    answer: PermissionAnswerSchema,
  }),
  output: z.object({ outcome: PermissionOutcomeSchema, card: CardSchema.nullable() }),
});
