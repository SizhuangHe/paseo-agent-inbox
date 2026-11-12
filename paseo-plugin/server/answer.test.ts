import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Queue } from "agent-inbox-core";
import { askKind, composeAnswerMessage, composeSkipMessage, screenOrder, singleItem } from "../shared/cards.ts";
import { messageLang } from "../shared/messages.ts";
import { answerCard, dismissCard } from "./answer.ts";

const A = { host: "paseo", sessionId: "agent-a" } as const;

const TIMELINE = {
  asked: { date: "11/12", text: "Redesign the docs nav" },
  did: { date: "11/12", text: "Built and tested 3 branches" },
  stuck: { text: "Your call on merging" },
};

/** A queue on a temp file, so an older multi-item card can be written into it directly. */
function tempQueue() {
  const path = join(mkdtempSync(join(tmpdir(), "agent-queue-answer-")), "queue.db");
  return { queue: new Queue({ path }), path };
}

/** The docs session's three cards: two asks and a result, one call each. */
function fixture() {
  const { queue, path } = tempQueue();
  const file = (item: Record<string, unknown>) =>
    queue.add(A, { sessionTitle: "docs redesign" }, { topic: "Docs redesign", timeline: TIMELINE, ...item }).cards[0].card;
  const ship = file({
    ask: {
      question: "The new docs navigation is ready on three branches. Ship it to everyone now, or behind a feature flag first?",
      short: "Docs site: ship the new navigation?",
      options: [{ label: "Ship to all", effect: "Everyone sees the new nav today" }, { label: "Behind a flag" }],
      recommended: 1,
    },
  });
  const cleanup = file({
    ask: {
      question: "The preview builds left 1.4 GB of files in the build cache. Delete them?",
      short: "Docs site: delete old preview builds?",
      options: [{ label: "Delete" }, { label: "Keep" }],
    },
  });
  const page = file({ result: { label: "Before/after comparison page", look: "Biggest change: API reference" } });
  return { queue, path, ship, cleanup, page };
}

const DOCS_ASKS = [
  {
    id: "q1",
    question: "Replace the search index with the rebuilt one?",
    short: "Docs site: switch to the rebuilt search index?",
    options: [{ label: "Use old draft" }, { label: "Rebuild, then switch" }, { label: "Keep as is" }],
    recommended: 1,
    resolved: false,
  },
  {
    id: "q2",
    question: "The three redesign branches need a redeploy to go live after the merge. Redeploy right after merging?",
    short: "Docs site: redeploy right after merging?",
    options: [{ label: "Redeploy now", effect: "The redesign goes live at once" }, { label: "Wait" }],
    resolved: false,
  },
  {
    id: "q3",
    question: "Two lists on the changelog page show only the first 100 entries; collapse the rest behind a toggle?",
    recommendation: 'Collapse to "N more"',
    resolved: false,
  },
  { id: "q4", question: "Add a to-do for the stale screenshots?", resolved: false },
];

/** An older card that holds several items, as filed before one card held one thing; written straight into the file. */
function insertLegacy(path: string, extra: { asks?: unknown[] } = {}): string {
  const raw = new DatabaseSync(path);
  const id = `c-legacy-${Math.random().toString(16).slice(2, 8)}`;
  const at = "2026-11-11T19:00:00.000Z";
  raw
    .prepare(
      `INSERT INTO cards (id, host, session_id, session_title, action, summary, context, asks, results, receipts, state, first_ready_at, created_at, updated_at, topic)
       VALUES (?, 'paseo', ?, 'review docs', 'Decide 4 questions, look at 1 page', 'Done.', 'First round.', ?, ?, '[]', 'open', ?, ?, ?, 'Docs redesign')`,
    )
    .run(
      id,
      A.sessionId,
      JSON.stringify([...DOCS_ASKS, ...(extra.asks ?? [])]),
      JSON.stringify([{ id: "r1", label: "Comparison page", look: "Biggest change: API reference", resolved: false }]),
      at,
      at,
      at,
    );
  raw.close();
  return id;
}

