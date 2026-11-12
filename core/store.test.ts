import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { countSentences, displayWidth, Queue, QueueInputError, RECEIPT_CARD_ACTION, soleItem } from "./index.ts";
import type { AddResult, Card, SessionIdentity } from "./index.ts";

const A = { host: "paseo", sessionId: "agent-a" } as const;
const B = { host: "paseo", sessionId: "agent-b" } as const;
const C = { host: "paseo", sessionId: "agent-c" } as const;
const SNAP = { sessionTitle: "Docs redesign", cwd: "/home/u/docs-site", provider: "claude", model: "claude-opus-5-5" };

function clock(start = Date.parse("2026-11-11T20:00:00.000Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
  };
}

function queue(c = clock()) {
  return new Queue({ path: ":memory:", now: c.now });
}

function tempPath(): string {
  return join(mkdtempSync(join(tmpdir(), "agent-queue-test-")), "queue.db");
}

const card = (over: Record<string, unknown> = {}) => ({
  topic: "Docs redesign",
  action: "Decide 2 questions, view 1 page",
  summary: "Three nav branches built, none merged yet.",
  context: "Docs redesign, round two.",
  ...over,
});

/** The one card a single-item filing filed. */
function one(result: AddResult): Card {
  assert.equal(result.cards.length, 1);
  return result.cards[0].card;
}

const ASK = { question: "Collapse long nav lists instead of cutting them?", short: "Docs nav: collapse long lists?", options: [{ label: "Collapse" }, { label: "Keep" }] };

/**
 * A multi-item card as code before one-card-per-item wrote it, inserted straight into the file; the
 * queue only reads such cards and works on them.
 */
function insertLegacy(
  path: string,
  identity: SessionIdentity,
  body: { id?: string; asks?: unknown[]; results?: unknown[]; receipts?: unknown[]; topic?: string | null; at?: string },
): string {
  const raw = new DatabaseSync(path);
  const id = body.id ?? `c-legacy-${Math.random().toString(16).slice(2, 8)}`;
  const at = body.at ?? "2026-11-11T19:00:00.000Z";
  raw
    .prepare(
      `INSERT INTO cards (id, host, session_id, session_title, action, summary, context, asks, results, receipts, state, first_ready_at, created_at, updated_at, topic)
       VALUES (?, ?, ?, 'Docs redesign', 'Decide 2 questions', 'Done.', 'Round one.', ?, ?, ?, 'open', ?, ?, ?, ?)`,
    )
    .run(
      id,
      identity.host,
      identity.sessionId,
      JSON.stringify(body.asks ?? []),
      JSON.stringify(body.results ?? []),
      JSON.stringify(body.receipts ?? []),
      at,
      at,
      at,
      body.topic === undefined ? "Docs redesign" : body.topic,
    );
  raw.close();
  return id;
}

const LEGACY_ITEMS = {
  asks: [
    { id: "q1", question: "Q1?", resolved: false },
    { id: "q2", question: "Q2?", resolved: false },
  ],
  results: [
    { id: "r1", label: "nav.html", resolved: false },
    { id: "r2", label: "search.html", resolved: false },
  ],
  receipts: [{ id: "p1", title: "Link check", status: "returned", conclusion: "2 of 7 pages need fixes.", resolved: false }],
};

