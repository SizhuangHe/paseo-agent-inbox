// agent-queue CLI: a thin wrapper over core for manual use, scripts and agent hosts other than Paseo.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Queue, QueueInputError, soleItem } from "../core/index.ts";
import type { Card, DoneBy, Host, SessionIdentity, SessionSnapshot, Track } from "../core/index.ts";

const USAGE = `usage: agent-queue <command> [options]

  add       [identity] [--title T --cwd P --provider P --model M] [--replaces CARD_ID]   card JSON on stdin
  resolve   [identity] (--card CARD_ID [--card ...] | --all)   --item and --ask are aliases
  track     [identity | --no-parent] --title T [--child REF] [--started-at ISO]
  return    --track ID --status returned|failed --conclusion TEXT
  list      [--done] [--json]
  tracks    [--all] [--json]
  show      CARD_ID
  snooze    CARD_ID
  done      CARD_ID [--by user|agent]

identity: --host paseo|dsh --session ID, or env AGENT_QUEUE_SESSION=<host>:<id>
          (dsh: any agent host other than Paseo)
--db PATH (or env AGENT_QUEUE_DB) selects another database file.
For --host paseo, missing session details are read from \`paseo inspect\`.
add: one card per item ({topic, timeline, ask | result | receipt}); the older asks / results / receipts
lists become one card each. An open card of the session with the same short (result label, receipt
title) is updated in place; --replaces CARD_ID closes that card and puts the new one in its place.
--replace (no value) is accepted and ignored, for agents on the older guide.`;