function legacyFixture(extra: { asks?: unknown[] } = {}) {
  const { queue, path } = tempQueue();
  const id = insertLegacy(path, extra);
  const card = queue.get(id);
  assert.ok(card);
  return { queue, card };
}

function fakeSend() {
  const sent: { sessionId: string; text: string }[] = [];
  return {
    sent,
    send: async (sessionId: string, text: string) => {
      sent.push({ sessionId, text });
    },
  };
}

const openIds = (queue: Queue) => queue.openCards(A).map((card) => card.id);

/** The question of the older card's q3 cut to 40 characters, as a pick line shows it. */
const Q3_CUT = "Two lists on the changelog page show onl…";

describe("ask kinds", () => {
  it("sorts asks into think, nod and plain, and orders think and plain before nod", () => {
    const { card } = legacyFixture();
    assert.deepEqual(card.asks.map((a) => [a.id, askKind(a)]), [["q1", "nod"], ["q2", "think"], ["q3", "nod"], ["q4", "plain"]]);
    assert.deepEqual(screenOrder(card.asks).map((a) => a.id), ["q2", "q4", "q1", "q3"]);
    assert.equal(askKind({ id: "perm:1", question: "Permission: Bash", resolved: false }), "plain");
  });
});

describe("singleItem", () => {
  it("finds the one ask, result or receipt on a card, and none on an older multi-item card", () => {
    const { ship, page } = fixture();
    assert.deepEqual(singleItem(ship), { kind: "ask", item: ship.asks[0] });
    assert.deepEqual(singleItem(page), { kind: "result", item: page.results[0] });
    assert.equal(singleItem(legacyFixture().card), null);
  });

  it("does not count replaced items", () => {
    const { ship } = fixture();
    const replaced = { ...ship, asks: [{ id: "q0", question: "Old question?", resolved: true, dropped: true }, ...ship.asks] };
    assert.equal(singleItem(replaced)?.item.id, "q1");
  });
});

