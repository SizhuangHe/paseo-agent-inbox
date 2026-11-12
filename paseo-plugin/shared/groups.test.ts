import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupSessions, latestCard, type SessionGroup } from "./groups.ts";
import type { QueueCard } from "./rpc.ts";

let n = 0;
/** An open card of `sessionId`, ready at minute `minute`; `parent` is the host's parent label. */
function card(sessionId: string, minute: number, parent: string | null = null, host: QueueCard["host"] = "paseo"): QueueCard {
  const at = `2026-11-12T10:${String(minute).padStart(2, "0")}:00.000Z`;
  n += 1;
  return {
    id: `c-${n}`, host, sessionId, sessionTitle: null, cwd: null, provider: null, model: null,
    agent: parent ? { parentSessionId: parent } : null, topic: sessionId, timeline: null, action: "a", summary: "s", context: "c",
    asks: [], results: [], receipts: [], state: "open", firstReadyAt: at, createdAt: at, updatedAt: at, doneAt: null, doneBy: null,
  };
}

/** The tree as `session(card ids) [children]`, so a failing test shows the shape. */
function shape(groups: SessionGroup[]): string[] {
  return groups.map((g) => {
    const own = `${g.placeholder ? "~" : ""}${g.sessionId}(${g.cards.map((c) => c.firstReadyAt.slice(14, 16)).join(",")})`;
    return g.children.length ? `${own} [${shape(g.children).join(" ")}]` : own;
  });
}

describe("groupSessions", () => {
  it("groups cards by session, in the order of each session's oldest card", () => {
    const cards = [card("ci", 5), card("docs", 1), card("ci", 2), card("docs", 9)];
    assert.deepEqual(shape(groupSessions(cards, {})), ["docs(01,09)", "ci(05,02)"]);
    assert.equal(groupSessions(cards, {})[1].oldest, "2026-11-12T10:02:00.000Z");
  });

  it("nests a child session under its parent, by the host's label or else the dispatch tracks", () => {
    const cards = [card("ci", 3), card("docs", 1), card("tracked", 7), card("ci-child", 4, "ci")];
    assert.deepEqual(shape(groupSessions(cards, { tracked: "ci" })), ["docs(01)", "ci(03) [ci-child(04) tracked(07)]"]);
  });

  it("orders groups by their oldest card, children included", () => {
    const cards = [card("docs", 1), card("ci", 5), card("ci-child", 0, "ci")];
    assert.deepEqual(shape(groupSessions(cards, {})), ["ci(05) [ci-child(00)]", "docs(01)"]);
  });

  it("gives a parent without open cards a placeholder header, so its children still sit under it", () => {
    const groups = groupSessions([card("child-a", 4, "gone"), card("child-b", 2, "gone"), card("docs", 3)], {});
    assert.deepEqual(shape(groups), ["~gone() [child-b(02) child-a(04)]", "docs(03)"]);
    assert.equal(groups[0].placeholder, true);
    assert.equal(groups[0].oldest, "2026-11-12T10:02:00.000Z");
  });

  it("nests one level only: a grandchild sits beside its parent under the top session", () => {
    const cards = [card("top", 1), card("mid", 2, "top"), card("leaf", 3, "mid")];
    assert.deepEqual(shape(groupSessions(cards, {})), ["top(01) [mid(02) leaf(03)]"]);
    assert.deepEqual(shape(groupSessions([card("mid", 2, "top"), card("leaf", 3, "mid")], {})), ["~top() [mid(02) leaf(03)]"]);
  });

  it("takes the parent from the session's latest card, ignores a session naming itself, and survives a loop", () => {
    const older = card("s", 1, "x");
    const newer = { ...card("s", 2, "y"), updatedAt: "2026-11-12T11:00:00.000Z" };
    assert.deepEqual(shape(groupSessions([older, newer], {})), ["~y() [s(01,02)]"]);
    assert.deepEqual(shape(groupSessions([card("self", 1, "self")], {})), ["self(01)"]);
    assert.deepEqual(shape(groupSessions([card("a", 1, "b"), card("b", 2, "a")], {})), ["a(01)", "b(02)"]);
  });

  it("keeps hosts apart: an external-host session does not nest under a Paseo one with the same id", () => {
    const cards = [card("ci", 1), card("ext-child", 2, "ci", "dsh")];
    const groups = groupSessions(cards, {});
    assert.deepEqual(groups.map((g) => g.key), ["paseo:ci", "dsh:ci"]);
    assert.equal(groups[1].placeholder, true);
  });

  it("returns nothing for no cards", () => {
    assert.deepEqual(groupSessions([], {}), []);
  });
});

describe("latestCard", () => {
  it("is the most recently updated card, null for none", () => {
    const a = card("s", 1);
    const b = { ...card("s", 2), updatedAt: "2026-11-12T12:00:00.000Z" };
    assert.equal(latestCard([a, b])?.id, b.id);
    assert.equal(latestCard([]), null);
  });
});
