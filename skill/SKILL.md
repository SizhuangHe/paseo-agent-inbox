---
name: agent-inbox
description: File what needs the user next into their agent inbox (the Inbox screen in Paseo's sidebar). For every agent, top-level or child - a decision only the user can make, a result the user should look at, or dispatched work that came back; one card per thing, filed before the turn ends, and resolved by you as soon as it is handled. Tools queue_add, queue_track, queue_resolve; the agent-queue CLI where the tools are missing.
---

# Agent inbox

The user runs many sessions at once and dispatches more agents from them; when something comes back, it is easy to miss. The inbox is the one place where the user goes through what needs them, card by card, and jumps back into the session a card came from. In Paseo it is the **Inbox** row in the sidebar.

## When to file

**One test: is the next step the user's?** It does not matter how deep you are or whether you are a child agent.

File:
- A decision only the user can make: a permission, a trade-off, a judgement call, whether to do something at all.
- A result the user should look at: a finished document, a comparison page, a pull request, a report.
- Dispatched work that came back, once you have checked it (see "Dispatched work").
- Anything the user tells you to put in the inbox.

Do not file:
- What you can decide yourself: decide and carry on.
- Questions inside a discussion the user is having with you right now: they are here, ask them directly.
- Physical tasks for the user (go somewhere, change a password): those belong in their to-do list.
- Decisions not tied to a session that waits on them. The inbox holds what **a session needs from the user before it can go on**.
- Progress reports, or "done" when nothing needs the user.

When unsure, ask: if the user did not open this session for a week, would they miss something that was theirs to do? If yes, file it.

## What the user sees

The inbox groups cards by session. Each group starts with a header: the session's name (your `topic`), which agent it is (plan, model, effort, workspace), and how long its oldest card has waited. Sessions started from it sit one level in, under it.

Each card is one thing:
- Its title is that thing in one line: the ask's `short`, the result's `label`, or the receipt's `title`.
- Below it, three steps recall where it came from: **You asked** (the user's request that led here), **It did** (how far you got on it), **Blocked** (what this card waits on from the user).
- At the bottom, what the user can do:
  - an ask: option buttons and **Send**, your recommended option already picked;
  - a result: what to look at (a link that opens, or a path that copies) and **Seen**;
  - returned work: its conclusion in one line and **Seen**;
  - on each of these, **Discuss**, when the user wants to talk the card over with you first (see "Messages from the inbox").

Tapping the title opens the card: the full question, why it needs deciding now, what each option does, and a reply box. Permission requests and failed turns are filed by the host as their own cards; they are not yours to file.

## One card per thing

- **A card holds exactly one thing for the user**: one question, one result, or one piece of returned work. Several things, several `queue_add` calls.
- **Each card's `timeline` is about that one thing.** Two questions in the same session get two timelines.
- **`topic` is the session's name**, the same on every card of the session. The user recognises the session by it, and the inbox groups by it.
- **Filing the same thing again updates its card.** When an open card of yours has the same `short` (the same result `label`, the same receipt `title`), `queue_add` updates that card in place instead of opening another.
- **To swap an open card for a new one** (the question changed, or a new question supersedes it), file the new card with `replaces: "<old card id>"`. The old card closes; the new one takes its place in line and keeps its waiting time.
- **Send closes only that card**; the session's other cards stay open.
- **When the session needs the user again later, file a new card.** If it follows from an earlier answer, say in `timeline.asked`, in plain words and with the date, what the user decided, e.g. `{date: "11/12", text: "You chose: ship behind a flag"}`.
- Many open questions at once are hard to order: decide what you can yourself and file only what truly needs the user.

## Writing a card

Every `queue_add` call has `topic`, `timeline`, and exactly one of `ask`, `result` or `receipt`.

Short fields are limited by **display width**: CJK and full-width characters count 1; ASCII letters, digits, punctuation and spaces count 0.5; a few symbols such as `…`, `→` and `−` count 1. The tool rejects an overlong field and reports its width.

| Field | What to write | Limit | Example |
|---|---|---|---|
| `topic` | The session's name, the same on all its cards | 15 characters | `Docs redesign` |
| `timeline.asked` | You asked: the user's request that led to this, with its date (M/D) | 18 wide | `{date: "11/10", text: "Redesign the docs nav"}` |
| `timeline.did` | It did: how far you got on it; the date is optional | 18 wide | `{date: "11/12", text: "Built and tested 3 branches"}` |
| `timeline.stuck` | Blocked: what this card waits on from the user | 20 wide | `{text: "Your call on shipping"}` |
| `ask` | One question for the user (fields below) | | |
| `result` | One result to look at, with a link or an absolute path | | `{label: "Before/after comparison", href: "https://example.com/compare", look: "Biggest change: API reference"}` |
| `receipt` | One piece of dispatched work that came back (see "Dispatched work") | | `{title: "Link check on the preview site", status: "failed", conclusion: "…", line: "Timed out; needs a longer limit"}` |
| `replaces` | The id of the open card this one replaces; optional | | `"c-1a2b3c4d5e"` |

An ask:

| Field | What to write | Limit | Example |
|---|---|---|---|
| `short` | The question in one line, naming the project and the thing, no pronouns. It is the card's title. Required | 30 wide | `Docs site: ship the new navigation?` |
| `question` | The full question, shown when the card is opened. Required | 400 characters | `The new navigation is ready on three branches. Ship it to everyone today, or behind a feature flag for a week first?` |
| `options` | The answers the user can tap, one button each: `label` is the button text, `effect` what picking it does | label 12 wide, effect 40 wide | `[{label: "Ship to all", effect: "Everyone sees the new nav today"}, {label: "Behind a flag", effect: "Staff first; public in a week"}]` |
| `recommended` | Index (from 0) of the option you recommend; it starts picked, so the user only has to nod | | `1` |
| `whyNow` | Why this needs deciding now | 60 wide | `The release branch is cut tomorrow morning` |
| `why` | Why you recommend that option, in one sentence | 300 characters | `A flag lets support check the layout before everyone sees it.` |

A result's `label` is the card title; `look` says what to check there (22 wide), e.g. `Biggest change: API reference`; `note` can add what the page holds. A receipt's `title` is the card title and `line` is its conclusion in one line (26 wide); `conclusion` stays complete (at most 3 sentences).

**Write for someone who has forgotten this work.** The user may open the card days later without remembering the conversation.
- **Say in the plainest words which thing this is**, so the user recognises it at a glance. The visible text (`topic`, `timeline`, `short`, option labels, `look`, `line`) avoids jargon.
  - No names coined in the conversation: experiment or run names, branch names, internal code names, group names, numbers, PR numbers without a word on what they are. The user forgets them within minutes.
  - Exact names belong only in the text shown when the card is opened (`question`, `effect`), each followed by a plain explanation, e.g. "nav-v3 (the third navigation prototype)".
  - Before → after: `short`: `nav-v3 flag rollout?` → `Docs site: ship the new navigation behind a flag?`; `line`: `bisect ok, 4f2a1c` → `Starts with the temp-dir commit`.
- No pronouns or references without an antecedent ("it", "those sessions", "the one above"): name the thing. Above all in `short`: on its own line it must still say which project and which thing.
- Every question says three things: what in which project needs deciding (`short` and `question`), why now (`whyNow`), and what each option does (`options[].effect`).
- `timeline.asked` starts from the user's request that led here, with its date.
- Write card text in the user's language, in plain words; explain an abbreviation or term the first time. Facts and numbers, not conclusions the user did not ask for.
- Every ask must be answerable on its own. List options when you can, with labels that are actions ("Rebuild, then switch"), not one-word fragments. Recommend when you can; leave it out when the user really has to weigh it themselves.
- An open question with nothing to list is answered in the card's reply box or in the session; use it only when you truly cannot list options.
- A card does not replace your reply in the session. Report there as usual; the card is the entry point and the summary.
- After filing, say so in your reply in one line, e.g. "Filed to the inbox: Docs site: ship the new navigation?". After updating a card, say "Updated the card in the inbox". The user then knows it is recorded.

## Messages from the inbox

When the user acts on a card in the inbox, your session receives a user message. The examples are the default English set; with `AGENT_INBOX_LANG=zh` on the daemon (or `"lang": "zh"` in its settings file) the same messages come in Chinese.

**Send on an ask:**

```
(Answer from the inbox to a question in "Docs redesign"; this card is closed)
Docs site: ship the new navigation? → Behind a flag (recommended)
Ping me when it is live
```

The second line is the question and the picked answer (only the question when the user just wrote a reply); the last line is the user's reply, if any.

**Send on a result** (a reply written in the opened card):

```
(Reply from the inbox to the result "Before/after comparison" in "Docs redesign"; this card is closed)
The second chart is unclear
```

Act on the answer and the reply. That card is closed already; no `queue_resolve` needed. The session's other cards stay open; handle them as usual.

**Dismiss on an ask:**

```
(Skipped in the inbox, a question in "Docs redesign": Docs site: ship the new navigation? Don't wait for me; if you really need my decision, ask again separately.)
```

The user closed the card without answering. Do not stop and wait: go on with your own best judgement, and file a new card only for what truly cannot go on without the user.

**Seen** on a result or returned work, and **Dismiss** on any card that is not an ask, close the card without sending anything.

**Discuss** on an ask:

```
(From the inbox: I'd like to talk about "Docs site: ship the new navigation?" before deciding. In a few plain sentences, explain where it came from and the trade-offs of each option, then wait for me.)
```

On a result or returned work the message names it and asks only where it came from. The user wants to talk the card over before acting on it, and has just opened your session to do so. Explain in a few plain sentences, as to someone who has forgotten this work: what the card is about and how it came up, and for a question what each option means and costs. Then stop and wait for the user; do not decide or act yet. The card stays open, tagged Discussing in the inbox. Once the user decides in the conversation, act on it and close the card with `queue_resolve`.

Cards from before one card held one thing may hold several items; messages from those list one line per question (with ids such as `q1`) and a line for the questions left unanswered.

## Dispatched work

When you dispatch work, call `queue_track` with a title, and with the child's agent id when you started it with `paseo run`. It shows under **Running**.

When it comes back:
- A `paseo run` child registered with its id: the plugin files its result as a card under your session automatically.
- Anything else (in-process subagents, workflows, agents on other hosts): once you have checked the result, file a receipt with `queue_add`: `receipt` with the `trackId`, a `conclusion` and its one-line `line`. File failures too (`status: "failed"`) so they do not stay under Running forever.

## Resolving

**Close a card yourself as soon as it is handled, in the same turn; do not wait for the user to clear it in the inbox.** A handled card left open makes the user look at it twice.

- **By card**: `queue_resolve` with `cards: [card ids]`. `queue_add` returns the new card's id and lists the session's open cards; `all: true` closes every open card of the session.
- **Handled means**: the user answered in the session; the user pressed Send or Seen in the inbox (the card is closed already); the user said they saw it; you finished what the user decided; or things changed and it no longer needs the user (you can now decide it yourself, or a later decision covers it). When a new question supersedes it, file the new card with `replaces`.
- **Dispatched work that came back**: after checking, file the receipt with its `trackId`; that closes its Running entry.
- **Do not refile what you resolved.**
- **Before ending a turn**, look at your open cards (the list `queue_add` and `queue_resolve` return, or `agent-queue list --json`) and resolve what is handled.

## Without the tools

When the session has no `queue_*` tools (an agent host other than Paseo), use the command line from the repository: `bin/agent-queue add --host dsh --session <id>` with one card's JSON on stdin (`topic`, `timeline`, and one of `ask`, `result`, `receipt`), adding `--replaces <card id>` to swap a card. Resolve with `bin/agent-queue resolve --host dsh --session <id> --card <card id>` (repeat `--card`) or `--all`. `AGENT_QUEUE_SESSION=<host>:<id>` can stand in for `--host` and `--session`. The command line does not require `timeline` and `short`, but write them anyway. `--help` lists every command (`track`, `return`, `list`, `show`, and more).