describe("composeAnswerMessage", () => {
  const HEADER = '(Answer from the inbox to a question in "Docs redesign"; this card is closed)';

  it("on an ask card, sends the question with the pick, marking the recommended one, then the reply", () => {
    const { ship, cleanup } = fixture();
    assert.equal(composeAnswerMessage(ship, { q1: 1 }), `${HEADER}\nDocs site: ship the new navigation? → Behind a flag (recommended)`);
    assert.equal(
      composeAnswerMessage(cleanup, { q1: 0 }, "  List the files first  "),
      [HEADER, "Docs site: delete old preview builds? → Delete", "List the files first"].join("\n"),
    );
  });

  it("on an ask card with only a reply, sends the question then the reply", () => {
    const { ship } = fixture();
    assert.equal(
      composeAnswerMessage(ship, {}, "Wait until I read the review"),
      [HEADER, "Docs site: ship the new navigation?", "Wait until I read the review"].join("\n"),
    );
  });

  it("on a result or receipt card, names it and sends the reply", () => {
    const { queue, page } = fixture();
    assert.equal(
      composeAnswerMessage(page, {}, "The second chart is unclear"),
      '(Reply from the inbox to the result "Before/after comparison page" in "Docs redesign"; this card is closed)\nThe second chart is unclear',
    );
    const receipt = queue.add(A, {}, { topic: "Docs redesign", timeline: TIMELINE, receipt: { title: "Link check", status: "returned", conclusion: "All 412 links resolve." } })
      .cards[0].card;
    assert.equal(
      composeAnswerMessage(receipt, {}, "Thanks"),
      '(Reply from the inbox to the returned work "Link check" in "Docs redesign"; this card is closed)\nThanks',
    );
  });

  describe("on an older multi-item card", () => {
    const HEAD = '(Answers from the inbox to the card "Docs redesign"; this card is closed)';

    it("writes one line per pick in screen order, marking the recommended pick, then the asks left unanswered", () => {
      const { card } = legacyFixture();
      assert.equal(
        composeAnswerMessage(card, { q1: 1, q2: 0 }),
        [
          HEAD,
          "q2 Docs site: redeploy right after merging? → Redeploy now",
          "q1 Docs site: switch to the rebuilt search index? → Rebuild, then switch (recommended)",
          `Not answered: q4 Add a to-do for the stale screenshots?; q3 ${Q3_CUT} Ask again later if needed.`,
        ].join("\n"),
      );
    });

    it("has no unanswered line when every open ask is picked, and ends with the reply", () => {
      const { queue, card } = legacyFixture();
      queue.resolve(A, { items: ["q4"] });
      const now = queue.get(card.id);
      assert.ok(now);
      assert.equal(
        composeAnswerMessage(now, { q1: 0, q2: 1, q3: 0 }, "  Tell me before the release  "),
        [
          HEAD,
          "q2 Docs site: redeploy right after merging? → Wait",
          "q1 Docs site: switch to the rebuilt search index? → Use old draft",
          `q3 ${Q3_CUT} → Collapse to "N more" (recommended)`,
          "Tell me before the release",
        ].join("\n"),
      );
      assert.equal([..."Two lists on the changelog page show onl"].length, 40);
    });

    it("a reply alone lists every open ask as unanswered", () => {
      const { card } = legacyFixture();
      assert.equal(
        composeAnswerMessage(card, {}, "I'll answer these in the session"),
        [
          HEAD,
          `Not answered: q2 Docs site: redeploy right after merging?; q4 Add a to-do for the stale screenshots?; q1 Docs site: switch to the rebuilt search index?; q3 ${Q3_CUT} Ask again later if needed.`,
          "I'll answer these in the session",
        ].join("\n"),
      );
    });

    it("leaves host asks and replaced asks out, and falls back to the session title without a topic", () => {
      const { card } = legacyFixture();
      const asks = [...card.asks, { id: "perm:1", question: "Permission: Bash", resolved: false }, { id: "q9", question: "Old question?", resolved: true, dropped: true }];
      const text = composeAnswerMessage({ ...card, topic: null, asks }, { q1: 1, q2: 1, q3: 0, q4: 0 });
      assert.match(text, /^\(Answers from the inbox to the card "review docs"; this card is closed\)\n/);
      assert.doesNotMatch(text, /perm:1|q9|Not answered/);
    });
  });
});

