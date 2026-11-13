import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXPANDED_UP_TO,
  groupSessions,
  groupWorkspaces,
  isFolded,
  latestCard,
  NO_WORKSPACE,
  sessionFoldKey,
  summarize,
  workspaceFoldedByDefault,
  workspaceFoldKey,
  type SessionGroup,
  type WorkspaceGroup,
} from "./groups.ts";
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

/** `card` run in a Paseo workspace (`ws`) or, with `ws` null, only in a directory (`cwd`). */
function inWorkspace(c: QueueCard, ws: string | null, cwd: string | null = null): QueueCard {
  return { ...c, cwd, agent: { ...c.agent, workspace: ws } };
}

const ask = (id: string, resolved = false) => ({ id, question: id, resolved });

/** The workspaces as `name: session session[child]`, so a failing test shows the shape. */
function workspaceShape(workspaces: WorkspaceGroup[]): string[] {
  const session = (g: SessionGroup): string =>
    g.children.length ? `${g.sessionId}[${g.children.map(session).join(" ")}]` : g.sessionId;
  return workspaces.map((w) => `${w.name}: ${w.sessions.map(session).join(" ")}`);
}

const HOME = "/home/u";
const workspacesOf = (cards: QueueCard[], childOf: Record<string, string | null> = {}) =>
  groupWorkspaces(groupSessions(cards, childOf), HOME);

describe("groupWorkspaces", () => {
  it("groups sessions by the Paseo workspace name, else the cwd shown with ~", () => {
    const cards = [
      inWorkspace(card("ci", 1), "api-server"),
      inWorkspace(card("docs", 2), "docs-site"),
      inWorkspace(card("release", 3), "api-server"),
      inWorkspace(card("home", 4), null, HOME),
      inWorkspace(card("script", 5), null, `${HOME}/bin`),
      inWorkspace(card("other", 6), null, "/srv/app"),
      card("bare", 7),
    ];
    assert.deepEqual(workspaceShape(workspacesOf(cards)), [
      "api-server: ci release",
      "docs-site: docs",
      "~: home",
      "~/bin: script",
      "/srv/app: other",
      `${NO_WORKSPACE}: bare`,
    ]);
  });

  it("takes the workspace from the session's latest card", () => {
    const older = inWorkspace(card("s", 1), "old-name");
    const newer = { ...inWorkspace(card("s", 2), "new-name"), updatedAt: "2026-11-12T11:00:00.000Z" };
    assert.deepEqual(workspaceShape(workspacesOf([older, newer])), ["new-name: s"]);
  });

  it("keeps a child under its parent when the child runs in another workspace", () => {
    const cards = [
      inWorkspace(card("ci", 1), "api-server"),
      inWorkspace(card("ci-child", 2, "ci"), null, HOME),
      inWorkspace(card("tracked", 3), "tools"),
      inWorkspace(card("docs", 4), "docs-site"),
    ];
    assert.deepEqual(workspaceShape(workspacesOf(cards, { tracked: "ci" })), ["api-server: ci[ci-child tracked]", "docs-site: docs"]);
  });

  it("puts a parent without open cards in its children's workspace", () => {
    const cards = [inWorkspace(card("child-a", 2, "gone"), "~"), inWorkspace(card("child-b", 3, "gone"), "api-server")];
    assert.deepEqual(workspaceShape(workspacesOf(cards)), ["api-server: gone[child-a child-b]"]);
  });

  it("orders workspaces by their oldest card, a child's included, and keeps the session order inside", () => {
    const cards = [
      inWorkspace(card("docs", 5), "docs-site"),
      inWorkspace(card("release", 9), "api-server"),
      inWorkspace(card("ci", 7), "api-server"),
      inWorkspace(card("ci-child", 1, "ci"), "elsewhere"),
      inWorkspace(card("blog", 3), "blog"),
    ];
    const workspaces = workspacesOf(cards);
    assert.deepEqual(workspaceShape(workspaces), ["api-server: ci[ci-child] release", "blog: blog", "docs-site: docs"]);
    assert.equal(workspaces[0].oldest, "2026-11-12T10:01:00.000Z");
  });

  it("returns nothing for no sessions", () => {
    assert.deepEqual(groupWorkspaces([], HOME), []);
  });
});

describe("summarize", () => {
  it("counts top-level sessions, every open card (children's included) and pending permissions", () => {
    const cards = [
      inWorkspace(card("ci", 4), "api"),
      inWorkspace(card("ci", 6), "api"),
      inWorkspace(card("ci-child", 2, "ci"), "api"),
      { ...inWorkspace(card("release", 5), "api"), asks: [ask("perm:r1")] },
    ];
    const [api] = workspacesOf(cards);
    assert.deepEqual(summarize(api.sessions), { sessions: 2, waiting: 4, permissions: 1, oldest: "2026-11-12T10:02:00.000Z", status: "permission" });
    // A folded session header: its own cards and its children's.
    const ci = api.sessions[0];
    assert.deepEqual(summarize([ci]), { sessions: 1, waiting: 3, permissions: 0, oldest: "2026-11-12T10:02:00.000Z", status: "review" });
  });

  it("puts a pending permission first, then a decision, then something to review or returned work", () => {
    const status = (...cards: QueueCard[]) => summarize(groupSessions(cards, {})).status;
    const permission = { ...card("a", 1), asks: [ask("perm:x")] };
    const decision = { ...card("b", 2), asks: [ask("q1")] };
    const error = { ...card("c", 3), asks: [ask("err:t1")] };
    const review = card("d", 4);
    assert.equal(status(review, decision, permission), "permission");
    assert.equal(status(review, decision), "decide");
    assert.equal(status(review, error), "decide");
    assert.equal(status(review), "review");
    assert.equal(summarize([]).status, null);
  });

  it("ignores asks that are answered or were replaced", () => {
    const answered = { ...card("a", 1), asks: [ask("perm:x", true), { ...ask("q1"), dropped: true }] };
    assert.deepEqual(summarize(groupSessions([answered], {})), {
      sessions: 1, waiting: 1, permissions: 0, oldest: "2026-11-12T10:01:00.000Z", status: "review",
    });
  });
});

describe("folding", () => {
  it(`starts every workspace expanded up to ${EXPANDED_UP_TO} open cards and folded above that`, () => {
    assert.equal(EXPANDED_UP_TO, 10);
    assert.equal(workspaceFoldedByDefault(0), false);
    assert.equal(workspaceFoldedByDefault(10), false);
    assert.equal(workspaceFoldedByDefault(11), true);
  });

  it("keeps what the user chose per workspace and session key over the default", () => {
    const [docs] = workspacesOf([inWorkspace(card("docs", 1), "docs-site")]);
    const session = docs.sessions[0];
    const chosen = new Map([[workspaceFoldKey(docs), false], [sessionFoldKey(session), true]]);
    assert.equal(workspaceFoldKey(docs), "workspace:docs-site");
    assert.equal(sessionFoldKey(session), "session:paseo:docs");
    assert.equal(isFolded(chosen, workspaceFoldKey(docs), workspaceFoldedByDefault(11)), false);
    assert.equal(isFolded(chosen, sessionFoldKey(session), false), true);
    assert.equal(isFolded(new Map(), workspaceFoldKey(docs), workspaceFoldedByDefault(11)), true);
    assert.equal(isFolded(new Map(), "workspace:api", workspaceFoldedByDefault(10)), false);
  });
});