const options = {
  db: { type: "string" },
  host: { type: "string" },
  session: { type: "string" },
  title: { type: "string" },
  cwd: { type: "string" },
  provider: { type: "string" },
  model: { type: "string" },
  card: { type: "string", multiple: true },
  item: { type: "string", multiple: true },
  ask: { type: "string", multiple: true },
  all: { type: "boolean" },
  replace: { type: "boolean" },
  replaces: { type: "string" },
  child: { type: "string" },
  "no-parent": { type: "boolean" },
  "started-at": { type: "string" },
  track: { type: "string" },
  status: { type: "string" },
  conclusion: { type: "string" },
  done: { type: "boolean" },
  json: { type: "boolean" },
  by: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>["values"];

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

function parseHost(value: string): Host {
  if (value === "paseo" || value === "dsh") return value;
  fail(`unknown host "${value}" (paseo or dsh)`);
}

function identityFrom(values: Values): SessionIdentity {
  if (values.host || values.session) {
    if (!values.host || !values.session) fail("give both --host and --session");
    return { host: parseHost(values.host), sessionId: values.session };
  }
  const env = process.env.AGENT_QUEUE_SESSION;
  if (env) {
    const at = env.indexOf(":");
    if (at > 0) return { host: parseHost(env.slice(0, at)), sessionId: env.slice(at + 1) };
  }
  fail("no session: pass --host/--session or set AGENT_QUEUE_SESSION=<host>:<id>");
}

interface PaseoInspect {
  Id?: string;
  Name?: string | null;
  Cwd?: string | null;
  Provider?: string | null;
  Model?: string | null;
}

/** Full agent id and session details from the local Paseo daemon; null when it cannot answer. */
function inspectPaseo(sessionId: string): PaseoInspect | null {
  try {
    const out = execFileSync("paseo", ["inspect", sessionId, "--json"], {
      encoding: "utf8",
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out) as PaseoInspect;
  } catch {
    return null;
  }
}

function resolveSession(identity: SessionIdentity, values: Values): { identity: SessionIdentity; snapshot: SessionSnapshot } {
  const snapshot: SessionSnapshot = {
    sessionTitle: values.title ?? null,
    cwd: values.cwd ?? null,
    provider: values.provider ?? null,
    model: values.model ?? null,
  };
  if (identity.host !== "paseo") return { identity, snapshot };
  const needsLookup = !snapshot.sessionTitle || !snapshot.cwd || !snapshot.provider || !snapshot.model;
  const info = needsLookup || identity.sessionId.length < 36 ? inspectPaseo(identity.sessionId) : null;
  if (!info) return { identity, snapshot };
  return {
    identity: { host: "paseo", sessionId: info.Id ?? identity.sessionId },
    snapshot: {
      sessionTitle: snapshot.sessionTitle ?? info.Name ?? null,
      cwd: snapshot.cwd ?? info.Cwd ?? null,
      provider: snapshot.provider ?? info.Provider ?? null,
      model: snapshot.model ?? info.Model ?? null,
    },
  };
}

function readStdinJson(): unknown {
  const raw = readFileSync(0, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(`stdin is not valid JSON: ${(error as Error).message}`);
  }
}

function print(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** What the card holds: its one item (`ask: <short>`), or the open item counts of an older multi-item card. */
function itemSummary(card: Card): string {
  const sole = soleItem(card);
  if (sole?.kind === "ask") return `ask: ${sole.item.short ?? sole.item.question}`;
  if (sole?.kind === "result") return `result: ${sole.item.label}`;
  if (sole?.kind === "receipt") return `receipt: ${sole.item.title}`;
  const open = (items: { resolved: boolean }[]) => items.filter((item) => !item.resolved).length;
  return [
    open(card.asks) ? `${open(card.asks)} ask` : "",
    open(card.results) ? `${open(card.results)} result` : "",
    open(card.receipts) ? `${open(card.receipts)} receipt` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function cardLine(card: Card): string {
  return [card.id, card.firstReadyAt, `${card.host}:${card.sessionId.slice(0, 8)}`, card.topic ?? card.sessionTitle ?? "-", itemSummary(card)].join("\t");
}

function trackLine(track: Track): string {
  return [track.id, track.state, track.startedAt, track.parentSessionId?.slice(0, 8) ?? "-", track.childRef ?? "-", track.title].join("\t");
}

function needPositional(positionals: string[], name: string): string {
  const value = positionals[1];
  if (!value) fail(`missing ${name}`);
  return value;
}

export function main(argv: string[]): number {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  const command = positionals[0];
  if (values.help || !command) {
    process.stdout.write(`${USAGE}\n`);
    return command || values.help ? 0 : 2;
  }
  const queue = new Queue(values.db ? { path: values.db } : {});
  try {
    switch (command) {
      case "add": {
        const stdin = readStdinJson();
        const input = values.replaces && stdin && typeof stdin === "object" ? { ...stdin, replaces: values.replaces } : stdin;
        const { identity, snapshot } = resolveSession(identityFrom(values), values);
        print(queue.add(identity, snapshot, input));
        return 0;
      }
      case "resolve": {
        const { identity } = resolveSession(identityFrom(values), values);
        const cards = [...(values.card ?? []), ...(values.item ?? []), ...(values.ask ?? [])];
        print(queue.resolve(identity, { cards, ...(values.all ? { all: true } : {}) }));
        return 0;
      }
      case "track": {
        if (!values.title) fail("missing --title");
        const host = values["no-parent"] ? parseHost(values.host ?? "paseo") : identityFrom(values).host;
        const parent = values["no-parent"] ? null : resolveSession(identityFrom(values), values).identity.sessionId;
        let child = values.child;
        if (child && host === "paseo") child = inspectPaseo(child)?.Id ?? child;
        print(queue.track(host, parent, { title: values.title, ...(child ? { childRef: child } : {}) }, values["started-at"] ? { startedAt: values["started-at"] } : {}));
        return 0;
      }
      case "return": {
        if (!values.track) fail("missing --track");
        if (values.status !== "returned" && values.status !== "failed") fail("--status returned|failed");
        const track = queue.getTrack(values.track);
        if (!track) fail(`unknown track ${values.track}`);
        const target = track.parentSessionId ?? track.childRef;
        const snapshot = target && track.host === "paseo" ? resolveSession({ host: "paseo", sessionId: target }, values).snapshot : {};
        print(queue.returnTrack(track.id, { status: values.status, conclusion: values.conclusion ?? "" }, snapshot));
        return 0;
      }
      case "list": {
        const cards = queue.list({ state: values.done ? "done" : "open" });
        if (values.json) print(cards);
        else for (const card of cards) process.stdout.write(`${cardLine(card)}\n`);
        return 0;
      }
      case "tracks": {
        const tracks = queue.listTracks({ state: values.all ? "all" : "running" });
        if (values.json) print(tracks);
        else for (const track of tracks) process.stdout.write(`${trackLine(track)}\n`);
        return 0;
      }
      case "show": {
        const card = queue.get(needPositional(positionals, "CARD_ID"));
        if (!card) fail("unknown card");
        print(card);
        return 0;
      }
      case "snooze":
        print(queue.snooze(needPositional(positionals, "CARD_ID")));
        return 0;
      case "done": {
        const by = (values.by ?? "user") as DoneBy;
        if (by !== "user" && by !== "agent") fail("--by user|agent");
        print(queue.done(needPositional(positionals, "CARD_ID"), by));
        return 0;
      }
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    queue.close();
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof QueueInputError) {
    process.stderr.write(`agent-queue: invalid input\n${error.issues.map((issue) => `  - ${issue}`).join("\n")}\n`);
    process.exitCode = 2;
  } else if (error instanceof UsageError || (error as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    process.stderr.write(`agent-queue: ${(error as Error).message}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`agent-queue: ${(error as Error).stack ?? String(error)}\n`);
    process.exitCode = 1;
  }
}