describe("answerCard", () => {
  it("sends one message with the card's one answer and closes only that card", async () => {
    const { queue, ship, cleanup, page } = fixture();
    const fake = fakeSend();
    const after = await answerCard({ queue, send: fake.send }, ship.id, { q1: 0 }, "Ping me when it is live");
    assert.deepEqual(fake.sent, [
      {
        sessionId: "agent-a",
        text: [
          '(Answer from the inbox to a question in "Docs redesign"; this card is closed)',
          "Docs site: ship the new navigation? → Ship to all",
          "Ping me when it is live",
        ].join("\n"),
      },
    ]);
    assert.equal(after.state, "done");
    assert.equal(after.doneBy, "user");
    assert.ok(after.asks[0].resolved);
    assert.deepEqual(queue.get(ship.id), after);
    assert.deepEqual(openIds(queue), [cleanup.id, page.id]);
  });

  it("sends a reply on a result card and closes it", async () => {
    const { queue, ship, cleanup, page } = fixture();
    const fake = fakeSend();
    const after = await answerCard({ queue, send: fake.send }, page.id, {}, "The second chart is unclear");
    assert.equal(
      fake.sent[0].text,
      '(Reply from the inbox to the result "Before/after comparison page" in "Docs redesign"; this card is closed)\nThe second chart is unclear',
    );
    assert.equal(after.state, "done");
    assert.deepEqual(openIds(queue), [ship.id, cleanup.id]);
  });

  it("leaves a pending permission request open on its own card", async () => {
    const { queue, ship } = fixture();
    const perm = queue.addSystemAsk(A, {}, { id: "perm:r1", question: "Permission: Bash" }, { action: "x", summary: "y", context: "z" });
    const fake = fakeSend();
    await answerCard({ queue, send: fake.send }, ship.id, { q1: 1 });
    assert.equal(queue.get(perm.id)?.state, "open");
    assert.doesNotMatch(fake.sent[0].text, /perm:r1|Permission/);
  });

  it("resolves nothing when the send fails", async () => {
    const { queue, ship } = fixture();
    const failing = async () => {
      throw new Error("daemon unreachable");
    };
    await assert.rejects(answerCard({ queue, send: failing }, ship.id, { q1: 0 }), /daemon unreachable/);
    assert.equal(queue.get(ship.id)?.state, "open");
    assert.equal(queue.get(ship.id)?.asks[0].resolved, false);
  });

  it("rejects bad picks and an empty send without sending", async () => {
    const { queue, ship } = fixture();
    const fake = fakeSend();
    const plain = queue.add(A, {}, { topic: "Docs redesign", timeline: TIMELINE, ask: { question: "Which browser should the next test run use?" } }).cards[0].card;
    const reject = (cardId: string, picks: Record<string, number>, pattern: RegExp, reply = "") =>
      assert.rejects(answerCard({ queue, send: fake.send }, cardId, picks, reply), pattern);
    await reject(ship.id, {}, /Nothing to send/);
    await reject(ship.id, {}, /Nothing to send/, "   ");
    await reject(ship.id, { q9: 0 }, /q9 is not on this card/);
    await reject(ship.id, { q1: 2 }, /q1 has no option 3/);
    await reject(plain.id, { q1: 0 }, /q1 has no options/);
    assert.equal(fake.sent.length, 0);
  });

  it("refuses cards from an external host and closed cards", async () => {
    const { queue, ship } = fixture();
    const fake = fakeSend();
    const external = queue.add({ host: "dsh", sessionId: "s1" }, {}, {
      topic: "Other host",
      timeline: TIMELINE,
      ask: { question: "Q?", short: "Q?", options: [{ label: "Yes" }] },
    }).cards[0].card;
    await assert.rejects(answerCard({ queue, send: fake.send }, external.id, { q1: 0 }), /Only Paseo cards can be answered from the inbox/);
    queue.done(ship.id, "user");
    await assert.rejects(answerCard({ queue, send: fake.send }, ship.id, { q1: 0 }), /This card is already closed/);
    await assert.rejects(answerCard({ queue, send: fake.send }, "c-missing", { q1: 0 }), /unknown card/);
    assert.equal(fake.sent.length, 0);
  });

  it("returns the card as it is when the session closed it while the message was on its way", async () => {
    const { queue, ship } = fixture();
    const closing = async () => {
      queue.resolve(A, { cards: [ship.id] });
    };
    const after = await answerCard({ queue, send: closing }, ship.id, { q1: 0 });
    assert.equal(after.state, "done");
    assert.equal(after.doneBy, "agent");
  });

  describe("on an older multi-item card", () => {
    it("sends every pick in one message, then closes the card with every item resolved", async () => {
      const { queue, card } = legacyFixture();
      const fake = fakeSend();
      const after = await answerCard({ queue, send: fake.send }, card.id, { q2: 1, q1: 1 });
      assert.equal(fake.sent.length, 1);
      assert.equal(fake.sent[0].text, composeAnswerMessage(card, { q2: 1, q1: 1 }));
      assert.match(fake.sent[0].text, /Not answered: q4 .*; q3 /);
      assert.equal(after.state, "done");
      assert.equal(after.doneBy, "user");
      assert.ok([...after.asks, ...after.results].every((item) => item.resolved), "unpicked asks and unopened results too");
    });

    it("rejects an ask that is already answered", async () => {
      const { queue, card } = legacyFixture();
      queue.resolve(A, { items: ["q1"] });
      await assert.rejects(answerCard({ queue, send: fakeSend().send }, card.id, { q1: 0 }), /q1 is already answered/);
    });

    it("leaves a pending permission request on it open, and the card with it", async () => {
      const { queue, card } = legacyFixture({ asks: [{ id: "perm:r1", question: "Permission: Bash", resolved: false }] });
      const fake = fakeSend();
      const after = await answerCard({ queue, send: fake.send }, card.id, { q2: 0 });
      assert.equal(after.state, "open");
      assert.deepEqual([...after.asks, ...after.results].filter((item) => !item.resolved).map((item) => item.id), ["perm:r1"]);
      assert.doesNotMatch(fake.sent[0].text, /perm:r1/);
    });
  });
});