describe("add", () => {
  it("files one card per call, holding its one item", () => {
    const q = queue();
    const filed = q.add(A, SNAP, card({ ask: { question: "Collapse long nav lists instead of cutting them?", recommendation: "Collapse" } }));
    assert.equal(filed.cards[0].outcome, "created");
    const c = one(filed);
    assert.equal(c.state, "open");
    assert.equal(c.host, "paseo");
    assert.equal(c.sessionId, "agent-a");
    assert.equal(c.sessionTitle, "Docs redesign");
    assert.equal(c.model, "claude-opus-5-5");
    assert.deepEqual(c.asks, [{ id: "q1", question: "Collapse long nav lists instead of cutting them?", recommendation: "Collapse", resolved: false }]);
    assert.deepEqual([c.results, c.receipts], [[], []]);
    assert.equal(c.firstReadyAt, c.createdAt);
    assert.equal(c.supersededBy, null);
    const result = one(q.add(A, SNAP, card({ result: { label: "nav.html", href: "https://example.com/nav.html", note: "10 pages" } })));
    assert.deepEqual(result.results.map((r) => [r.id, r.label]), [["r1", "nav.html"]]);
    const receipt = one(q.add(A, SNAP, card({ receipt: { title: "Link check", status: "returned", conclusion: "2 of 7 pages need fixes." } })));
    assert.deepEqual(receipt.receipts.map((r) => [r.id, r.title]), [["p1", "Link check"]]);
    assert.deepEqual(q.list().map((x) => x.id), [c.id, result.id, receipt.id], "one session, three open cards");
    assert.deepEqual(q.openCards(A).map((x) => x.id), [c.id, result.id, receipt.id]);
  });

  it("splits the older lists into one card per element, all with the filing's topic and timeline", () => {
    const q = queue();
    const timeline = { asked: { date: "11/07", text: "Review the docs nav" }, did: { text: "Rebuilt 25 pages" }, stuck: { text: "Your call on 2 things" } };
    const filed = q.add(A, SNAP, card({
      timeline,
      asks: [{ question: "Q1?" }, { question: "Q2?" }],
      results: [{ label: "nav.html" }],
      receipts: [{ title: "Link check", status: "returned", conclusion: "Fixed." }],
    }));
    assert.deepEqual(filed.cards.map((f) => f.outcome), ["created", "created", "created", "created"]);
    assert.deepEqual(
      filed.cards.map(({ card: c }) => soleItem(c)?.item.id),
      ["q1", "q1", "r1", "p1"],
      "each card numbers its item from 1",
    );
    assert.deepEqual(filed.cards.map(({ card: c }) => [c.topic, c.timeline?.stuck.text]), Array(4).fill(["Docs redesign", "Your call on 2 things"]));
    assert.deepEqual(q.list().map((c) => c.id), filed.cards.map((f) => f.card.id), "queue order is filing order");
  });

  it("holds one thing per card: no two items, no mixing with the lists, no empty filing", () => {
    const q = queue();
    const reject = (input: unknown, pattern: RegExp) =>
      assert.throws(() => q.add(A, SNAP, input), (error: unknown) => error instanceof QueueInputError && pattern.test(error.message), String(pattern));
    reject(card({ ask: ASK, result: { label: "x" } }), /ask, result: one card holds one thing for the user; file each in its own call/);
    reject(card({ ask: ASK, results: [{ label: "x" }] }), /ask and results: give one item, or the older lists, not both/);
    reject(card(), /give one of ask, result or receipt/);
    reject(card({ asks: [] }), /give one of ask, result or receipt/);
    reject(card({ ask: { short: "No question" } }), /ask\.question: required/);
    reject(card({ replaces: "c-x", asks: [ASK, ASK] }), /replaces: takes one item, not a list/);
    assert.equal(q.list().length, 0);
  });

  it("requires action, summary and context and enforces the limits", () => {
    const q = queue();
    const reject = (input: unknown, pattern: RegExp) =>
      assert.throws(() => q.add(A, SNAP, input), (error: unknown) => {
        assert.ok(error instanceof QueueInputError);
        assert.match(error.message, pattern);
        return true;
      });
    reject({ topic: "t", summary: "s.", context: "c.", ask: ASK }, /action: required/);
    reject(card({ summary: "", ask: ASK }), /summary: must not be empty/);
    reject(card({ context: undefined, ask: ASK }), /context: required/);
    reject(card({ action: "x".repeat(41), ask: ASK }), /action: at most 40 characters/);
    reject(card({ action: "two\nlines", ask: ASK }), /action: one line/);
    reject(card({ summary: "One. Two. Three. Four.", ask: ASK }), /summary: at most 3 sentences/);
    reject(card({ extra: 1, ask: ASK }), /extra: unknown field/);
    reject(card({ result: { label: "x", href: "relative/path" } }), /result\.href: an http\(s\) URL or an absolute path/);
    reject(card({ results: [{ label: "x", href: "relative/path" }] }), /results\[0\]\.href: an http\(s\) URL or an absolute path/);
    reject(card({ receipt: { title: "t", status: "done", conclusion: "c" } }), /status/);
    assert.equal(q.list().length, 0);
  });

  it("requires a one-line topic of at most 15 characters", () => {
    const q = queue();
    const reject = (input: unknown, pattern: RegExp) =>
      assert.throws(() => q.add(A, SNAP, input), (error: unknown) => error instanceof QueueInputError && pattern.test(error.message));
    reject(card({ topic: undefined, ask: ASK }), /topic: required/);
    reject(card({ topic: "  ", ask: ASK }), /topic: must not be empty/);
    reject(card({ topic: "x".repeat(16), ask: ASK }), /topic: at most 15 characters/);
    reject(card({ topic: "Docs\nredesign", ask: ASK }), /topic: one line/);
    reject(card({ topic: 3, ask: ASK }), /topic/);
    assert.equal(q.list().length, 0);
    assert.equal(one(q.add(A, SNAP, card({ topic: " Flaky CI ", ask: ASK }))).topic, "Flaky CI");
    assert.equal(one(q.add(B, SNAP, card({ topic: "x".repeat(15), ask: ASK }))).topic, "x".repeat(15));
  });

  it("accepts only http(s) URLs and absolute paths as result links", () => {
    const q = queue();
    for (const href of ["javascript:alert(1)", "file:///etc/passwd", "vscode://x", "data:text/html,<b>x</b>", "ftp://host/file", "relative/path", "http:/missing-slash"]) {
      assert.throws(
        () => q.add(A, SNAP, card({ result: { label: "x", href } })),
        (error: unknown) => error instanceof QueueInputError && /href: an http\(s\) URL or an absolute path/.test(error.message),
        href,
      );
    }
    assert.equal(q.list().length, 0, "a rejected link is an error, not silently dropped");
    const filed = q.add(A, SNAP, card({
      results: [
        { label: "page", href: "https://example.com/a?b=1" },
        { label: "local", href: "http://localhost:8000/updates#x" },
        { label: "file", href: "/home/u/x.md" },
      ],
    }));
    assert.deepEqual(filed.cards.map(({ card: c }) => c.results[0].href), ["https://example.com/a?b=1", "http://localhost:8000/updates#x", "/home/u/x.md"]);
  });

  it("expands ~/ in result links", () => {
    const q = queue();
    const c = one(q.add(A, SNAP, card({ result: { label: "guide", href: "~/Desktop/x.md" } })));
    assert.ok(c.results[0].href?.startsWith("/"));
    assert.ok(c.results[0].href?.endsWith("/Desktop/x.md"));
  });

  it("keeps sessions apart, and a new filing in a session takes missing session details from its open cards", () => {
    const q = queue();
    q.add(A, SNAP, card({ ask: ASK }));
    q.add(B, SNAP, card({ ask: ASK }));
    q.add({ host: "dsh", sessionId: "agent-a" }, SNAP, card({ ask: ASK }));
    assert.equal(q.list().length, 3, "the same short in another session is another card");
    const next = one(q.add(A, { model: "claude-sonnet-5-5" }, card({ result: { label: "page" } })));
    assert.equal(next.model, "claude-sonnet-5-5");
    assert.equal(next.sessionTitle, SNAP.sessionTitle);
    assert.equal(next.cwd, SNAP.cwd);
  });
});

describe("same item filed again", () => {
  it("updates the open card with the same short in place: same card, id and queue place", () => {
    const c = clock();
    const q = queue(c);
    const first = one(q.add(A, SNAP, card({ ask: ASK })));
    c.advance(60_000);
    q.add(A, SNAP, card({ result: { label: "page" } }));
    c.advance(60_000);
    const timeline = { asked: { date: "11/12", text: "Rerun the flaky test" }, did: { text: "Stopped by a check" }, stuck: { text: "Your call on retries" } };
    const again = q.add(A, { sessionTitle: "New title" }, card({ topic: "Flaky CI", timeline, ask: { ...ASK, question: "Rewritten question?", recommended: 1 } }));
    assert.equal(again.cards[0].outcome, "updated");
    const updated = again.cards[0].card;
    assert.equal(updated.id, first.id);
    assert.deepEqual(updated.asks, [{ id: "q1", ...ASK, question: "Rewritten question?", recommended: 1, resolved: false }]);
    assert.equal(updated.topic, "Flaky CI");
    assert.deepEqual(updated.timeline, timeline);
    assert.equal(updated.firstReadyAt, first.firstReadyAt, "an update keeps its place in the queue");
    assert.notEqual(updated.updatedAt, first.updatedAt);
    assert.equal(updated.sessionTitle, "New title", "snapshot refreshed");
    assert.equal(updated.cwd, SNAP.cwd, "missing snapshot values keep the old ones");
    assert.equal(q.list().length, 2);
  });

  it("matches a result by label and a receipt by title; an ask without short by its question", () => {
    const q = queue();
    const result = one(q.add(A, SNAP, card({ result: { label: "Nav before/after page", look: "old" } })));
    const receipt = one(q.add(A, SNAP, card({ receipt: { title: "Link check", status: "failed", conclusion: "Broken." } })));
    const plain = one(q.add(A, SNAP, card({ ask: { question: "Add a task to clean the CI cache?" } })));
    assert.equal(one(q.add(A, SNAP, card({ result: { label: "Nav before/after page", look: "new" } }))).id, result.id);
    assert.equal(q.get(result.id)?.results[0].look, "new");
    assert.equal(one(q.add(A, SNAP, card({ receipt: { title: "Link check", status: "returned", conclusion: "Fixed." } }))).id, receipt.id);
    assert.equal(q.get(receipt.id)?.receipts[0].status, "returned");
    assert.equal(one(q.add(A, SNAP, card({ ask: { question: "Add a task to clean the CI cache?", options: [{ label: "Add" }] } }))).id, plain.id);
    assert.equal(q.list().length, 3);
  });

  it("files a new card when the line differs, the kind differs, or the earlier card is closed", () => {
    const q = queue();
    const first = one(q.add(A, SNAP, card({ ask: ASK })));
    assert.notEqual(one(q.add(A, SNAP, card({ ask: { ...ASK, short: "Docs nav: cut long lists?" } }))).id, first.id);
    assert.notEqual(one(q.add(A, SNAP, card({ result: { label: ASK.short } }))).id, first.id);
    q.handBack(first.id);
    const after = q.add(A, SNAP, card({ ask: ASK }));
    assert.equal(after.cards[0].outcome, "created");
    assert.notEqual(after.cards[0].card.id, first.id);
  });

  it("never updates an older multi-item card or a host card in place", () => {
    const path = tempPath();
    const q = new Queue({ path });
    const legacy = insertLegacy(path, A, { asks: [{ id: "q1", ...ASK, resolved: false }, { id: "q2", question: "Q2?", resolved: false }] });
    const perm = q.addSystemAsk(A, SNAP, { id: "perm:r1", question: "Permission: Bash" }, { action: "x", summary: "y", context: "z" });
    const filed = one(q.add(A, SNAP, card({ ask: ASK })));
    assert.ok(![legacy, perm.id].includes(filed.id));
    assert.equal(q.get(legacy)?.asks.length, 2);
    q.close();
  });
});

