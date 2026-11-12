// Daemon-side settings, read from the environment the Paseo daemon runs with.
import { isHttpUrl } from "agent-inbox-core";
import { messageLang, type MessageLang } from "../shared/messages.ts";

export interface InboxSettings {
  /** `AGENT_INBOX_LANG`: language of the messages sent into sessions (`zh` for Chinese; English otherwise). */
  lang: MessageLang;
  /**
   * `AGENT_INBOX_EXTERNAL_URL`: the http(s) page "Open session" opens for a card from an external host,
   * `{session}` standing for its session id. Null (unset or not an http(s) URL) hides the button there.
   */
  externalUrl: string | null;
  /** Set but not an http(s) URL, so it is ignored. */
  invalidExternalUrl: string | null;
}

export function readSettings(env: Record<string, string | undefined> = process.env): InboxSettings {
  const url = env.AGENT_INBOX_EXTERNAL_URL?.trim() || null;
  const valid = url !== null && isHttpUrl(url.replaceAll("{session}", "session"));
  return {
    lang: messageLang(env.AGENT_INBOX_LANG),
    externalUrl: valid ? url : null,
    invalidExternalUrl: url !== null && !valid ? url : null,
  };
}