describe("dismissCard", () => {
  it("on an ask card, tells the session that one ask was skipped, then closes only that card", async () => {
    const { queue, ship, cleanup, page } = fixture();
    const fake = fakeSend();
    const after = await dismissCard({ queue, send: fake.send }, ship.id);
    assert.deepEqual(fake.sent, [
      {
        sessionId: "agent-a",
        text:
          '(Skipped in the inbox, a question in "Docs redesign": Docs site: ship the new navigation? ' +
          "Don't wait for me; if you really need my decision, ask again separately.)",
      },
    ]);
    assert.equal(after.state, "done");
    assert.equal(after.doneBy, "user");
    assert.deepEqual(openIds(queue), [cleanup.id, page.id]);
  });

  it("Seen: closes a result, receipt or error card silently, and external-host cards too", async () => {
    const { queue, page } = fixture();
    const fake = fakeSend();
    const receipt = queue.add(A, {}, { topic: "Docs redesign", timeline: TIMELINE, receipt: { title: "Link check", status: "returned", conclusion: "Done." } }).cards[0].card;
    const error = queue.addSystemAsk(A, {}, { id: "err:t1", question: "Error: overloaded" }, { action: "x", summary: "y", context: "z" });
    const external = queue.add({ host: "dsh", sessionId: "s1" }, {}, { topic: "Other host", timeline: TIMELINE, ask: { question: "Q?", options: [{ label: "Yes" }] } }).cards[0].card;
    for (const card of [page, receipt, error, external]) {
      const after = await dismissCard({ queue, send: fake.send }, card.id);
      assert.equal(after.state, "done", card.id);
      assert.equal(after.doneBy, "user");
    }
    assert.equal(fake.sent.length, 0);
    assert.equal(composeSkipMessage(page), null);
  });

  it("keeps the card open when the send fails", async () => {
    const { queue, ship } = fixture();
    const failing = async () => {
      throw new Error("session is gone");
    };
    await assert.rejects(dismissCard({ queue, send: failing }, ship.id), /session is gone/);
    assert.equal(queue.get(ship.id)?.state, "open");
    assert.equal(queue.get(ship.id)?.asks[0].resolved, false);
  });

  it("returns a closed card as it is, and rejects an unknown one", async () => {
    const { queue, ship } = fixture();
    const fake = fakeSend();
    queue.done(ship.id, "user");
    assert.equal((await dismissCard({ queue, send: fake.send }, ship.id)).state, "done");
    await assert.rejects(dismissCard({ queue, send: fake.send }, "c-missing"), /unknown card/);
    assert.equal(fake.sent.length, 0);
  });

  describe("on an older multi-item card", () => {
    it("names every skipped ask, then closes the card", async () => {
      const { queue, card } = legacyFixture();
      const fake = fakeSend();
      queue.resolve(A, { items: ["q1"] });
      const after = await dismissCard({ queue, send: fake.send }, card.id);
      assert.equal(after.state, "done");
      assert.equal(
        fake.sent[0].text,
        '(Skipped in the inbox, the card "Docs redesign", not answered: q2 Docs site: redeploy right after merging?; ' +
          `q4 Add a to-do for the stale screenshots?; q3 ${Q3_CUT} ` +
          "Don't wait for me on these; if one really needs my decision, ask again separately.)",
      );
    });

    it("leaves a pending permission request open: the card stays, showing only it", async () => {
      const { queue, card } = legacyFixture({ asks: [{ id: "perm:r1", question: "Permission: Bash", resolved: false }] });
      const fake = fakeSend();
      const after = await dismissCard({ queue, send: fake.send }, card.id);
      assert.equal(fake.sent.length, 1, "the skipped asks are still reported");
      assert.equal(after.state, "open");
      assert.deepEqual([...after.asks, ...after.results].filter((item) => !item.resolved).map((item) => item.id), ["perm:r1"]);
      // Dismissing again sends nothing more and leaves the request open.
      assert.equal((await dismissCard({ queue, send: fake.send }, card.id)).state, "open");
      assert.equal(fake.sent.length, 1);
    });
  });
});

