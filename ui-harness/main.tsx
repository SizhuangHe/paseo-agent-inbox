// Renders QueueView (the real component) with react-native-web, for headless screenshots.
import { createRoot } from "react-dom/client";
import { QueueView, type QueueData } from "../paseo-plugin/client/queue-view";
import { discussMode } from "../paseo-plugin/shared/cards";

declare const QUEUE_DATA: QueueData;
declare const document: { getElementById(id: string): unknown; body: { style: Record<string, string> } };
declare const location: { search: string };

// Every callback records its call here, so interaction checks can see what a tap would do.
const calls: unknown[][] = [];
(globalThis as { __calls?: unknown[][] }).__calls = calls;
const record =
  (name: string) =>
  (...args: unknown[]) =>
    calls.push([name, ...args.map((arg) => (arg && typeof arg === "object" && "id" in arg ? (arg as { id: unknown }).id : arg))]);

// Paseo's built-in dark and light themes, mapped to the plugin theme tokens.
const THEMES = {
  dark: {
    colors: {
      surface0: "#181B1A", surface1: "#1E2120", surface2: "#272A29", border: "#252B2A",
      foreground: "#fafafa", foregroundMuted: "#A1A5A4", accent: "#20744A", accentForeground: "#fafafa",
      statusSuccess: "#6cb17b", statusWarning: "#c09664", statusDanger: "#d8847b",
    },
  },
  light: {
    colors: {
      surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7",
      foreground: "#1a1a1e", foregroundMuted: "#71717a", accent: "#20744A", accentForeground: "#ffffff",
      statusSuccess: "#3e704a", statusWarning: "#7b5d39", statusDanger: "#9d433b",
    },
  },
};

// ?card=<id> opens a card in detail; &expand=<askId> expands one of its asks; &perm=[<cardId>/]<askId>:<state>
// shows a permission ask (of the open card unless named) as answered (allowed, denied, sent, stale) or busy;
// &copy=fail makes copying a path fail, as over plain http without the textarea fallback;
// &revealed=<cardId> starts that card with its path shown, as after a failed copy;
// &external=1 shows Open session and Discuss on cards from an external host, as when AGENT_INBOX_EXTERNAL_URL is set.
// &fold=<key> starts a workspace row (workspace:<name>) or session header (session:<host>:<id>) folded, &unfold=<key> open.
const params = new URLSearchParams(location.search);
const card = params.get("card");
const expand = params.get("expand");
const perm = params.get("perm") ?? "";
const permAsk = perm.slice(0, perm.lastIndexOf(":"));
const permState = perm.slice(perm.lastIndexOf(":") + 1);
const permKey = permAsk.includes("/") ? permAsk : card ? `${card}/${permAsk}` : null;
const copyFails = params.get("copy") === "fail";
const revealed = params.getAll("revealed");
const folds = new Map<string, boolean>([
  ...params.getAll("fold").map((key) => [key, true] as const),
  ...params.getAll("unfold").map((key) => [key, false] as const),
]);
const theme = THEMES[params.get("theme") === "light" ? "light" : "dark"];
document.body.style.backgroundColor = theme.colors.surface0;

createRoot(document.getElementById("root") as never).render(
  <QueueView
    theme={theme}
    compact={params.get("compact") === "1"}
    data={QUEUE_DATA}
    selectedId={card}
    defaultRunningOpen={params.get("running") === "1"}
    defaultExpanded={card && expand ? [`${card}/${expand}`] : []}
    onSelect={() => {}}
    onOpenSession={() => {}}
    canOpenSession={(item) => item.host === "paseo" || params.get("external") === "1"}
    onDiscuss={record("discuss")}
    canDiscuss={(item) => discussMode(item, params.get("external") === "1" ? "https://agents.example.com/s/{session}" : null) !== null}
    onSnooze={record("snooze")}
    onDone={record("done")}
    onAnswer={record("answer")}
    onPermission={record("permission")}
    permissionStates={permKey && permState ? { [permKey]: permState as never } : {}}
    onOpenUrl={() => {}}
    onCopyPath={(path) => {
      record("copy")(path);
      return Promise.resolve(!copyFails);
    }}
    defaultRevealed={revealed}
    folds={folds}
  />,
);
