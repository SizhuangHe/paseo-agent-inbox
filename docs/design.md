# Agent inbox: design

One inbox of **cards** for things where the next step belongs to the user. Agents in Paseo file them through tools; agents on other hosts can file them through the CLI. The inbox is shown in Paseo. The user goes through cards one by one and jumps back into the session a card came from to continue there.

UI chrome (labels, buttons, section names, toasts, errors) is English. Card content is written by agents, in the user's language. The message the inbox sends into a session when the user answers is English by default and Chinese with `AGENT_INBOX_LANG=zh`.

## Decisions

- The unit is a **card**, not a session. Any agent at any depth (top-level or child) can file one.
- Criterion for filing: **the next step is the user's**: a decision only the user can make, or a result the user should look at. Not filed: things the agent can decide itself; questions inside an ongoing discussion the user is actively in; physical tasks for the user.
- Agents file cards themselves through a tool. The tool descriptions carry the filing criterion in two or three sentences; the full agent guide is `skill/SKILL.md`.
- When the user answers inside the session (not from the inbox), the **agent resolves the card itself**.
- **One card is one thing for the user**: exactly one ask, one result to review, one receipt (returned work), or one host request (permission or error). Each agent card has its own recall (`timeline`) about that thing; host cards have none. A session can have any number of open cards; the overview groups them under the session (its `topic`, agent line, oldest wait), a child session nested under the session that started it. Send, Seen and Dismiss act on one card. Filing the same line again updates that card; `replaces` swaps an open card for a new one. Cards filed before this (several items on one card) are kept as they are and shown in their older layout.
- Dispatched work that comes back is a card too (a *receipt* card of the dispatching session).
- Running work is **not** in the inbox body; only a collapsed `Running N` row lists registered dispatches.
- No model-based classifier: what reaches the inbox is what agents and host events file.

## Data model

Store: SQLite (WAL) at `~/.local/share/agent-queue/queue.db` (`AGENT_QUEUE_DB` overrides it), through Node's built-in `node:sqlite`. No npm runtime dependencies for the store. One core module owns the schema; everything else goes through it.

### Card

| field | who writes | meaning |
|---|---|---|
| `id` | system | stable id |
| `host` | system | `paseo` \| `dsh` (`dsh`: any host other than Paseo, filing through the CLI; the value is part of the stored schema) |
| `sessionId` | system | the host's session id (Paseo agent id), taken from the tool context, never from agent input |
| `sessionTitle`, `cwd`, `provider`, `model` | system | from the host's session snapshot at filing time, refreshed on each filing into the open card and after each turn of the session |
| `agent` | system | which agent it is, in the host's display names: `{plan, modelLabel, effort, effortLabel, parentSessionId, workspace}` (see "Agent line" under UI). Null on older cards and on hosts that report none |
| `topic` | agent | the session's name, the same on all its cards; host cards take the session's last topic |
| `timeline` | agent | the recall about this card's one thing: `{asked: {date, text}, did: {date?, text}, stuck: {text}}`, shown as You asked / It did / Blocked; `date` is M/D. Null on host cards, automatic receipt cards and older cards |
| `action` | agent | what the user needs to do, one line, at most 40 characters. Required without a timeline; filled from `stuck` when left out |
| `summary` | agent | what this round did and found, at most 3 sentences. Required without a timeline; filled from `did` |
| `context` | agent | what the session is about and how far it got, at most 3 sentences. Required without a timeline; filled from `asked` |
| `asks[]` | agent | decisions (one on cards filed since one-card-one-item, none on result and receipt cards): `{id, question, short?, options?: [{label, effect?}], recommended?, whyNow?, recommendation?, why?, resolved, dropped?}`. `recommended` indexes `options`; `recommendation` is the older free-text form; `dropped` marks an ask a re-filing replaced |
| `results[]` | agent | results to review: `{id, label, href?, note?, look?, resolved, dropped?}`. `href` is an http(s) URL or an absolute path; `look` is what to check |
| `receipts[]` | agent or system | dispatched work that came back: `{id, trackId?, title, status: returned \| failed, conclusion, line?, childRef?, resolved}`; `line` is the one-line conclusion |
| `state` | system | `open` \| `done` |
| `firstReadyAt` | system | queue order key (FIFO) |
| `supersededBy` | system | on a card closed by `replaces`, the card that took its place; null otherwise |
| `updatedAt`, `doneAt`, `doneBy` (`agent` \| `user`) | system | |