describe("Chinese messages (AGENT_INBOX_LANG=zh)", () => {
  it("reads the language from the setting: zh and its regional forms are Chinese, anything else English", () => {
    for (const value of ["zh", "zh-CN", "ZH_tw", " zh "]) assert.equal(messageLang(value), "zh", value);
    for (const value of [undefined, null, "", "en", "zhx", "fr"]) assert.equal(messageLang(value), "en", String(value));
  });

  it("answers an ask, a result and a receipt in Chinese", () => {
    const { queue, ship, page } = fixture();
    assert.equal(
      composeAnswerMessage(ship, { q1: 1 }, "等我看完再说", "zh"),
      ["（从队列回答「Docs redesign」的问题，这张卡已关闭）", "Docs site: ship the new navigation?→ Behind a flag（推荐）", "等我看完再说"].join("\n"),
    );
    assert.equal(composeAnswerMessage(page, {}, "第二张图看不懂", "zh"), "（从队列回复「Docs redesign」的结果「Before/after comparison page」，这张卡已关闭）\n第二张图看不懂");
    const receipt = queue.add(A, {}, { topic: "Docs redesign", timeline: TIMELINE, receipt: { title: "Link check", status: "returned", conclusion: "Done." } })
      .cards[0].card;
    assert.equal(composeAnswerMessage(receipt, {}, "好", "zh"), "（从队列回复「Docs redesign」的回执「Link check」，这张卡已关闭）\n好");
  });

  it("answers an older multi-item card in Chinese, naming the asks left unanswered", () => {
    const { card } = legacyFixture();
    assert.equal(
      composeAnswerMessage(card, { q1: 1, q2: 0 }, "", "zh"),
      [
        "（从队列回答「Docs redesign」卡，这张卡已关闭）",
        "q2 Docs site: redeploy right after merging?→ Redeploy now",
        "q1 Docs site: switch to the rebuilt search index?→ Rebuild, then switch（推荐）",
        `没答的：q4 Add a to-do for the stale screenshots?、q3 ${Q3_CUT}；需要的话下次再问。`,
      ].join("\n"),
    );
  });

  it("skips an ask, and an older card's asks, in Chinese", () => {
    const { ship } = fixture();
    assert.equal(
      composeSkipMessage(ship, "zh"),
      "（从队列跳过「Docs redesign」的问题：Docs site: ship the new navigation?先不用等我；真需要我定，下次单独问。）",
    );
    const { queue, card } = legacyFixture();
    queue.resolve(A, { items: ["q1"] });
    const now = queue.get(card.id);
    assert.ok(now);
    assert.equal(
      composeSkipMessage(now, "zh"),
      "（从队列跳过「Docs redesign」卡，没回答：q2 Docs site: redeploy right after merging?；" +
        `q4 Add a to-do for the stale screenshots?；q3 ${Q3_CUT}` +
        "。这些先不用等我；真需要我定，下次单独问。）",
    );
  });

  it("sends Send and Dismiss messages in the language the deps name", async () => {
    const { queue, ship, cleanup } = fixture();
    const fake = fakeSend();
    await answerCard({ queue, send: fake.send, lang: "zh" }, ship.id, { q1: 0 });
    await dismissCard({ queue, send: fake.send, lang: "zh" }, cleanup.id);
    assert.deepEqual(
      fake.sent.map((m) => m.text),
      [
        "（从队列回答「Docs redesign」的问题，这张卡已关闭）\nDocs site: ship the new navigation?→ Ship to all",
        "（从队列跳过「Docs redesign」的问题：Docs site: delete old preview builds?先不用等我；真需要我定，下次单独问。）",
      ],
    );
  });
});
