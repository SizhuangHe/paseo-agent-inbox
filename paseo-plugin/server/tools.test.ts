import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Queue } from "agent-inbox-core";
import { z } from "zod";
import { createQueueTools } from "./tools.ts";

const timeline = {
  asked: { date: "11/07", text: "Redesign the docs site navigation" },
  did: { date: "11/07", text: "Built 3 branches, none merged" },
  stuck: { text: "Your call on rebuilding" },
};
const ask = {
  question: "Merging the three redesign branches needs a docs site rebuild to go live. Rebuild right after the merge?",
  short: "Docs site: rebuild right after merging?",
  options: [{ label: "Rebuild now", effect: "The new navigation goes live on every page" }, { label: "Do not rebuild" }],
};
const result = { label: "Nav before/after page", look: "Biggest change: /api" };
const receipt = { title: "Link check", status: "returned", conclusion: "2 of 7 pages need fixes." };

function tools() {
  const queue = new Queue({ path: ":memory:" });
  const all = createQueueTools(() => queue);
  const get = (name: string) => all.find((t) => t.name === name)!;
  const context = { agentId: "agent-a", paseo: null };
  const add = (input: Record<string, unknown>) => get("queue_add").run(get("queue_add").input.parse({ topic: "Docs redesign", timeline, ...input }), context);
  const resolve = (input: Record<string, unknown>) => get("queue_resolve").run(get("queue_resolve").input.parse(input), context);
  return { queue, tool: get("queue_add"), resolveTool: get("queue_resolve"), add, resolve };
}

const issues = (parsed: { success: boolean; error?: z.ZodError }) =>
  parsed.error?.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") ?? "";

describe("queue_add schema", () => {
  it("takes topic, timeline and one ask, result or receipt", () => {
    const { tool } = tools();
    for (const item of [{ ask }, { result }, { receipt }]) {
      const parsed = tool.input.safeParse({ topic: "Docs redesign", timeline, ...item });
      assert.equal(parsed.success, true, issues(parsed));
    }
    const parse = (input: Record<string, unknown>) => issues(tool.input.safeParse({ topic: "t", timeline, ...input }));
    assert.match(issues(tool.input.safeParse({ topic: "t", ask })), /^timeline: /);
    assert.match(parse({ ask: { question: "Q?" } }), /ask\.short: /);
    assert.match(parse({ ask: { ...ask, recommended: 2 } }), /ask\.recommended: an index into options/);
    assert.match(parse({ timeline: { ...timeline, asked: { date: "2026-11-07", text: "x" } }, ask }), /timeline\.asked\.date: M\/D/);
    assert.match(parse({ timeline: { ...timeline, stuck: { text: "w".repeat(41) } }, ask }), /at most 20 wide/);
  });

  it("takes exactly one item: none or two is an error saying one card holds one thing", () => {
    const { tool } = tools();
    const message = ": give exactly one of ask, result or receipt: one card holds one thing for the user; file each in its own call";
    assert.equal(issues(tool.input.safeParse({ topic: "t", timeline })), message);
    assert.equal(issues(tool.input.safeParse({ topic: "t", timeline, ask, result })), message);
  });

  it("points the older lists to one call per item, and no longer takes action, summary or context", () => {
    const { tool } = tools();
    assert.equal(
      issues(tool.input.safeParse({ topic: "t", timeline, asks: [ask], results: [result] })),
      ": one card per call: give ask, result or receipt (singular); file each item in its own call",
    );
    assert.match(issues(tool.input.safeParse({ topic: "t", timeline, ask, action: "View 1 page" })), /Unrecognized key: "action"/);
  });

  it("publishes a JSON schema with the singular items and replaces", () => {
    const { tool } = tools();
    const schema = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }) as {
      required: string[];
      properties: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
    };
    assert.deepEqual(schema.required.sort(), ["timeline", "topic"]);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["ask", "receipt", "replaces", "result", "timeline", "topic"]);
    assert.ok(schema.properties.ask.required?.includes("short"));
    assert.ok(schema.properties.ask.properties?.options);
    assert.ok(schema.properties.result.properties?.look);
    assert.ok(schema.properties.receipt.properties?.line);
  });
});