describe("replaces", () => {
  it("closes the named card as superseded and puts the new card in its place", () => {
    const c = clock();
    const q = queue(c);
    const old = one(q.add(A, SNAP, card({ ask: ASK })));
    c.advance(1000);
    const other = one(q.add(A, SNAP, card({ result: { label: "page" } })));
    c.advance(1000);
    const filed = q.add(A, SNAP, card({ replaces: old.id, ask: { question: "Relax the retry policy?", short: "Flaky CI: relax the retry policy?" } }));
    const [{ card: next, outcome, replaced }] = filed.cards;
    assert.equal(outcome, "replaced");
    assert.equal(replaced, old.id);
    assert.equal(next.firstReadyAt, old.firstReadyAt, "the new card keeps the old one's place");
    assert.deepEqual(q.list().map((x) => x.id), [next.id, other.id]);
    const closed = q.get(old.id)!;
    assert.equal(closed.state, "done");
    assert.equal(closed.doneBy, "agent");
    assert.equal(closed.supersededBy, next.id);
    assert.ok(closed.asks.every((a) => a.resolved));
  });

  it("replaces an older multi-item card too", () => {
    const path = tempPath();
    const q = new Queue({ path });
    const legacy = insertLegacy(path, A, LEGACY_ITEMS);
    const next = one(q.add(A, SNAP, card({ replaces: legacy, result: { label: "nav.html" } })));
    assert.equal(q.get(legacy)?.supersededBy, next.id);
    assert.equal(next.firstReadyAt, "2026-11-11T19:00:00.000Z");
    q.close();
  });

  it("rejects a card of another session, a closed card and a card waiting on a permission, without writing", () => {
    const q = queue();
    const theirs = one(q.add(B, SNAP, card({ ask: ASK })));
    const closed = one(q.add(A, SNAP, card({ ask: ASK })));
    q.handBack(closed.id);
    const perm = q.addSystemAsk(A, SNAP, { id: "perm:r1", question: "Permission: Bash" }, { action: "x", summary: "y", context: "z" });
    const reject = (id: string, pattern: RegExp) =>
      assert.throws(() => q.add(A, SNAP, card({ replaces: id, ask: { question: "New question?" } })), (error: unknown) => error instanceof QueueInputError && pattern.test(error.message));
    reject(theirs.id, /is not a card of this session/);
    reject("c-missing", /is not a card of this session/);
    reject(closed.id, /is already closed/);
    reject(perm.id, /waits on a permission request/);
    assert.deepEqual(q.list().map((x) => x.id).sort(), [theirs.id, perm.id].sort());
  });
});

describe("resolve", () => {
  it("closes cards by id as the agent; cards, items and asks all take card ids", () => {
    const q = queue();
    const ids = [1, 2, 3, 4].map((n) => one(q.add(A, SNAP, card({ ask: { ...ASK, short: `Question ${n}?` } }))).id);
    const first = q.resolve(A, { cards: [ids[0]] });
    assert.deepEqual(first.cards.map((c) => [c.id, c.state, c.doneBy]), [[ids[0], "done", "agent"]]);
    assert.ok(first.cards[0].asks.every((a) => a.resolved));
    assert.deepEqual(first.open.map((c) => c.id), ids.slice(1));
    const rest = q.resolve(A, { items: [ids[1]], asks: [ids[2]] });
    assert.deepEqual(rest.cards.map((c) => c.state), ["done", "done"]);
    assert.deepEqual(rest.open.map((c) => c.id), [ids[3]]);
  });

  it("all closes every open card of the session and no other", () => {
    const q = queue();
    q.add(A, SNAP, card({ asks: [ASK, { question: "Q2?" }], results: [{ label: "page" }] }));
    const theirs = one(q.add(B, SNAP, card({ ask: ASK })));
    const done = q.resolve(A, { all: true });
    assert.equal(done.cards.length, 3);
    assert.ok(done.cards.every((c) => c.state === "done" && c.doneBy === "agent"));
    assert.deepEqual(done.open, []);
    assert.deepEqual(q.list().map((c) => c.id), [theirs.id]);
    assert.deepEqual(q.resolve(A, { all: true }), { cards: [], open: [] }, "nothing open is not an error");
  });

  it("leaves a card that is already closed as it is", () => {
    const q = queue();
    const c = one(q.add(A, SNAP, card({ ask: ASK })));
    q.handBack(c.id);
    const after = q.resolve(A, { cards: [c.id] });
    assert.equal(after.cards[0].doneBy, "user", "the user's close stands");
  });

  it("leaves pending permission requests open when it closes a card or all", () => {
    const q = queue();
    const perm = q.addSystemAsk(A, SNAP, { id: "perm:r1", question: "Permission: Bash" }, { action: "x", summary: "y", context: "z" });
    const err = q.addSystemAsk(A, SNAP, { id: "err:t1", question: "Error: overloaded" }, { action: "x", summary: "y", context: "z" });
    const after = q.resolve(A, { all: true });
    assert.deepEqual(after.open.map((c) => c.id), [perm.id]);
    assert.equal(q.get(err.id)?.state, "done");
  });

  it("rejects the whole call on an unknown id or another session's card, listing the session's open cards, without writing", () => {
    const q = queue();
    const mine = one(q.add(A, SNAP, card({ ask: ASK })));
    const theirs = one(q.add(B, SNAP, card({ ask: ASK })));
    assert.throws(
      () => q.resolve(A, { cards: [mine.id, "c-nope", theirs.id] }),
      (error: unknown) =>
        error instanceof QueueInputError &&
        error.issues.join("|") === `unknown id c-nope|${theirs.id} is not a card of this session|this session's open cards: ${mine.id} [q1]`,
    );
    assert.equal(q.get(mine.id)?.state, "open");
    assert.throws(() => q.resolve(A, {}), /cards: \[ids\] or all: true/);
    assert.throws(() => q.resolve(A, { cards: [mine.id], all: true }), /either cards or all/);
    assert.throws(() => q.resolve(A, { cards: mine.id }), /cards: must be a list/);
    assert.throws(() => q.resolve(C, { cards: ["q1"] }), /unknown id q1.*open cards: none/);
  });
});

