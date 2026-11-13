Agent inbox adds an **Inbox** screen to Paseo for what your agent sessions need from you next. Each card holds one thing: a decision only you can make, a result to look at, a permission request, a failed turn, or dispatched work that came back. Cards are grouped under the session that filed them and sessions under their workspace, with sessions started from another session nested under it. Workspaces and sessions fold; a folded row still shows its counts and any pending permission. The sidebar row shows how many cards are open.

## How cards are filed

The plugin gives every interactive session three tools, served by a small MCP server inside the plugin:

- `queue_add` files one card, or updates a card the agent filed before.
- `queue_track` registers dispatched work, which then shows under Running.
- `queue_resolve` closes the agent's own cards once they are handled.

The plugin, not the agent, decides which session a card belongs to. Sessions that were already open get the tools when Paseo next reopens them. The tool descriptions carry the basic rules. The repository also has optional agent instructions in `skill/SKILL.md` (when to file, one thing per card, plain wording, when to resolve) that you can install as a Claude Code skill or point other agents to.

Some cards are filed without the agent: permission requests, turns that end with an error, and tracked `paseo run` children when they finish.

## On a card

- **Send** sends the option you picked, plus any reply you type, into the session as your message. The agent's recommended option starts selected.
- **Discuss** asks the session to explain the card in a few plain sentences and wait, then opens the session. The card stays open until the agent closes it.
- **Seen** closes a result or returned work.
- **Dismiss** closes the card and tells the session not to wait for an answer.
- **Later** moves the card to the end of the list.
- Permission requests get the buttons Paseo itself shows, usually **Accept** and **Deny**. A tap answers the request in the session.

## Data and settings

Cards and dispatch records are kept in a local SQLite file, `~/.local/share/agent-queue/queue.db`. Setting `AGENT_QUEUE_DB` in the daemon's environment moves it. To fill in cards, the plugin reads session details from your daemon (title, folder, workspace, provider, model and parent session), the error message of a failed turn, and the last paragraph of a tracked session's reply when it finishes.

The plugin sends a message into a session or answers a permission request only when you tap a button. Those messages, and the agents' calls to the inbox tools and their results, go to each session's agent provider like the rest of the conversation. The MCP server listens only on 127.0.0.1, with a separate token for each session.

Settings come from the daemon's environment or from `~/.config/agent-inbox/config.json`. A variable that is set wins over the file, and edits to the file apply without a reload.

- `AGENT_INBOX_LANG` (`lang` in the file): `zh` sends the messages into sessions in Chinese. The default is English.
- `AGENT_INBOX_EXTERNAL_URL` (`externalUrl`): a web page for cards filed from outside Paseo through the repository's command line tool, with `{session}` standing for the session id. **Open session** and **Discuss** open that page for those cards. Without it, they have neither button.

## Requirements

- Paseo 0.15.3 or later.
- Node.js 22.13 or later on the daemon host (23.4 or later on Node 23), for the built-in `node:sqlite` module.
- npm on the daemon's command path. The install step links the card store from the same repository and adds no packages from the npm registry.
- Tested on macOS.

## Limits

- Fold state lasts while the app is open but is not saved. Workspaces with more than 10 open cards start folded.
- There are no notifications beyond the sidebar count. The screen refreshes every 5 seconds.
- Permission requests that ask several questions are answered in the session.
- Cards filed from outside Paseo cannot be answered from the inbox.
- Work Paseo cannot see, such as an agent's in-process subagents, shows up only if the agent files it.
- Card fields have length limits sized for a phone screen.
- Each daemon host has its own database; nothing syncs between machines.
