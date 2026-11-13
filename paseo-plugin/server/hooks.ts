// Deterministic queue updates from Paseo lifecycle events: dispatched children coming back,
// permission requests, and failed turns. No agent involvement.
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { PluginHookEvents } from "@getpaseo/plugin/server";
import { SYSTEM_ASK_PREFIX } from "agent-inbox-core";
import type { Queue } from "agent-inbox-core";
import type { PaseoApi } from "./host.ts";
import { permissionInfo } from "./permissions.ts";
import { lastAssistantParagraph, sessionSnapshot } from "./session.ts";

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Permission ids already answered. `permission.before` is a notification that does not block, so an
 * answer can arrive while it is still reading the session snapshot; it must not re-open that ask.
 */
const answeredPermissions = new Set<string>();
function rememberAnswered(requestId: string) {
  answeredPermissions.add(requestId);
  if (answeredPermissions.size > 500) {
    const oldest = answeredPermissions.values().next().value;
    if (oldest !== undefined) answeredPermissions.delete(oldest);
  }
}

export function describePermission(request: AgentPermissionRequest): string {
  const head = request.title || request.name;
  const command = typeof request.input?.command === "string" ? request.input.command : undefined;
  const detail = request.description || command;
  return collapse([head, detail && detail !== head ? detail : ""].filter(Boolean).join(" · ")) || request.kind;
}

export async function onTurnAfter(
  queue: Queue,
  event: PluginHookEvents["agent.turn.after"],
  paseo: PaseoApi,
): Promise<void> {
  const { agent, outcome, turnId } = event;
  const identity = { host: "paseo" as const, sessionId: agent.id };
  // Keep who the session is (plan, model, effort, workspace) current on its open cards.
  if (queue.openCards(identity).length) queue.refreshSnapshot(identity, await sessionSnapshot(paseo, agent.id, agent));
  if (outcome.kind === "canceled") return;

  const tracks = queue.runningTracksForChild("paseo", agent.id);
  if (tracks.length) {
    const status = outcome.kind === "completed" ? "returned" : "failed";
    const conclusion =
      outcome.kind === "failed"
        ? `Error: ${collapse(outcome.error.message)}`
        : await lastAssistantParagraph(paseo, agent.id);
    for (const track of tracks) {
      const target = track.parentSessionId ?? agent.id;
      const snapshot = await sessionSnapshot(paseo, target, target === agent.id ? agent : undefined);
      queue.returnTrack(track.id, { status, conclusion }, snapshot);
    }
    return;
  }

  if (outcome.kind === "completed") {
    queue.resolveSystemAsks(identity, { prefix: SYSTEM_ASK_PREFIX.error });
    return;
  }
  if (agent.parentAgentId) return;
  const message = collapse(outcome.error.message) || "unknown error";
  queue.addSystemAsk(
    identity,
    await sessionSnapshot(paseo, agent.id, agent),
    { id: `${SYSTEM_ASK_PREFIX.error}${turnId ?? Date.now()}`, question: `Error: ${message}` },
    { action: "Look at the failed session", summary: `Error: ${message}`, context: "The last turn ended with an error." },
  );
}

export async function onPermissionBefore(
  queue: Queue,
  event: PluginHookEvents["agent.permission.before"],
  paseo: PaseoApi,
): Promise<void> {
  const { agent, request } = event;
  const what = describePermission(request);
  const snapshot = await sessionSnapshot(paseo, agent.id, agent);
  if (answeredPermissions.has(request.id)) return;
  queue.addSystemAsk(
    { host: "paseo", sessionId: agent.id },
    snapshot,
    { id: `${SYSTEM_ASK_PREFIX.permission}${request.id}`, question: `Permission: ${what}`, permission: permissionInfo(request) },
    { action: "Approve permission", summary: what, context: "The session is paused until this is answered." },
  );
}

export async function onPermissionAfter(
  queue: Queue,
  event: PluginHookEvents["agent.permission.after"],
): Promise<void> {
  rememberAnswered(event.requestId);
  queue.resolveSystemAsks(
    { host: "paseo", sessionId: event.agent.id },
    { ids: [`${SYSTEM_ASK_PREFIX.permission}${event.requestId}`] },
  );
}