describe("older multi-item cards", () => {
  function legacy() {
    const path = tempPath();
    const q = new Queue({ path });
    const id = insertLegacy(path, A, LEGACY_ITEMS);
    return { q, id };
  }

  it("read as before and are left whole", () => {
    const { q, id } = legacy();
    const c = q.get(id)!;
    assert.equal(soleItem(c), null);
    assert.deepEqual([c.asks.length, c.results.length, c.receipts.length], [2, 2, 1]);
    assert.equal(c.supersededBy, null);
    q.close();
  });

  it("resolve item by item, and close once every item is resolved", () => {
    const { q, id } = legacy();
    const after = q.resolve(A, { items: ["r2", "p1"] });
    const c = after.cards[0];
    assert.equal(c.state, "open");
    assert.deepEqual(c.results.map((r) => [r.id, r.resolved]), [["r1", false], ["r2", true]]);
    assert.deepEqual(c.receipts.map((r) => [r.id, r.resolved]), [["p1", true]]);
    assert.equal(q.resolve(A, { asks: ["r2"] }).cards[0].state, "open", "resolving a resolved item again is a no-op");
    const closed = q.resolve(A, { items: ["q1", "q2", "r1"] }).cards[0];
    assert.equal(closed.id, id);
    assert.equal(closed.state, "done");
    assert.equal(closed.doneBy, "agent");
    q.close();
  });

  it("an item id on more than one open card asks for card ids", () => {
    const { q, id } = legacy();
    const single = one(q.add(A, SNAP, card({ ask: ASK })));
    assert.throws(
      () => q.resolve(A, { items: ["q1"] }),
      (error: unknown) => error instanceof QueueInputError && error.issues[0] === `q1 is on several open cards (${id}, ${single.id}): pass card ids`,
    );
    assert.equal(q.resolve(A, { items: ["r1"] }).cards[0].id, id, "an id on one card is fine");
    q.close();
  });

  it("hand back like any card", () => {
    const { q, id } = legacy();
    const after = q.handBack(id);
    assert.equal(after.state, "done");
    assert.equal(after.doneBy, "user");
    assert.ok([...after.asks, ...after.results, ...after.receipts].every((item) => item.resolved));
    q.close();
  });
});

describe("handBack", () => {
  it("resolves the card's item and closes it as done by the user", () => {
    const q = queue();
    const c = one(q.add(A, SNAP, card({ ask: ASK })));
    const other = one(q.add(A, SNAP, card({ result: { label: "page" } })));
    const after = q.handBack(c.id);
    assert.equal(after.state, "done");
    assert.equal(after.doneBy, "user");
    assert.ok(after.asks[0].resolved);
    assert.equal(q.get(other.id)?.state, "open", "other cards of the session stay open");
    assert.throws(() => q.handBack(c.id), /is not open/);
    assert.throws(() => q.handBack("c-missing"), /unknown card/);
  });

  it("leaves a pending permission request open, and its card with it until the request is answered", () => {
    const path = tempPath();
    const q = new Queue({ path });
    const id = insertLegacy(path, A, {
      asks: [{ id: "q1", ...ASK, resolved: false }, { id: "perm:x1", question: "Permission: Bash", resolved: false }, { id: "err:t1", question: "Error: overloaded", resolved: false }],
      results: [{ id: "r1", label: "page", resolved: false }],
    });
    const after = q.handBack(id);
    assert.equal(after.state, "open");
    assert.deepEqual(
      [...after.asks, ...after.results].filter((item) => !item.resolved).map((item) => item.id),
      ["perm:x1"],
      "only the permission request is still open; the error ask closed with the rest",
    );
    assert.equal(q.resolveSystemAsks(A, { ids: ["perm:x1"] })[0]?.state, "done");
    q.close();
  });
});

describe("snooze and done", () => {
  it("snooze moves the card to the tail", () => {
    const c = clock();
    const q = queue(c);
    const a = one(q.add(A, SNAP, card({ ask: ASK })));
    c.advance(1000);
    q.add(B, SNAP, card({ ask: ASK }));
    c.advance(1000);
    q.add(C, SNAP, card({ ask: ASK }));
    assert.deepEqual(q.list().map((x) => x.sessionId), ["agent-a", "agent-b", "agent-c"]);
    const snoozed = q.snooze(a.id);
    assert.ok(snoozed.firstReadyAt > a.firstReadyAt);
    assert.deepEqual(q.list().map((x) => x.sessionId), ["agent-b", "agent-c", "agent-a"]);
  });

  it("snooze works even when the clock has not moved, and moves only that card", () => {
    const q = queue();
    const a = one(q.add(A, SNAP, card({ ask: ASK })));
    const a2 = one(q.add(A, SNAP, card({ result: { label: "page" } })));
    q.add(B, SNAP, card({ ask: ASK }));
    q.snooze(a.id);
    assert.equal(q.list()[0].id, a2.id);
    assert.equal(q.list().at(-1)?.id, a.id);
  });

  it("done by the user removes the card from the queue", () => {
    const q = queue();
    const a = one(q.add(A, SNAP, card({ ask: ASK })));
    const done = q.done(a.id, "user");
    assert.equal(done.state, "done");
    assert.equal(done.doneBy, "user");
    assert.equal(q.list().length, 0);
    assert.deepEqual(q.list({ state: "done" }).map((x) => x.id), [a.id]);
    assert.equal(q.done(a.id, "agent").doneBy, "user", "done is idempotent");
  });
});

