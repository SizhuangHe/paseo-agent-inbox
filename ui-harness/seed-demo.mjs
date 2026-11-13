// Seeds a new inbox database with invented demo cards, through core's add (so every field is
// validated as an agent's would be): a docs redesign session with two asks, a result and a failed
// receipt; a flaky CI session with an ask the user is discussing in the session and a result, and a
// child session it started with a receipt (nested by Paseo's parent label); a session blocked on a
// permission request; and two dispatches still running.
// --with-legacy adds an older card that holds several items, to render that layout; --more adds a
// mobile app session with three cards, which takes the inbox past ten cards, so it starts folded.
// usage: node seed-demo.mjs <new.db> [--with-legacy] [--more]
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Queue } from "../core/index.ts";
import { describePermission } from "../paseo-plugin/server/hooks.ts";
import { permissionInfo } from "../paseo-plugin/server/permissions.ts";

const [dbPath, ...flags] = process.argv.slice(2);
if (!dbPath) throw new Error("usage: node seed-demo.mjs <new.db> [--with-legacy] [--more]");
if (existsSync(dbPath)) throw new Error(`${dbPath} exists; seed a new file`);
const withLegacy = flags.includes("--with-legacy");
const withMore = flags.includes("--more");

const HOME = "/home/demo";
const opus = { plan: "Claude Work", modelLabel: "Opus 5.5", effort: "high", effortLabel: "high", parentSessionId: null };
const DOCS = "agent-docs";
const CI = "agent-ci";
const CI_CHILD = "agent-ci-bisect";
const MOBILE = "agent-mobile";
const sessions = {
  [DOCS]: {
    sessionTitle: "docs navigation redesign",
    cwd: `${HOME}/projects/docs-site`,
    provider: "claude",
    model: "claude-opus-5-5",
    agent: { ...opus, workspace: "docs-site" },
  },
  [CI]: {
    sessionTitle: "flaky CI investigation",
    cwd: `${HOME}/projects/api-server`,
    provider: "claude",
    model: "claude-opus-5-5",
    agent: { ...opus, plan: "Claude", effort: "xhigh", effortLabel: "xhigh", workspace: "api-server" },
  },
  [MOBILE]: {
    sessionTitle: "offline mode for the mobile app",
    cwd: `${HOME}/projects/mobile-app`,
    provider: "codex",
    model: "gpt-5.5",
    agent: { plan: "Codex", modelLabel: "GPT-5.5", effort: "high", effortLabel: "high", parentSessionId: null, workspace: "mobile-app" },
  },
  [CI_CHILD]: {
    sessionTitle: "bisect the upload test",
    cwd: `${HOME}/projects/api-server`,
    provider: "claude",
    model: "claude-sonnet-5-5",
    agent: { ...opus, plan: "Claude", modelLabel: "Sonnet 5.5", parentSessionId: CI, workspace: "api-server" },
  },
};

/** Files one card at `at` (UTC), as the agent of `sessionId` would. */
function file(sessionId, at, input) {
  const queue = new Queue({ path: dbPath, now: () => new Date(at) });
  const { cards } = queue.add({ host: "paseo", sessionId }, sessions[sessionId], input);
  queue.close();
  for (const { card } of cards) console.log(`${card.id}  ${card.topic}  ${card.asks[0]?.short ?? card.results[0]?.label ?? card.receipts[0]?.title}`);
  return cards[0].card;
}

/** Registers dispatched work at `at`, as `queue_track` does. */
function track(parent, at, input) {
  const queue = new Queue({ path: dbPath, now: () => new Date(at) });
  queue.track("paseo", parent, input);
  queue.close();
}

