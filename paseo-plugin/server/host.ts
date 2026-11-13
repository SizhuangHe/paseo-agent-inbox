// What the server code uses from Paseo's client and protocol packages. The types are named as
// @getpaseo/client names them but come through the SDK and protocol types, which Paseo provides
// when it compiles the plugin, so an install that omits dev dependencies still compiles.
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AgentSnapshotPayload, GetProvidersSnapshotResponseMessage } from "@getpaseo/protocol/messages";

export type PaseoApi = PluginHandlerContext["paseo"];
export type PaseoAgent = AgentSnapshotPayload;
export type PaseoProviderSnapshotResult = GetProvidersSnapshotResponseMessage["payload"];

/** The label Paseo puts on an agent started from another session, naming its parent (`@getpaseo/protocol/agent-labels`). */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