describe("tracks", () => {
  it("track then return files a receipt card for the parent, under its last topic", () => {
    const q = queue();
    q.add(A, SNAP, card({ topic: "Flaky CI", ask: ASK }));
    const t = q.track("paseo", "agent-a", { title: "Retry log review", childRef: "child-1" });
    assert.equal(t.state, "running");
    assert.equal(t.parentSessionId, "agent-a");
    assert.deepEqual(q.listTracks().map((x) => x.id), [t.id]);
    const { track, card: c } = q.returnTrack(t.id, { status: "returned", conclusion: "2 of 7 runs still flaky." }, SNAP);
    assert.equal(track.state, "returned");
    assert.ok(track.endedAt);
    assert.ok(c);
    assert.equal(c.sessionId, "agent-a");
    assert.equal(c.action, RECEIPT_CARD_ACTION);
    assert.equal(c.topic, "Flaky CI");
    assert.equal(c.timeline, null);
    assert.equal(c.context, "Retry log review");
    assert.equal(c.summary, "2 of 7 runs still flaky.");
    assert.deepEqual(c.asks, []);
    assert.deepEqual(c.receipts, [
      { id: "p1", trackId: t.id, title: "Retry log review", status: "returned", conclusion: "2 of 7 runs still flaky.", childRef: "child-1", resolved: false },
    ]);
    assert.equal(q.openCards(A).length, 2, "its own card, apart from the session's ask");
    assert.equal(q.listTracks().length, 0);
    assert.equal(q.returnTrack(t.id, { status: "failed", conclusion: "x" }).card, null, "a returned track stays returned");
  });

  it("a session that never wrote a topic gets a receipt card without one", () => {
    const q = queue();
    const t = q.track("paseo", "agent-a", { title: "Wrap up branch B", childRef: "child-2" });
    const { card: c } = q.returnTrack(t.id, { status: "failed", conclusion: "Build failed." });
    assert.equal(c?.topic, null);
    assert.equal(c?.receipts[0].status, "failed");
    assert.equal(q.getTrack(t.id)?.state, "failed");
  });

  it("a track without a parent returns onto a card of the child itself", () => {
    const q = queue();
    assert.throws(() => q.track("paseo", null, { title: "x" }), /needs childRef/);
    const t = q.track("paseo", null, { title: "Wrap up branch A", childRef: "child-3" }, { startedAt: "2026-11-11T02:00:00.000Z" });
    assert.equal(t.startedAt, "2026-11-11T02:00:00.000Z");
    const { card: c } = q.returnTrack(t.id, { status: "returned", conclusion: "done" });
    assert.equal(c?.sessionId, "child-3");
  });

  it("matches children by full id or a short-id prefix", () => {
    const q = queue();
    q.track("paseo", "agent-a", { title: "full", childRef: "7ca8b81c-74f8-4b6c" });
    q.track("paseo", "agent-a", { title: "short", childRef: "7ca8b81" });
    q.track("paseo", "agent-a", { title: "too short", childRef: "7ca" });
    assert.deepEqual(q.runningTracksForChild("paseo", "7ca8b81c-74f8-4b6c").map((t) => t.title), ["full", "short"]);
    assert.deepEqual(q.runningTracksForChild("dsh", "7ca8b81c-74f8-4b6c"), []);
  });

  it("a receipt filed by the agent closes its track and updates the returned card with the same title", () => {
    const q = queue();
    const t = q.track("paseo", "agent-a", { title: "subagent review", childRef: "child-4" });
    const returned = q.returnTrack(t.id, { status: "returned", conclusion: "The child agent's last paragraph." }).card!;
    const filed = one(q.add(A, SNAP, card({ receipt: { trackId: t.id, title: "subagent review", status: "returned", conclusion: "Checked: good.", line: "Checked" } })));
    assert.equal(filed.id, returned.id);
    assert.equal(filed.receipts[0].line, "Checked");
    const t2 = q.track("paseo", "agent-a", { title: "another" });
    q.add(A, SNAP, card({ receipt: { trackId: t2.id, title: "another", status: "returned", conclusion: "ok." } }));
    assert.equal(q.getTrack(t2.id)?.state, "returned");
    assert.throws(() => q.add(B, SNAP, card({ receipt: { trackId: "t-nope", title: "x", status: "returned", conclusion: "y" } })), /unknown trackId/);
    assert.deepEqual(q.openCards(B), []);
  });
});

describe("host asks", () => {
  it("a permission ask is its own card under the session's topic, and closes once answered", () => {
    const q = queue();
    const agentCard = one(q.add(A, SNAP, card({ topic: "Flaky CI", ask: ASK })));
    const fallback = { action: "Approve permission", summary: "Bash · git push", context: "The session is paused." };
    const c = q.addSystemAsk(A, SNAP, { id: "perm:r1", question: "Permission: Bash · git push" }, fallback);
    assert.notEqual(c.id, agentCard.id);
    assert.equal(c.action, "Approve permission");
    assert.equal(c.topic, "Flaky CI");
    assert.equal(c.timeline, null);
    assert.deepEqual(c.asks.map((a) => [a.id, a.resolved]), [["perm:r1", false]]);
    assert.equal(q.addSystemAsk(A, SNAP, { id: "perm:r1", question: "Permission: Bash · git push --force" }, fallback).id, c.id, "the same request updates its card");
    const after = q.resolveSystemAsks(A, { ids: ["perm:r1"] });
    assert.deepEqual(after.map((x) => [x.id, x.state, x.doneBy]), [[c.id, "done", "agent"]]);
    assert.equal(q.get(agentCard.id)?.state, "open");
  });

  it("each failed turn is its own card; a completed turn closes them all", () => {
    const q = queue();
    const fallback = { action: "x", summary: "y", context: "z" };
    const e1 = q.addSystemAsk(A, SNAP, { id: "err:t1", question: "Error: rate limit" }, fallback);
    const e2 = q.addSystemAsk(A, SNAP, { id: "err:t2", question: "Error: overloaded" }, fallback);
    assert.notEqual(e1.id, e2.id);
    assert.equal(e1.topic, null, "no topic until the agent writes one");
    assert.deepEqual(q.resolveSystemAsks(A, { prefix: "err:" }).map((x) => x.state), ["done", "done"]);
    assert.deepEqual(q.resolveSystemAsks(A, { prefix: "err:" }), []);
  });

  it("host asks on an older card still close with it", () => {
    const path = tempPath();
    const q = new Queue({ path });
    const id = insertLegacy(path, A, { results: [{ id: "r1", label: "page", resolved: true }], asks: [{ id: "perm:x1", question: "Permission: Bash", resolved: false }] });
    assert.equal(q.resolveSystemAsks(A, { ids: ["perm:x1"] })[0]?.id, id);
    assert.equal(q.get(id)?.state, "done");
    q.close();
  });
});

describe("storage", () => {
  it("persists across connections in WAL mode", () => {
    const path = tempPath();
    const first = new Queue({ path });
    const a = one(first.add(A, SNAP, card({ ask: ASK })));
    const second = new Queue({ path });
    assert.deepEqual(second.list().map((x) => x.id), [a.id]);
    second.snooze(a.id);
    assert.ok(first.get(a.id)!.firstReadyAt >= a.firstReadyAt);
    first.close();
    second.close();
  });

  it("names a session by the topic its agent wrote last", () => {
    const c = clock();
    const q = queue(c);
    assert.equal(q.sessionTopic(A), null);
    const first = one(q.add(A, SNAP, card({ topic: "Old name", ask: ASK })));
    q.handBack(first.id);
    assert.equal(q.sessionTopic(A), "Old name", "closed cards count");
    c.advance(1000);
    q.add(A, SNAP, card({ topic: "New name", result: { label: "page" } }));
    assert.equal(q.sessionTopic(A), "New name");
  });
});

