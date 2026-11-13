import { homedir } from "node:os";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { Queue, QueueInputError } from "agent-inbox-core";
import { answerCard, discussCard, dismissCard } from "./server/answer";
import { onPermissionAfter, onPermissionBefore, onTurnAfter } from "./server/hooks";
import type { PaseoApi } from "./server/host";
import { QueueMcpServer } from "./server/mcp";
import { answerPermission as answerPermissionRequest } from "./server/permissions";
import { TitleCache } from "./server/session";
import { readConfigFile, readSettings, type InboxSettings } from "./server/settings";
import { createQueueTools } from "./server/tools";
import { trackParents } from "./shared/agent-line";
import { answerPermission, listQueue, markCardDone, sendAnswers, snoozeCard, startDiscussion } from "./shared/rpc";

// The tools reach agents as mcp__agent-queue__queue_add and so on: keep this name stable.
const MCP_SERVER_NAME = "agent-queue";

export default function contribute(server: PluginServerContext) {
  // Settings are read on each use, so an edit to the settings file applies without a reload. Each
  // problem with them is logged once.
  const reported = new Set<string>();
  const report = (problem: string) => {
    if (reported.has(problem)) return;
    reported.add(problem);
    console.error(`[agent-queue] ${problem}`);
  };
  const settings = (): InboxSettings => {
    const file = readConfigFile();
    if (file.error) report(`settings file ignored: ${file.error}`);
    const current = readSettings(process.env, file.config);
    if (current.invalidExternalUrl) report(`the external session URL is not an http(s) URL; ignored: ${current.invalidExternalUrl}`);
    return current;
  };
  settings();
  let queue: Queue | null = null;
  const getQueue = () => (queue ??= new Queue());
  let paseo: PaseoApi | null = null;
  const mcp = new QueueMcpServer(createQueueTools(getQueue), () => paseo);
  const mcpReady = mcp.start();
  const titles = new TitleCache();

  const removers = [
    // The queue tools reach every interactive session as a plugin-owned MCP server.
    server.addHook("agent.open.before", async ({ request }, context) => {
      paseo ??= context.paseo;
      if (request.purpose !== "interactive") return;
      await mcpReady;
      const endpoint = mcp.endpointFor(request.agentId);
      return {
        ...request,
        mcpServers: {
          ...request.mcpServers,
          [MCP_SERVER_NAME]: { type: "http", url: endpoint.url, headers: endpoint.headers, alwaysLoad: true },
        },
        env: { ...request.env, AGENT_QUEUE_SESSION: `paseo:${request.agentId}` },
      };
    }),
    server.addHook("agent.turn.after", (event, context) => {
      paseo ??= context.paseo;
      return onTurnAfter(getQueue(), event, context.paseo);
    }),
    server.addHook("agent.permission.before", (event, context) => onPermissionBefore(getQueue(), event, context.paseo)),
    server.addHook("agent.permission.after", (event) => onPermissionAfter(getQueue(), event)),
  ];

  server.handle(listQueue, async (_input, context) => {
    paseo ??= context.paseo;
    const store = getQueue();
    const cards = store.list();
    const tracks = store.listTracks();
    const childOf = trackParents(cards, store.listTracks({ state: "all" }));
    const known = new Map(cards.map((card) => [card.sessionId, card.sessionTitle]));
    const sessionTitles: Record<string, string> = {};
    const parents = cards
      .filter((card) => card.host === "paseo")
      .map((card) => card.agent?.parentSessionId ?? childOf[card.sessionId] ?? null);
    const wanted = [...tracks.filter((t) => t.host === "paseo").flatMap((t) => [t.parentSessionId, t.childRef]), ...parents];
    for (const id of wanted) {
      if (!id || id in sessionTitles) continue;
      // A parent's name is the topic its agent filed under last, else the host's title for it.
      const title = store.sessionTopic({ host: "paseo", sessionId: id }) ?? known.get(id) ?? (await titles.get(context.paseo, id));
      if (title) sessionTitles[id] = title;
    }
    return { now: new Date().toISOString(), cards, tracks, sessionTitles, childOf, home: homedir(), externalUrl: settings().externalUrl };
  });
  server.handle(snoozeCard, ({ cardId }) => ({ card: getQueue().snooze(cardId) }));
  // "steer" hands a busy session a message inside its running turn instead of interrupting it.
  const sender = (paseoApi: PaseoApi) => (sessionId: string, text: string) =>
    paseoApi.agents.ref(sessionId).send(text, { activeTurnBehavior: "steer" });
  const plainErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof QueueInputError) throw new Error(error.issues.join("; "));
      throw error;
    }
  };
  server.handle(markCardDone, ({ cardId }, context) => {
    paseo ??= context.paseo;
    return plainErrors(async () => ({ card: await dismissCard({ queue: getQueue(), send: sender(context.paseo), lang: settings().lang }, cardId) }));
  });
  server.handle(sendAnswers, ({ cardId, picks, reply }, context) => {
    paseo ??= context.paseo;
    return plainErrors(async () => ({
      card: await answerCard({ queue: getQueue(), send: sender(context.paseo), lang: settings().lang }, cardId, picks, reply ?? ""),
    }));
  });
  server.handle(startDiscussion, ({ cardId }, context) => {
    paseo ??= context.paseo;
    return plainErrors(() => discussCard({ queue: getQueue(), send: sender(context.paseo), lang: settings().lang }, cardId));
  });
  server.handle(answerPermission, ({ cardId, askId, answer }, context) => {
    paseo ??= context.paseo;
    const deps = {
      queue: getQueue(),
      pending: async (sessionId: string) => {
        const refreshed = await context.paseo.agents.ref(sessionId).refresh();
        return refreshed ? (refreshed.agent.pendingPermissions ?? []) : null;
      },
      respond: (sessionId: string, requestId: string, response: AgentPermissionResponse) =>
        context.paseo.agents.ref(sessionId).respondToPermission({ requestId, response }),
    };
    return answerPermissionRequest(deps, cardId, askId, answer);
  });

  return async () => {
    for (const remove of removers) remove();
    await mcp.stop();
    queue?.close();
    queue = null;
  };
}
