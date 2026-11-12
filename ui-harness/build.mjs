// Bundles main.tsx with the inbox's current data (read through the CLI) into dist/.
// AGENT_QUEUE_DB picks the database; AQ_NOW fixes the clock for wait times (ISO time).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { trackParents } from "../paseo-plugin/shared/agent-line.ts";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "bin", "agent-queue");
const read = (...args) => JSON.parse(execFileSync(cli, [...args, "--json"], { encoding: "utf8" }));
const now = process.env.AQ_NOW ? new Date(process.env.AQ_NOW).toISOString() : new Date().toISOString();
const cards = read("list");
const tracks = read("tracks");
const childOf = trackParents(cards, read("tracks", "--all"));
// Names for parents without an open card, as the plugin gives them: the topic their agent filed under
// last (closed cards included), else the host's title.
const sessionTitles = {};
const parents = [
  ...cards.map((card) => card.agent?.parentSessionId ?? childOf[card.sessionId] ?? null),
  ...tracks.flatMap((track) => [track.parentSessionId, track.childRef]),
];
const everything = [...cards, ...read("list", "--done")].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
for (const id of parents) {
  if (!id || id in sessionTitles) continue;
  const mine = everything.filter((card) => card.sessionId === id);
  const title = mine.find((card) => card.topic)?.topic ?? mine.find((card) => card.sessionTitle)?.sessionTitle;
  if (title) sessionTitles[id] = title;
}
// AQ_HOME stands in for the daemon's home directory (default: this machine's).
const data = { now, cards, tracks, sessionTitles, childOf, home: process.env.AQ_HOME ?? homedir() };

const modules = join(here, "node_modules");
const out = join(here, "dist");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(here, "main.tsx")],
  bundle: true,
  outfile: join(out, "bundle.js"),
  format: "iife",
  jsx: "automatic",
  target: "es2020",
  define: { QUEUE_DATA: JSON.stringify(data), "process.env.NODE_ENV": '"production"' },
  alias: {
    react: join(modules, "react"),
    "react-dom": join(modules, "react-dom"),
    "react-native": join(modules, "react-native-web"),
    "@getpaseo/plugin/client/ui": join(here, "plugin-ui.tsx"),
  },
  logLevel: "warning",
});
writeFileSync(
  join(out, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",sans-serif;-webkit-font-smoothing:antialiased}#root{display:flex;flex-direction:column;min-height:100vh}</style>
</head><body><div id="root"></div><script src="bundle.js"></script></body></html>`,
);
console.log(`built ${out} with ${data.cards.length} cards, ${data.tracks.length} tracks`);