describe("queue_add", () => {
  it("files one card and returns its id, with the session's open cards", async () => {
    const { queue, add } = tools();
    const first = await add({ ask });
    assert.equal(first.isError, undefined, first.text);
    const [card] = queue.list();
    assert.equal(card.action, "Your call on rebuilding");
    assert.equal(
      first.text,
      `Filed card ${card.id} ask "Docs site: rebuild right after merging?". Your open cards: ${card.id} ask "Docs site: rebuild right after merging?". ` +
        "Resolve each with queue_resolve cards: [id] as soon as it is handled.",
    );
    const second = await add({ result });
    const page = queue.list().find((c) => c.id !== card.id)!;
    assert.match(second.text, new RegExp(`^Filed card ${page.id} result "Nav before/after page"\\. Your open cards: ${card.id} ask .*; ${page.id} result "Nav before/after page"\\.`));
  });

  it("filing the same short again updates that card in place", async () => {
    const { queue, add } = tools();
    await add({ ask });
    const again = await add({ ask: { ...ask, options: [{ label: "Rebuild now" }, { label: "Let me check first" }] } });
    const cards = queue.list();
    assert.equal(cards.length, 1);
    assert.match(again.text, new RegExp(`^Updated card ${cards[0].id} ask "Docs site: rebuild right after merging\\?" in place`));
    assert.equal(cards[0].asks[0].options?.[1].label, "Let me check first");
  });

  it("replaces: closes the named card and files this one in its place", async () => {
    const { queue, add } = tools();
    await add({ ask });
    const old = queue.list()[0];
    const text = (await add({ ask: { ...ask, short: "Docs site: which branch merges first?" }, replaces: old.id })).text;
    const [now] = queue.list();
    assert.match(text, new RegExp(`^Filed card ${now.id} ask "Docs site: which branch merges first\\?" in place of ${old.id}, which is now closed\\.`));
    assert.equal(queue.get(old.id)?.state, "done");
    assert.equal(queue.get(old.id)?.supersededBy, now.id);
    assert.equal(now.firstReadyAt, old.firstReadyAt);
    const bad = await add({ result, replaces: "c-missing" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /replaces: c-missing is not a card of this session/);
  });

  it("a receipt with trackId closes that track", async () => {
    const { queue, add } = tools();
    const track = queue.track("paseo", "agent-a", { title: "Link check" });
    await add({ receipt: { ...receipt, trackId: track.id } });
    assert.equal(queue.getTrack(track.id)?.state, "returned");
  });
});

describe("queue_resolve", () => {
  it("closes cards by id, then all of this session's open cards", async () => {
    const { queue, add, resolve } = tools();
    await add({ ask });
    await add({ result });
    await add({ receipt });
    const [a, r, p] = queue.list();
    assert.equal((await resolve({ cards: [a.id] })).text, `Closed ${a.id}. Your open cards: ${r.id} result "Nav before/after page"; ${p.id} receipt "Link check".`);
    assert.equal((await resolve({ all: true })).text, `Closed ${r.id}, ${p.id}. You have no open cards.`);
    assert.equal(queue.list().length, 0);
  });

  it("takes card ids under items and asks too", async () => {
    const { queue, add, resolve } = tools();
    await add({ ask });
    await add({ result });
    const [a, r] = queue.list();
    assert.match((await resolve({ items: [a.id] })).text, new RegExp(`^Closed ${a.id}\\.`));
    assert.match((await resolve({ asks: [r.id] })).text, new RegExp(`^Closed ${r.id}\\. You have no open cards\\.`));
  });

  it("needs card ids or all, and reports unknown ids as tool errors", async () => {
    const { resolveTool, resolve } = tools();
    assert.equal(issues(resolveTool.input.safeParse({})), ": give cards: [ids] or all: true");
    assert.equal(issues(resolveTool.input.safeParse({ all: true, cards: ["c-1"] })), ": give cards: [ids] or all: true");
    const bad = await resolve({ cards: ["c-missing"] });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /unknown id c-missing/);
  });
});
