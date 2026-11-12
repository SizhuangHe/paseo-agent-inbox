// Answering a Paseo permission request from its card. The choices mirror what Paseo's own app offers
// for the request, and so do the responses; a request that is no longer pending gets no response.
import type { AgentPermissionRequest, AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import { SYSTEM_ASK_PREFIX } from "agent-inbox-core";
import type { Card, HostPermission, PermissionChoice, PermissionQuestion, Queue } from "agent-inbox-core";
import type { PermissionAnswer, PermissionOutcome } from "../shared/rpc.ts";

const DETAIL_MAX = 2_000;

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Paseo's question form: every question has a header, the question and option labels. Null when the
 * input is not that form, or a question takes several answers (multiSelect), which a tap cannot give.
 */
function questionForm(input: unknown): PermissionQuestion[] | null {
  const questions = (input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions) || !questions.length) return null;
  const out: PermissionQuestion[] = [];
  for (const item of questions) {
    const q = item as { header?: unknown; question?: unknown; options?: unknown; multiSelect?: unknown };
    const header = text(q.header);
    const question = text(q.question);
    if (!header || !question || !Array.isArray(q.options) || q.multiSelect === true) return null;
    const options = q.options.map((option) => text((option as { label?: unknown })?.label));
    if (!options.length || options.some((label) => label === null)) return null;
    out.push({ header, question, options: options as string[] });
  }
  return out;
}

/** The buttons Paseo's app shows for a request that is not a question: its own actions, or Deny and Accept. */
function actionChoices(request: AgentPermissionRequest): PermissionChoice[] {
  if (request.actions?.length) {
    return request.actions.map((action) => ({ id: action.id, label: action.label, behavior: action.behavior }));
  }
  return [
    { id: "reject", label: "Deny", behavior: "deny" },
    { id: "accept", label: request.kind === "plan" ? "Implement" : "Accept", behavior: "allow" },
  ];
}

function detailText(request: AgentPermissionRequest): string | undefined {
  const input = request.input ?? {};
  const plan = text(request.metadata?.planText) ?? text(input.plan);
  const lines = [
    request.title && request.title !== request.name ? `${request.name} · ${request.title}` : request.name,
    text(request.description),
    text(input.command),
    text(input.file_path) ?? text(input.path),
    plan,
  ].filter((line): line is string => Boolean(line));
  const detail = [...new Set(lines)].join("\n");
  if (!detail) return undefined;
  return detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail;
}

/** What the card offers for a request: question chips, allow/deny choices, or nothing (answer in the session). */
export function permissionInfo(request: AgentPermissionRequest): HostPermission {
  const detail = detailText(request);
  const base: HostPermission = { requestId: request.id, ...(detail ? { detail } : {}) };
  if (request.kind === "question") {
    const questions = questionForm(request.input);
    return questions ? { ...base, questions } : base;
  }
  return { ...base, choices: actionChoices(request) };
}

export type { PermissionAnswer, PermissionOutcome };

export interface PermissionDeps {
  queue: Queue;
  /** The session's pending requests now; null when the session is gone. */
  pending(sessionId: string): Promise<AgentPermissionRequest[] | null>;
  respond(sessionId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;
}

/** The response Paseo's app would send for this answer, built from the live request. */
function responseFor(
  request: AgentPermissionRequest,
  answer: PermissionAnswer,
): { response: AgentPermissionResponse; outcome: PermissionOutcome } {
  const info = permissionInfo(request);
  if ("actionId" in answer) {
    const choice = info.choices?.find((c) => c.id === answer.actionId);
    if (!choice) throw new Error("That choice is not offered for this request; answer in the session");
    return choice.behavior === "allow"
      ? { response: { behavior: "allow", selectedActionId: choice.id }, outcome: "allowed" }
      : { response: { behavior: "deny", selectedActionId: choice.id, message: "Denied by user" }, outcome: "denied" };
  }
  const questions = info.questions;
  if (!questions) throw new Error("This request takes no answers from the queue; answer in the session");
  for (const question of questions) {
    const label = answer.answers[question.header];
    if (label === undefined) throw new Error(`No answer for "${question.header}"`);
    if (!question.options.includes(label)) throw new Error(`"${label}" is not an option for "${question.header}"`);
  }
  const answers = Object.fromEntries(questions.map((q) => [q.header, answer.answers[q.header]]));
  return { response: { behavior: "allow", updatedInput: { ...(request.input ?? {}), answers } }, outcome: "sent" };
}

/**
 * Answers the permission ask `askId` on an open card right away. A request that is no longer pending
 * (answered in the session first, or the session is gone) sends nothing and resolves the ask.
 */
export async function answerPermission(
  deps: PermissionDeps,
  cardId: string,
  askId: string,
  answer: PermissionAnswer,
): Promise<{ outcome: PermissionOutcome; card: Card | null }> {
  const card = deps.queue.get(cardId);
  if (!card) throw new Error(`unknown card ${cardId}`);
  if (card.host !== "paseo") throw new Error("Only Paseo permission requests can be answered here");
  const ask = card.asks.find((a) => a.id === askId);
  if (!ask || !ask.id.startsWith(SYSTEM_ASK_PREFIX.permission)) throw new Error(`no permission request ${askId} on this card`);
  const identity = { host: card.host, sessionId: card.sessionId };
  const requestId = ask.id.slice(SYSTEM_ASK_PREFIX.permission.length);
  const settle = () => {
    deps.queue.resolveSystemAsks(identity, { ids: [ask.id] });
    return deps.queue.get(cardId);
  };
  const stale = () => ({ outcome: "stale" as const, card: settle() });
  const live = async () => (await deps.pending(card.sessionId))?.find((request) => request.id === requestId) ?? null;

  if (ask.resolved || card.state !== "open") return { outcome: "stale", card };
  const request = await live();
  if (!request) return stale();
  const { response, outcome } = responseFor(request, answer);
  try {
    await deps.respond(card.sessionId, requestId, response);
  } catch (error) {
    // Answered elsewhere between the check and the response: report that, never retry.
    if (!(await live().catch(() => request))) return stale();
    throw error;
  }
  return { outcome, card: settle() };
}