const docs = (at, timeline, item) => file(DOCS, at, { topic: "Docs redesign", timeline, ...item });
docs(
  "2026-11-12T14:05:00Z",
  { asked: { date: "11/10", text: "Redesign the docs navigation" }, did: { date: "11/12", text: "3 branches built and tested" }, stuck: { text: "Your call on shipping" } },
  {
    ask: {
      short: "Docs site: ship the new navigation?",
      question:
        "The new docs navigation is ready and tested on three branches. Ship it to everyone today, or behind a feature flag for a week first?",
      options: [
        { label: "Ship to all", effect: "Everyone sees the new nav today" },
        { label: "Behind a flag", effect: "Staff see it first; public in a week" },
        { label: "Hold for now", effect: "Nothing changes until the next release" },
      ],
      recommended: 1,
      whyNow: "The release branch is cut tomorrow morning",
      why: "A flag lets support check the new layout before everyone sees it.",
    },
  },
);
docs(
  "2026-11-12T14:30:00Z",
  { asked: { date: "11/10", text: "Redesign the docs navigation" }, did: { date: "11/12", text: "Comparison page is up" }, stuck: { text: "Waiting for your review" } },
  {
    result: {
      label: "Before/after comparison of the docs",
      href: "https://example.com/docs-redesign/compare",
      look: "Biggest change: API reference",
      note: "Side-by-side screenshots of 24 pages.",
    },
  },
);
docs(
  "2026-11-12T15:10:00Z",
  { asked: { date: "11/11", text: "Keep old links working" }, did: { date: "11/12", text: "Found 12 URLs that go away" }, stuck: { text: "Need your list" } },
  {
    ask: {
      short: "Docs site: which old URLs need a redirect?",
      question:
        "Twelve old URLs go away with the new navigation. Which of them still get enough traffic to deserve a redirect? The list is on the comparison page.",
    },
  },
);
docs(
  "2026-11-12T17:45:00Z",
  { asked: { date: "11/12", text: "Check links on the preview" }, did: { date: "11/12", text: "Dispatched a link check" }, stuck: { text: "See why it failed" } },
  {
    receipt: {
      title: "Link check on the preview site",
      status: "failed",
      conclusion: "The link checker timed out after 10 minutes on the preview site. It needs a longer timeout or a smaller set of pages.",
      line: "Timed out; needs a longer limit",
    },
  },
);

const ci = (at, timeline, item) => file(CI, at, { topic: "Flaky CI", timeline, ...item });
const stopgap = ci(
  "2026-11-12T15:02:00Z",
  { asked: { date: "11/11", text: "Find why CI fails at random" }, did: { date: "11/12", text: "Traced it to one test" }, stuck: { text: "Your call on a stopgap" } },
  {
    ask: {
      short: "Flaky CI: retry the upload test, or fix it first?",
      question:
        "The integration test for file uploads fails about 1 run in 15 on CI and never locally. Retry it automatically for now, quarantine it, or block merges until it is fixed?",
      options: [
        { label: "Retry twice", effect: "CI goes green; the flake stays hidden" },
        { label: "Fix first", effect: "Merges wait about a day for the fix" },
        { label: "Quarantine", effect: "The test runs but cannot fail the build" },
      ],
      recommended: 2,
      whyNow: "Three pull requests are waiting on a green build",
      why: "Quarantine keeps the signal without blocking merges.",
    },
  },
);
ci(
  "2026-11-12T15:20:00Z",
  { asked: { date: "11/11", text: "Find why CI fails at random" }, did: { date: "11/12", text: "Summed up 9 failures" }, stuck: { text: "Waiting for your read" } },
  {
    result: {
      label: "Failure log summary for the upload test",
      href: `${HOME}/projects/api-server/notes/flaky-upload.md`,
      look: "Section 2: timing of failures",
      note: "Timestamps, runner and seed for each of the 9 failures.",
    },
  },
);
// The user pressed Discuss on the stopgap question.
const discussing = new Queue({ path: dbPath, now: () => new Date("2026-11-12T18:40:00Z") });
discussing.markDiscussing(stopgap.id);
discussing.close();
file(CI_CHILD, "2026-11-12T16:40:00Z", {
  topic: "CI bisect",
  timeline: { asked: { date: "11/12", text: "Bisect the upload test" }, did: { date: "11/12", text: "Bisected 40 commits" }, stuck: { text: "Review the result" } },
  receipt: {
    title: "Bisect the flaky upload test",
    status: "returned",
    conclusion:
      "The flake starts with the commit that moved uploads to a temp directory. The test reads the file before the write is flushed.",
    line: "Starts with the temp-dir commit",
  },
});

// Work still running: one dispatch per session.
track(DOCS, "2026-11-12T18:00:00Z", { title: "Rebuild the search index" });
track(CI, "2026-11-12T18:25:00Z", { title: "Run the upload test 200 times" });