Short fields are limited in display width (CJK and full-width characters 1, ASCII 0.5; `displayWidth` in core): timeline `asked`/`did` 18, `stuck` 20, `short` 30, option `label` 12 and `effect` 40, `whyNow` 60, `look` 22, `line` 26. `topic` is at most 15 characters. In core and the CLI every recall-first field is optional and checked only when present; the plugin's `queue_add` requires `timeline` and `ask.short`.

Item ids are per card and stable: agent asks `q1, q2, …`, results `r1, r2, …`, receipts `p1, p2, …`, numbered within each type in filing order and never reused. A one-item card holds `q1`, `r1` or `p1`. Host asks use `perm:<request id>` and `err:<turn id>`. Prefixes keep every id unique on its card. Agents resolve by card id; item ids remain for older multi-item cards.

Filing (`add` in core): the input is `{topic, timeline, ask | result | receipt, replaces?}`, exactly one item. Core and the CLI also take the older lists (`asks`, `results`, `receipts`) and file one card per element, all with the call's `topic` and `timeline`; the plugin's `queue_add` takes only the singular form and points an agent sending lists to it. A filing with no item is rejected. For each item, in order:
- `replaces: <card id>` (one item only): that open card of the same session closes (`doneBy agent`, `supersededBy` = the new card) and the new card is inserted with its `firstReadyAt`, so it keeps the queue position. Rejected when the id is not this session's card, the card is closed, or it holds a pending permission request.
- Else, when an open card of the session holds one item of the same kind with the same line (the ask's `short`, else its `question`; the result `label`; the receipt `title`), that card is updated in place: topic, timeline and the item are rewritten, its item id and `firstReadyAt` are kept.
- Else a new card. The returned `Filing` says `created`, `updated` or `replaced`; the tool result gives the card id and lists the session's open cards.

A receipt with a `trackId` closes that track. `action` / `summary` / `context` are older fields: the tool no longer takes them; core fills them from the timeline (and the CLI still accepts them).

`Later` (snooze) sets `firstReadyAt = now` (moves to the tail).

Resolving: the agent closes each card as soon as it is handled, with `queue_resolve` `cards: [card ids]` (`items` and `asks` are aliases that take card ids too), or `all: true` for every open card of the session (a no-op when none is open). A named card that is already closed is left as it is. Item ids (`q1`, `r1`, `p1`) still resolve items of older multi-item cards; an item id that is on several open cards is rejected with the card ids to use. An unknown id, or a card of another session, rejects the whole call; the error lists the session's open cards. Closing a card leaves an open permission request on it alone.

Answering from the inbox: `Send` hands one card back. It sends the answer and the optional reply text into the card's Paseo session as one user message (`paseo.agents.ref(id).send(text, { activeTurnBehavior: "steer" })`, so a busy session gets it inside its running turn instead of being interrupted), then resolves the card's item and closes it (`doneBy user`); the session's other cards stay. The message (English set; `shared/messages.ts` holds both sets):
- an ask card: `(Answer from the inbox to a question in "<topic>"; this card is closed)`, then `<short> → <label> (recommended)` (`(recommended)` when the pick is the recommended option; just the question when there is only a reply), then the reply;
- a result card (reply only): `(Reply from the inbox to the result "<label>" in "<topic>"; this card is closed)`, then the reply; a receipt card likewise names the returned work;
- an older multi-item card: a header `(Answers from the inbox to the card "<topic>"; this card is closed)`, one line per picked ask, `Not answered: q3 <short>. Ask again later if needed.` when some asks were not picked, then the reply; every item on it is resolved. Open permission requests on such a card are left alone, because the session is still blocked on them: it stays open, showing just them, until each is answered.

It needs a pick or some reply text. Cards from other hosts have no Send.

Answering a permission request: host permission asks (`perm:<request id>`) carry what the request offers (`permission`: `{requestId, detail?, choices?: [{id, label, behavior}], questions?: [{header, question, options}]}`, built by the `agent.permission.before` hook the way Paseo's app builds its buttons: the request's `actions`, else `Deny` / `Accept` (`Implement` for a plan); a question request gets one row of option labels per question; multi-select questions get none and are answered in the session). Tapping a choice answers right away, apart from Send, because the session is blocked: the plugin checks the session's `pendingPermissions` (`paseo.agents.ref(id).refresh()`), then calls `respondToPermission({ requestId, response })` with the response Paseo's app sends (`{behavior: "allow", selectedActionId}`, `{behavior: "deny", selectedActionId, message: "Denied by user"}`, or `{behavior: "allow", updatedInput: {...input, answers: {header: label}}}`), and resolves the ask. A request that is no longer pending gets nothing sent; its ask is resolved and the row reads `Already answered`. If the response fails while the request is still pending, the error shows and the ask stays open.

Closing: a card becomes `done` when the user sends it back (`doneBy user`); when the agent closes it with `queue_resolve` or `replaces` (`doneBy agent`); by itself once every item on it is resolved, host asks included; or when the user presses `Seen` or `Dismiss` (`doneBy user`). Both go through the same `queue.done` RPC: on an ask card it first sends `(Skipped in the inbox, a question in "<topic>": <short> Don't wait for me; if you really need my decision, ask again separately.)` (an older multi-item card names every open ask); if that send fails the card stays open and the error shows. Result, receipt and error cards, and cards from other hosts, close silently. Open permission requests are never closed this way. `Later` is always silent.

Migrations run when a connection opens the file and stay additive (new JSON fields, nullable columns): after a code change the daemon may keep running the previous plugin code against the same file until the plugin is reloaded. Version 3 gave existing receipts ids and existing results and receipts `resolved: false`; items written without them by older code get them on read, in array order. Version 4 added the nullable `timeline` column; older code ignores it, its updates leave it as it is and its inserts leave it null. Version 5 added the nullable `agent` column (JSON), handled the same way. Version 6 dropped the unique index that allowed one open card per session, added the index `cards_by_session (host, session_id, state)` and the nullable `superseded_by` column; existing rows are untouched. Code from before version 6 keeps working on the file, reading the first open card of a session as that session's card; that degrades the one-item layout until the plugin is reloaded, but loses no data. `dropped` and `permission` live inside the ask and result JSON.

### Track (dispatched work)

`{id, host, parentSessionId, childRef?, title, startedAt, state: running | returned | failed, endedAt}`

- The dispatching agent calls `queue_track` when it dispatches (`childRef` = Paseo agent id when it used `paseo run`, otherwise free text).
- Paseo children with a `childRef`: the plugin watches `agent.turn.after` for that agent id and, on completed / failed, marks the track and files a receipt card in the **parent's** session (topic = the parent's last topic, no timeline, `action` = `Review returned work`, `context` = track title, `summary` = the child's last paragraph). The tail comes from `context.paseo.agents.ref(id).timeline.refetch({direction: "tail", limit})`; `timeline` in the event payload is always empty.
- Work Paseo cannot see (for example a coding agent's in-process subagents): the parent files the receipt itself with `queue_add` after it has verified the result, passing `trackId` to close the track.

## Deterministic cards (no agent involvement)

- `agent.permission.before` → a card of that session holding one ask `Permission: <tool / summary>`, with the request's choices (see "Answering a permission request"); the same request again updates that card; `agent.permission.after` → mark it resolved, which closes the card.
- `agent.turn.after` with outcome `failed` on a top-level session → a card holding one ask `Error: <message>`.
- Host cards take the session's last `topic` and the agent of its latest card, and have no timeline.
- `agent.turn.after` on a session with open cards → refresh their session snapshot (title, cwd, provider, model, `agent`).

## Components

1. **core** (`core/`): schema, migrations, add (one card per item; update in place; replaces) / hand back / resolve / snooze / done / track / list. TypeScript run directly by Node (type stripping), with `node:test` tests.
2. **CLI** (`bin/agent-queue`): thin wrapper over core for manual use, scripts and other agent hosts. `add` takes JSON on stdin and validates it, `--replaces CARD_ID` to swap a card; `resolve --card ID` (repeatable; `--item` and `--ask` are aliases) or `--all`. Session identity comes from `--host/--session` or env `AGENT_QUEUE_SESSION=<host>:<id>`.
3. **Paseo plugin** (`paseo-plugin/`, id `agent-queue`):
   - Server: `agent.open.before` contributes a plugin-owned MCP server (`agent-queue`) with the agent tools `queue_add` (one card per call: `ask`, `result` or `receipt`, optional `replaces`), `queue_track`, `queue_resolve` (`cards` or `all`; identity from the tool context) and env `AGENT_QUEUE_SESSION=paseo:<agentId>`. Hooks for tracks, permissions, failures, snapshot refresh. RPCs for the client: list, snooze, done, answer, permission. Settings come from the daemon's environment (`server/settings.ts`).
   - Tool descriptions carry the filing criterion, so agents that never read the guide still file correctly.
   - Client: sidebar header item + one screen (below).

The MCP server name, the tool names, the plugin id, `AGENT_QUEUE_SESSION` and the database path are what agents and existing installs depend on; they keep the earlier `agent-queue` naming.

## UI

Paseo native look: only `theme.colors` (surface0/1/2, border, foreground, foregroundMuted, accent, status*), React Native primitives, thin borders, generous spacing, no helper or explanatory text. Color only carries status. Must read well on a phone (compact) and on desktop.

Sidebar header row: `Inbox 3` (count of open cards; muted when 0).

```
Inbox 8                                        › Running 2
Docs redesign                                         4h   session header: topic · oldest wait
✻ Claude Work · Opus 5.5 · high · main  🗀 docs-site       agent line, muted
┌──────────────────────────────────────────────────────┐
│ Docs site: ship the new navigation?                  │  the item's line (tap → detail)
│ You asked ● 11/10 Redesign the docs navigation       │
│ It did    ● 11/12 3 branches built and tested        │  up to two lines each
│ Blocked   ● Your call on shipping                    │  dot in the status color
│ [Ship to all] [✓ Behind a flag] [Hold for now] [Send]│  recommended preselected
└──────────────────────────────────────────────────────┘
┌ Before/after comparison · recall · Biggest change… ↗  [Seen] ┐  result: look, ↗ opens / ⧉ copies
Flaky CI                                              3h
…
│  CI bisect                                         2h   child session, nested one level
│  ✻ Claude · Sonnet 5.5 · high · child of Flaky CI
│  ┌ Bisect the flaky upload test · recall · ✓ line [Seen] ┐  receipt: line
Prepare the 2.4 release                              40m
┌ Bash · Push the release branch to GitHub  [Deny] [Accept] ┐  host card: no recall

‹ Inbox                                            4h   (one card)
Docs redesign
✻ Claude Work · Opus 5.5 · high · main  🗀 docs-site
Docs site: ship the new navigation?
[ You asked / It did / Blocked ]
full question · whyNow · options with effect, recommended + why
[ Reply… ]
[Send] [Open session]                            Later   Dismiss
```

- Groups: open cards grouped by `host + sessionId`, in the order of each group's oldest `firstReadyAt` (children included); cards inside in queue order. A child session (parent from the latest card's `agent.parentSessionId`, the host's `paseo.parent-agent-id` label, else a track whose `childRef` is the session) nests under the top of its parent chain, one level deep. A parent with no open cards still gets its header, muted, named by `sessionTitles` (its last topic, else the host's title). A chain that loops leaves each session at the top.
- Group header: the latest card's `topic` (else the session title), the group's own oldest wait, the agent line of its latest card.
- Item card: the line (`short`, result `label`, receipt `title`; a host request or error in its status color, two lines at most), the three recall steps (two lines each; none on host cards and cards without a timeline), then:
  - ask with options: chips (tap picks, tap again clears; the recommended one starts picked), the picked option's `effect`, and `Send` (filled; enabled once something is picked). An ask with nothing to pick shows `Reply ›`, which opens the detail;
  - result: the `look` (else `note`, else the link) with ↗ for a URL (opens) or ⧉ for an absolute path (copies), and `Seen`;
  - receipt: ✓ or ✕ and the `line` (else the conclusion), and `Seen`;
  - permission: its choices (a tap answers at once) or `Answer in session`;
  - error: `Open session ›` and `Seen`.
- Item detail: topic and agent line, the line as the title, the recall box, then the full question, `whyNow`, every option with its `effect` (recommended tagged, with `why`); a result's look, note and link (a path shown in full, selectable, with `Copy path`); a receipt's status and full conclusion; a permission request in full with its choices. Footer: `Reply…` and `Send` on asks and results; `Seen` on results, receipts and errors; `Open session`; `Later`; `Dismiss` on asks.
- Older multi-item cards: under their session header as a card with the recall and counts (`1 approve · 1 review ›`); their detail lists the items by section (Permission, Decide, Approve, Review, Returned) with `Send N answers`.
- Copying a path: Paseo's `copyText`, else (plain-http web, where the async clipboard is missing or rejects) a hidden textarea and `document.execCommand("copy")`, run inside the tap when the clipboard is known to be missing. When both fail there is no error toast: the card shows the full path as selectable text. `Path copied` on success.
- Status color: has unresolved asks → `statusWarning`; error → `statusDanger`; results / receipts only → `accent`.
- Permission rows: the request in one line, › for the full request (tool, description, command, path or plan); chips for its choices, or one row of chips per question (the last pick answers). While the answer is on its way the chips are disabled; then the row reads `✓ Allowed`, `Denied`, `✓ Sent` or `Already answered`. Requests with nothing to pick, and cards from other hosts, show `Answer in session`.
- `Open session`: Paseo cards → `openAgent({agentId})`; cards from other hosts → the page `AGENT_INBOX_EXTERNAL_URL` names (`{session}` replaced by the session id), hidden when it is unset.
- Waited and running times read `36m`, `2h`, `3d`.
- Agent line (group header and detail, under the topic, muted 12 px): provider logo, then `plan · model · effort · role`, then a folder glyph and the workspace.
  - Logo: the icon Paseo shows for the provider (copied into `client/provider-icons.ts`: Claude, Codex, OpenCode), picked by the provider id or its prefix before `-` (`claude-work` → Claude); a dot for others.
  - `plan`: the provider's display name from `paseo.providers.snapshot()`, else the provider id. `model`: the model's display label from the same snapshot, else the id shortened (`claude-opus-5-5` → `Opus 5.5`, `opencode-go/kimi-k3.1-pro` → `kimi-k3.1-pro`). `effort`: the label of the effective thinking option from the snapshot, else its id; left out when none. Role: `main`, or `child of <parent's card topic or session title>`.
  - Workspace: the Paseo workspace `name`, else the cwd with the home directory as `~` (`~` alone for home). On the same row when everything fits, else on its own row below; items never wrap inside.
- On a phone (390 px) the footer buttons fit on one row only with the tighter compact spacing; keep new footer buttons out or re-measure.
- `Running`: collapsed; expands to rows `title · session · 12m` (dispatching session, time running).
- Empty state: one line `Nothing waiting` plus the `Running` row.
- Toasts: `Sent`, `Path copied`. Errors shown to the user are English.

## Out of scope

A model-based classifier; stuck detection; a UI outside Paseo; notifications beyond the sidebar count.