describe("migrations", () => {
  const version = (path: string) => {
    const raw = new DatabaseSync(path);
    const value = (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    raw.close();
    return value;
  };

  it("adds topic to a version 1 database and keeps its cards", () => {
    const path = tempPath();
    new Queue({ path }).close();
    const raw = new DatabaseSync(path);
    raw.exec(
      "DROP INDEX cards_by_session; ALTER TABLE cards DROP COLUMN superseded_by; ALTER TABLE cards DROP COLUMN agent; ALTER TABLE cards DROP COLUMN timeline; ALTER TABLE cards DROP COLUMN topic; PRAGMA user_version = 1;",
    );
    raw
      .prepare(
        `INSERT INTO cards (id, host, session_id, action, summary, context, state, first_ready_at, created_at, updated_at)
         VALUES ('c-v1', 'paseo', 'agent-a', 'See results', 'Done.', 'Round one.', 'open', '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z')`,
      )
      .run();
    raw.close();
    const q = new Queue({ path });
    assert.equal(q.get("c-v1")?.topic, null);
    assert.equal(q.get("c-v1")?.action, "See results");
    assert.equal(one(q.add(A, SNAP, card({ topic: "Added topic", ask: ASK }))).topic, "Added topic");
    q.close();
    assert.equal(version(path), 6);
  });

  it("version 6 lets a session hold several open cards, adds superseded_by, and leaves existing cards as they are", () => {
    const path = tempPath();
    new Queue({ path }).close();
    // A version 5 file as the code before one-card-per-item wrote it.
    const raw = new DatabaseSync(path);
    raw.exec(`DROP INDEX cards_by_session; ALTER TABLE cards DROP COLUMN superseded_by;
      CREATE UNIQUE INDEX cards_one_open_per_session ON cards (host, session_id) WHERE state = 'open';
      PRAGMA user_version = 5;`);
    raw.close();
    const id = insertLegacy(path, A, LEGACY_ITEMS);
    const rawRow = () => {
      const db = new DatabaseSync(path);
      const row = db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Record<string, unknown>;
      db.close();
      return row;
    };
    const before = rawRow();
    const q = new Queue({ path });
    assert.equal(version(path), 6);
    const after = rawRow();
    assert.equal(after.superseded_by, null);
    delete after.superseded_by;
    assert.deepEqual(after, before, "the older card is not migrated or split");
    one(q.add(A, SNAP, card({ ask: ASK })));
    one(q.add(A, SNAP, card({ result: { label: "page" } })));
    assert.equal(q.openCards(A).length, 3);
    const indexes = new DatabaseSync(path);
    const names = (indexes.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cards'").all() as { name: string }[]).map((r) => r.name);
    indexes.close();
    assert.ok(!names.includes("cards_one_open_per_session"));
    assert.ok(names.includes("cards_by_session"));
    q.close();
  });

  /** A version 2 file as the code before item ids wrote it: receipts without id, no `resolved` on results or receipts. */
  function versionTwoDb(): { path: string; openId: string; doneId: string } {
    const path = tempPath();
    const raw = new DatabaseSync(path);
    raw.exec(`CREATE TABLE cards (
        id TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, session_title TEXT, cwd TEXT, provider TEXT,
        model TEXT, action TEXT NOT NULL, summary TEXT NOT NULL, context TEXT NOT NULL, asks TEXT NOT NULL DEFAULT '[]',
        results TEXT NOT NULL DEFAULT '[]', receipts TEXT NOT NULL DEFAULT '[]', state TEXT NOT NULL, first_ready_at TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, done_at TEXT, done_by TEXT, topic TEXT);
      CREATE UNIQUE INDEX cards_one_open_per_session ON cards (host, session_id) WHERE state = 'open';
      CREATE TABLE tracks (id TEXT PRIMARY KEY, host TEXT NOT NULL, parent_session_id TEXT, child_ref TEXT, title TEXT NOT NULL,
        started_at TEXT NOT NULL, state TEXT NOT NULL, ended_at TEXT);
      PRAGMA user_version = 2;`);
    const insert = raw.prepare(
      `INSERT INTO cards (id, host, session_id, action, summary, context, asks, results, receipts, state, first_ready_at, created_at, updated_at, done_at, done_by, topic)
       VALUES (?, 'paseo', ?, 'See results', 'Done.', 'Round one.', ?, ?, ?, ?, '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z', ?, ?, 't')`,
    );
    const asks = JSON.stringify([{ id: "q1", question: "Q1?", resolved: true }]);
    const results = JSON.stringify([{ id: "r1", label: "page" }, { id: "r2", label: "file", href: "/x.md" }]);
    const receipts = JSON.stringify([
      { trackId: "t-1", title: "C1", status: "returned", conclusion: "ok." },
      { title: "C2", status: "failed", conclusion: "Broken." },
    ]);
    insert.run("c-open", "agent-a", asks, results, receipts, "open", null, null);
    insert.run("c-done", "agent-b", asks, results, receipts, "done", "2026-11-11T21:00:00.000Z", "user");
    raw.close();
    return { path, openId: "c-open", doneId: "c-done" };
  }

  it("version 3 gives receipts ids and results and receipts resolved: false, in place", () => {
    const { path, openId, doneId } = versionTwoDb();
    const q = new Queue({ path });
    q.close();
    assert.equal(version(path), 6);
    const raw = new DatabaseSync(path);
    for (const id of [openId, doneId]) {
      const row = raw.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Record<string, string>;
      assert.deepEqual(JSON.parse(row.results), [
        { id: "r1", label: "page", resolved: false },
        { id: "r2", label: "file", href: "/x.md", resolved: false },
      ]);
      assert.deepEqual(JSON.parse(row.receipts), [
        { id: "p1", trackId: "t-1", title: "C1", status: "returned", conclusion: "ok.", resolved: false },
        { id: "p2", title: "C2", status: "failed", conclusion: "Broken.", resolved: false },
      ]);
      assert.deepEqual(JSON.parse(row.asks), [{ id: "q1", question: "Q1?", resolved: true }], "asks untouched");
      assert.equal(row.updated_at, "2026-11-11T20:00:00.000Z", "a backfill is not an update");
    }
    raw.close();
  });

  it("gives ids to receipts that older code appends after the migration, stable until stored", () => {
    const { path, openId } = versionTwoDb();
    new Queue({ path }).close();
    // Older code still running appends receipts without id or resolved.
    const raw = new DatabaseSync(path);
    const row = raw.prepare("SELECT receipts, results FROM cards WHERE id = ?").get(openId) as { receipts: string; results: string };
    const receipts = [...JSON.parse(row.receipts), { title: "C3", status: "returned", conclusion: "Fixed." }];
    const results = [...JSON.parse(row.results), { id: "r3", label: "new page" }];
    raw.prepare("UPDATE cards SET receipts = ?, results = ? WHERE id = ?").run(JSON.stringify(receipts), JSON.stringify(results), openId);
    raw.close();
    const q = new Queue({ path });
    assert.deepEqual(q.get(openId)?.receipts.map((r) => [r.id, r.resolved]), [["p1", false], ["p2", false], ["p3", false]]);
    assert.deepEqual(q.get(openId)?.results.map((r) => [r.id, r.resolved]), [["r1", false], ["r2", false], ["r3", false]]);
    const after = q.resolve(A, { items: ["p3", "r3"] }).cards[0];
    assert.deepEqual(after.receipts.map((r) => [r.id, r.resolved]), [["p1", false], ["p2", false], ["p3", true]]);
    assert.equal(after.results[2].resolved, true);
    q.close();
  });

  it("reads items a re-filing replaced (dropped) on older cards, and resolves them without error", () => {
    const path = tempPath();
    const q = new Queue({ path });
    const id = insertLegacy(path, A, {
      asks: [{ id: "q2", question: "B?", resolved: false }, { id: "q1", question: "A?", resolved: true, dropped: true }],
    });
    const c = q.get(id)!;
    assert.equal(soleItem(c)?.item.id, "q2", "a dropped item is not shown, so the card holds one");
    assert.equal(q.resolve(A, { items: ["q1"] }).cards[0].state, "open");
    assert.equal(q.resolve(A, { items: ["q2"] }).cards[0].state, "done");
    q.close();
  });
});

describe("countSentences", () => {
  it("counts sentence ends in Chinese and English", () => {
    assert.equal(countSentences("三组页面精简做完，都还没上线 …"), 1);
    assert.equal(countSentences("做完了。还没上线！要上线吗？"), 3);
    assert.equal(countSentences("Done. Not shipped yet. See v0.15.3 notes."), 3);
    assert.equal(countSentences("main 比 GitHub 多 3 个 commit"), 1);
    assert.equal(countSentences("一。二。三。四"), 4);
  });
});

describe("displayWidth", () => {
  it("counts CJK and full-width characters 1 and ASCII 0.5", () => {
    assert.equal(displayWidth(""), 0);
    assert.equal(displayWidth("abcd"), 2);
    assert.equal(displayWidth("精简"), 2);
    assert.equal(displayWidth("changelog 精简"), 7);
    assert.equal(displayWidth("「还有 N 条」？"), 7.5);
    assert.equal(displayWidth("−2,300 字"), 5, "a wide minus sign counts 1");
  });
});

const TIMELINE = {
  asked: { date: "11/07", text: "Redesign the docs site navigation" },
  did: { date: "11/07", text: "Built 3 branches, none merged" },
  stuck: { text: "5 calls before merging" },
};

const NEW_ASK = {
  question: "Merging the three redesign branches needs a docs site rebuild to go live. Rebuild right after the merge?",
  short: "Docs site: rebuild right after merging?",
  options: [{ label: "Rebuild now", effect: "The new navigation goes live on every page" }, { label: "Do not rebuild" }],
  recommended: 0,
  whyNow: "The old blocker is gone: those 3 files are already live",
};

describe("recall-first fields", () => {
  const reject = (q: Queue, input: unknown, pattern: RegExp) =>
    assert.throws(() => q.add(A, SNAP, input), (error: unknown) => {
      assert.ok(error instanceof QueueInputError, String(error));
      assert.match(error.message, pattern);
      return true;
    });

  it("stores every new field and reads it back", () => {
    const q = queue();
    const filed = q.add(A, SNAP, card({
      timeline: TIMELINE,
      asks: [NEW_ASK],
      results: [{ label: "Nav before/after · 10 pages", href: "https://example.com/t.html", look: "Biggest change: /api −2,300 words" }],
      receipts: [{ title: "Archive old /guides pages", status: "returned", conclusion: "301 redirects tested.", line: "301 redirects tested" }],
    }));
    const [ask, result, receipt] = filed.cards.map(({ card: c }) => q.get(c.id)!);
    assert.deepEqual(ask.timeline, TIMELINE);
    assert.deepEqual(ask.asks[0], { id: "q1", ...NEW_ASK, resolved: false });
    assert.equal(result.results[0].look, "Biggest change: /api −2,300 words");
    assert.equal(receipt.receipts[0].line, "301 redirects tested");
    assert.deepEqual(q.list()[0], ask);
  });

  it("with a timeline, action, summary and context are optional and filled from it", () => {
    const q = queue();
    const c = one(q.add(A, SNAP, { topic: "Docs redesign", timeline: TIMELINE, ask: NEW_ASK }));
    assert.equal(c.action, "5 calls before merging");
    assert.equal(c.summary, "11/07 Built 3 branches, none merged");
    assert.equal(c.context, "11/07 Redesign the docs site navigation");
    const given = one(q.add(B, SNAP, card({ timeline: TIMELINE, ask: NEW_ASK })));
    assert.equal(given.action, card().action, "given text is kept");
    reject(q, { topic: "t", summary: "s.", context: "c.", ask: NEW_ASK }, /action: required/);
  });

  it("enforces display-width limits on the short fields", () => {
    const q = queue();
    const step = (over: Record<string, unknown>) => card({ ask: NEW_ASK, timeline: { ...TIMELINE, ...over } });
    reject(q, step({ asked: { date: "11/07", text: "w".repeat(37) } }), /timeline\.asked\.text: at most 18 wide/);
    assert.equal(q.add(C, SNAP, step({ asked: { date: "11/07", text: "w".repeat(36) } })).cards[0].outcome, "created", "18 wide fits");
    reject(q, step({ did: { text: "w".repeat(37) } }), /timeline\.did\.text: at most 18 wide/);
    reject(q, step({ stuck: { text: "w".repeat(41) } }), /timeline\.stuck\.text: at most 20 wide/);
    reject(q, card({ ask: { ...NEW_ASK, short: "w".repeat(61) } }), /ask\.short: at most 30 wide/);
    reject(q, card({ asks: [{ ...NEW_ASK, short: "two\nlines" }] }), /asks\[0\]\.short: one line/);
    reject(q, card({ ask: { ...NEW_ASK, options: [{ label: "w".repeat(25) }] } }), /ask\.options\[0\]\.label: at most 12 wide/);
    reject(q, card({ ask: { ...NEW_ASK, options: [{ label: "Yes", effect: "w".repeat(81) }] } }), /options\[0\]\.effect: at most 40 wide/);
    reject(q, card({ ask: { ...NEW_ASK, whyNow: "w".repeat(121) } }), /whyNow: at most 60 wide/);
    reject(q, card({ result: { label: "x", look: "w".repeat(45) } }), /result\.look: at most 22 wide/);
    reject(q, card({ receipt: { title: "t", status: "returned", conclusion: "c.", line: "w".repeat(53) } }), /receipt\.line: at most 26 wide/);
    reject(q, card({ ask: { ...NEW_ASK, options: [{ label: "Yes", extra: 1 }] } }), /options\[0\]\.extra: unknown field/);
  });

  it("takes full questions up to 400 characters", () => {
    const q = queue();
    assert.equal(one(q.add(A, SNAP, card({ ask: { ...NEW_ASK, question: "q".repeat(400) } }))).asks[0].question.length, 400);
    reject(q, card({ ask: { ...NEW_ASK, question: "q".repeat(401) } }), /ask\.question: at most 400 characters/);
  });

  it("recommended must index into options", () => {
    const q = queue();
    reject(q, card({ ask: { ...NEW_ASK, recommended: 2 } }), /recommended: an index into options, 0 to 1/);
    reject(q, card({ ask: { ...NEW_ASK, recommended: -1 } }), /recommended: an index into options/);
    reject(q, card({ ask: { ...NEW_ASK, recommended: 0.5 } }), /recommended: an index into options/);
    reject(q, card({ ask: { ...NEW_ASK, recommended: "0" } }), /recommended: an index into options/);
    reject(q, card({ ask: { question: "Q?", recommended: 0 } }), /recommended: needs options/);
    const filed = q.add(A, SNAP, card({ asks: [{ ...NEW_ASK, recommended: 1 }, { question: "Q?", options: [{ label: "Yes" }] }] }));
    const [first, second] = filed.cards.map(({ card: c }) => c.asks[0]);
    assert.equal(first.recommended, 1);
    assert.equal(second.recommended, undefined);
    assert.equal(second.short, undefined, "short is optional in core");
  });

  it("timeline dates are M/D and only asked and did have one", () => {
    const q = queue();
    const step = (over: Record<string, unknown>) => card({ ask: NEW_ASK, timeline: { ...TIMELINE, ...over } });
    reject(q, step({ asked: { date: "2026-11-07", text: "x" } }), /timeline\.asked\.date: M\/D/);
    reject(q, step({ asked: { date: "13/01", text: "x" } }), /timeline\.asked\.date: M\/D/);
    reject(q, step({ did: { date: "11/32", text: "x" } }), /timeline\.did\.date: M\/D/);
    reject(q, step({ asked: { text: "x" } }), /timeline\.asked\.date: required/);
    reject(q, step({ stuck: { date: "11/07", text: "x" } }), /timeline\.stuck\.date: unknown field/);
    reject(q, step({ stuck: undefined }), /timeline\.stuck: required/);
    reject(q, card({ ask: NEW_ASK, timeline: "11/07 done" }), /timeline: must be an object/);
    assert.equal(one(q.add(A, SNAP, step({ asked: { date: "1/7", text: "x" }, did: { text: "y" } }))).timeline?.did.date, undefined);
  });

  it("an update in place replaces the timeline, and a filing without one clears it", () => {
    const q = queue();
    const first = one(q.add(A, SNAP, card({ timeline: TIMELINE, ask: NEW_ASK })));
    const next = { ...TIMELINE, stuck: { text: "2 calls left" } };
    const updated = one(q.add(A, SNAP, card({ timeline: next, ask: NEW_ASK })));
    assert.equal(updated.id, first.id);
    assert.deepEqual(updated.timeline, next);
    const plain = one(q.add(A, SNAP, card({ action: "View 1 comparison page", ask: NEW_ASK })));
    assert.equal(plain.id, first.id);
    assert.equal(plain.timeline, null, "a timeline is replaced like action, not kept stale");
    assert.equal(plain.action, "View 1 comparison page");
  });

  it("old cards without the new fields still read", () => {
    const path = tempPath();
    new Queue({ path }).close();
    // A version 3 file as the code before timelines wrote it: no timeline column, old-style items.
    const raw = new DatabaseSync(path);
    raw.exec("DROP INDEX cards_by_session; ALTER TABLE cards DROP COLUMN superseded_by; ALTER TABLE cards DROP COLUMN agent; ALTER TABLE cards DROP COLUMN timeline; PRAGMA user_version = 3;");
    raw
      .prepare(
        `INSERT INTO cards (id, host, session_id, action, summary, context, asks, results, receipts, state, first_ready_at, created_at, updated_at, topic)
         VALUES ('c-old', 'paseo', 'agent-a', 'Decide 1 question', 'Done.', 'Round one.', ?, ?, ?, 'open', '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z', '2026-11-11T20:00:00.000Z', NULL)`,
      )
      .run(
        JSON.stringify([{ id: "q1", question: "Collapse long nav lists instead of cutting them?", recommendation: "Collapse", resolved: false }, { id: "perm:1", question: "Permission: Bash", resolved: false }]),
        JSON.stringify([{ id: "r1", label: "nav.html", note: "10 pages", resolved: false }]),
        JSON.stringify([{ id: "p1", title: "C1", status: "returned", conclusion: "Fixed.", resolved: false }]),
      );
    raw.close();
    const q = new Queue({ path });
    const old = q.get("c-old")!;
    assert.equal(old.timeline, null);
    assert.equal(old.topic, null);
    assert.equal(old.agent, null);
    assert.equal(old.supersededBy, null);
    assert.deepEqual(old.asks.map((a) => [a.id, a.short, a.options, a.recommendation]), [["q1", undefined, undefined, "Collapse"], ["perm:1", undefined, undefined, undefined]]);
    assert.equal(old.results[0].look, undefined);
    assert.equal(old.receipts[0].line, undefined);
    const filed = one(q.add(A, SNAP, card({ timeline: TIMELINE, ask: NEW_ASK })));
    assert.notEqual(filed.id, "c-old", "a new filing is a new card next to the older one");
    assert.deepEqual(q.get("c-old"), old);
    q.close();
  });
});

describe("agent meta", () => {
  const META = { plan: "Claude", modelLabel: "Opus 5.5", effort: "high", effortLabel: "high", parentSessionId: null, workspace: "docs-site" };

  it("stores the host's agent meta with the card and reads it back", () => {
    const q = queue();
    assert.deepEqual(one(q.add(A, { ...SNAP, agent: META }, card({ ask: ASK }))).agent, META);
    assert.equal(one(q.add({ host: "dsh", sessionId: "d1" }, SNAP, card({ ask: ASK }))).agent, null, "hosts that report none store null");
  });

  it("a filing without meta keeps the session's meta; one with meta replaces it", () => {
    const q = queue();
    q.add(A, { ...SNAP, agent: META }, card({ ask: ASK }));
    assert.equal(one(q.add(A, SNAP, card({ ask: ASK }))).agent?.plan, "Claude");
    assert.equal(one(q.add(A, SNAP, card({ result: { label: "page" } }))).agent?.plan, "Claude", "a new card of the session too");
    assert.equal(one(q.add(A, { agent: { ...META, effort: "xhigh" } }, card({ ask: ASK }))).agent?.effort, "xhigh");
  });

  it("refreshSnapshot updates who the session is on every open card, without touching content or queue place", () => {
    const q = queue();
    const first = one(q.add(A, { ...SNAP, agent: META }, card({ ask: { question: "Q?" } })));
    const second = one(q.add(A, { ...SNAP, agent: META }, card({ result: { label: "page" } })));
    const after = q.refreshSnapshot(A, { model: "claude-sonnet-5-5", agent: { ...META, modelLabel: "Sonnet 5.5", workspace: "api-server" } });
    assert.deepEqual(after.map((c) => [c.id, c.model, c.agent?.workspace]), [
      [first.id, "claude-sonnet-5-5", "api-server"],
      [second.id, "claude-sonnet-5-5", "api-server"],
    ]);
    assert.deepEqual(after[0].asks, first.asks);
    assert.equal(after[0].firstReadyAt, first.firstReadyAt);
    assert.deepEqual(q.refreshSnapshot({ host: "paseo", sessionId: "nobody" }, SNAP), []);
  });
});