// A session blocked on a permission request, filed the way the agent.permission.before hook files it.
const request = {
  id: "toolu_demo_push",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  description: "Push the release branch to GitHub",
  input: { command: "git push origin release/2.4" },
};
const blocked = new Queue({ path: dbPath, now: () => new Date("2026-11-12T18:20:00Z") });
const what = describePermission(request);
const permission = blocked.addSystemAsk(
  { host: "paseo", sessionId: "agent-release" },
  {
    sessionTitle: "Prepare the 2.4 release",
    cwd: `${HOME}/projects/api-server`,
    provider: "claude",
    model: "claude-opus-5-5",
    agent: { ...opus, workspace: "api-server" },
  },
  { id: `perm:${request.id}`, question: `Permission: ${what}`, permission: permissionInfo(request) },
  { action: "Approve permission", summary: what, context: "The session is paused until this is answered." },
);
blocked.close();
console.log(`${permission.id}  (permission)`);

if (withMore) {
  const mobile = (at, timeline, item) => file(MOBILE, at, { topic: "Offline mode", timeline, ...item });
  mobile(
    "2026-11-12T16:10:00Z",
    { asked: { date: "11/11", text: "Add an offline mode" }, did: { date: "11/12", text: "Cached reads work offline" }, stuck: { text: "Your call on writes" } },
    {
      ask: {
        short: "Mobile: queue writes made offline?",
        question: "Reads now work offline from the cache. Should edits made offline wait in a queue and sync later, or be blocked until the app is online?",
        options: [
          { label: "Queue them", effect: "Edits sync when back online; conflicts possible" },
          { label: "Block them", effect: "Offline is read-only" },
        ],
        recommended: 0,
        why: "Most edits are notes nobody else touches.",
      },
    },
  );
  mobile(
    "2026-11-12T16:30:00Z",
    { asked: { date: "11/11", text: "Add an offline mode" }, did: { date: "11/12", text: "Measured cache size" }, stuck: { text: "Waiting for your review" } },
    { result: { label: "Cache size on three test phones", href: "https://example.com/mobile/cache-size", look: "The 2 GB limit row" } },
  );
  mobile(
    "2026-11-12T17:05:00Z",
    { asked: { date: "11/12", text: "Ship offline mode in 3.1" }, did: { date: "11/12", text: "Release notes drafted" }, stuck: { text: "Need your wording" } },
    { ask: { short: "Mobile: name the feature in the notes?", question: "What should the release notes call the feature: Offline mode, Work offline, or something else?" } },
  );
}

if (withLegacy) {
  // An older card holding several items, as cards were filed before one card held one thing; written
  // straight into the file, since core now files one card per item.
  const raw = new DatabaseSync(dbPath);
  const at = "2026-11-12T13:00:00.000Z";
  const id = "c-legacy-demo";
  raw
    .prepare(
      `INSERT INTO cards (id, host, session_id, session_title, cwd, provider, model, topic, timeline, action, summary, context,
         asks, results, receipts, state, first_ready_at, created_at, updated_at)
       VALUES (?, 'paseo', 'agent-blog', 'blog cleanup', ?, 'claude', 'claude-opus-5-5', 'Blog cleanup', ?, ?, ?, ?, ?, ?, '[]', 'open', ?, ?, ?)`,
    )
    .run(
      id,
      `${HOME}/projects/blog`,
      JSON.stringify({
        asked: { date: "11/09", text: "Tidy up the old blog" },
        did: { date: "11/11", text: "Sorted 140 posts" },
        stuck: { text: "Two calls, one page" },
      }),
      "Decide two questions, look at one page",
      "Sorted 140 posts into keep, merge and archive.",
      "Tidying up the old blog.",
      JSON.stringify([
        {
          id: "q1",
          question: "Archive the 38 posts that have had no visits this year?",
          short: "Blog: archive 38 posts with no visits?",
          options: [{ label: "Archive" }, { label: "Keep" }],
          recommended: 0,
          resolved: false,
        },
        {
          id: "q2",
          question: "Merge the three posts about the old installer into one?",
          short: "Blog: merge the three installer posts?",
          options: [{ label: "Merge" }, { label: "Leave as is" }],
          resolved: false,
        },
      ]),
      JSON.stringify([{ id: "r1", label: "Post inventory", href: "https://example.com/blog/inventory", look: "Archive column", resolved: false }]),
      at,
      at,
      at,
    );
  raw.close();
  console.log(`${id}  Blog cleanup  (older card: 2 asks, 1 result)`);
}
