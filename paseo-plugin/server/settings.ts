// Daemon-side settings: the environment the Paseo daemon runs with, else the settings file
// ~/.config/agent-inbox/config.json ({"lang": "zh", "externalUrl": "https://…/{session}"}).
// An environment variable that is set wins over the file.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isHttpUrl } from "agent-inbox-core";
import { messageLang, type MessageLang } from "../shared/messages.ts";

export const CONFIG_PATH = join(homedir(), ".config", "agent-inbox", "config.json");

export interface InboxSettings {
  /** `AGENT_INBOX_LANG`, else the file's `lang`: language of the messages sent into sessions (`zh` for Chinese; English otherwise). */
  lang: MessageLang;
  /**
   * `AGENT_INBOX_EXTERNAL_URL`, else the file's `externalUrl`: the http(s) page "Open session" opens for a
   * card from an external host, `{session}` standing for its session id. Null (unset or not an http(s)
   * URL) hides the button there.
   */
  externalUrl: string | null;
  /** Set but not an http(s) URL, so it is ignored. */
  invalidExternalUrl: string | null;
}

/** The settings file's values; keys that are missing or not strings are left out. */
export interface ConfigFile {
  lang?: string;
  externalUrl?: string;
}

/** Reads the settings file. A missing file is no settings; one that cannot be read or parsed is none too, with the reason. */
export function readConfigFile(path: string = CONFIG_PATH): { config: ConfigFile; error: string | null } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: {}, error: null };
    return { config: {}, error: `${path}: ${(error as Error).message}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { config: {}, error: `${path}: not valid JSON (${(error as Error).message})` };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { config: {}, error: `${path}: not a JSON object` };
  const { lang, externalUrl } = value as Record<string, unknown>;
  return {
    config: { ...(typeof lang === "string" ? { lang } : {}), ...(typeof externalUrl === "string" ? { externalUrl } : {}) },
    error: null,
  };
}

/** The settings from the environment, else from the settings file's values (`readConfigFile`). */
export function readSettings(env: Record<string, string | undefined> = process.env, config: ConfigFile = {}): InboxSettings {
  const pick = (fromEnv: string | undefined, fromFile: string | undefined) => fromEnv?.trim() || fromFile?.trim() || null;
  const url = pick(env.AGENT_INBOX_EXTERNAL_URL, config.externalUrl);
  const valid = url !== null && isHttpUrl(url.replaceAll("{session}", "session"));
  return {
    lang: messageLang(pick(env.AGENT_INBOX_LANG, config.lang)),
    externalUrl: valid ? url : null,
    invalidExternalUrl: url !== null && !valid ? url : null,
  };
}
