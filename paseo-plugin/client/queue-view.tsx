// Presentational inbox screen. One card is one thing for the user (an ask, a result, a receipt, or a
// host request), with its own You asked → It did → Blocked recall. The overview groups cards under
// the session that filed them (topic, agent line, oldest wait), a child session nested under the one
// that started it, and the sessions under their workspace; workspace rows and session headers fold.
// The user answers, looks and closes right there; tapping a card's title opens it in detail. Older
// cards that hold several items keep their earlier layout. UI labels are English; card content is the
// agents' own words. All colors come from the Paseo theme; color only carries status.
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/ui";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type PressableStateCallbackType, type TextStyle, type ViewStyle } from "react-native";
import { agentLine } from "../shared/agent-line";
import { askChoices, askKind, discussLine, questionLine, recommendedChoice, singleItem, type Picks } from "../shared/cards";
import {
  groupSessions,
  groupWorkspaces,
  isFolded,
  latestCard,
  sessionFoldKey,
  summarize,
  workspaceFoldedByDefault,
  workspaceFoldKey,
  type FoldStatus,
  type FoldSummary,
  type SessionGroup,
  type WorkspaceGroup,
} from "../shared/groups";
import type { PermissionAnswer, PermissionOutcome, QueueAsk, QueueCard, QueueTrack } from "../shared/rpc";
import {
  cardCounts,
  cardKind,
  cardStatus,
  cardTitle,
  displayPath,
  elapsed,
  hostAskLine,
  hostOnly,
  hrefKind,
  isHostAsk,
  isPermissionAsk,
  mix,
  onlyPermissionsOpen,
  type CardStatus,
} from "./format";
import { PROVIDER_ICONS } from "./provider-icons";

export interface QueueData {
  now: string;
  cards: QueueCard[];
  tracks: QueueTrack[];
  /** Names for sessions that tracks or cards point to: the topic their agent wrote last, else the host's title. */
  sessionTitles: Record<string, string>;
  /** Card sessions a registered dispatch started → the dispatching session (null when unknown). */
  childOf: Record<string, string | null>;
  home: string | null;
}

export interface QueueViewProps {
  theme: PluginTheme;
  compact: boolean;
  data: QueueData;
  /** Milliseconds since `data` was fetched, so wait times keep moving between polls. */
  clockSkewMs?: number;
  /** The card shown in detail; null (or a card that is gone) shows the overview. */
  selectedId: string | null;
  onSelect(cardId: string | null): void;
  onOpenSession: ((card: QueueCard) => void) | null;
  /** Whether a card's session can be opened (e.g. an external host with no URL set); all can when left out. */
  canOpenSession?: (card: QueueCard) => boolean;
  /** Discuss: asks the session to talk the card over, then opens it. Null hides it. */
  onDiscuss?: ((card: QueueCard) => void) | null;
  /** Whether an agent card has Discuss (e.g. not on an external host with no URL set); all can when left out. */
  canDiscuss?: (card: QueueCard) => boolean;
  onSnooze(card: QueueCard): void;
  /** Seen and Dismiss: closes the card (Dismiss on an open ask first tells the session it was skipped). */
  onDone(card: QueueCard): void;
  /** Send: ask id → choice index, plus the user's reply. Sending closes the card. Null hides it. */
  onAnswer: ((card: QueueCard, picks: Picks, reply: string) => void) | null;
  /** Answers a permission request right away (not part of Send). Null: answer in the session. */
  onPermission?: ((card: QueueCard, ask: QueueAsk, answer: PermissionAnswer) => void) | null;
  /** Where each answered permission ask stands, as `<cardId>/<askId>` → state. */
  permissionStates?: Record<string, PermissionState>;
  /** Opens an http(s) URL. */
  onOpenUrl(url: string): void;
  /** Copies an absolute path; resolves false when it could not, and the card then shows the path to select. */
  onCopyPath(path: string): Promise<boolean> | void;
  busyCardId?: string | null;
  /** Start with the `Running` list expanded. */
  defaultRunningOpen?: boolean;
  /** Asks shown expanded at first, as `<cardId>/<askId>`. */
  defaultExpanded?: string[];
  /** Cards that start with their full path shown, as after a failed copy. */
  defaultRevealed?: string[];
  /**
   * Fold state by workspace and session key (see shared/groups), read and written here. The screen
   * passes one that outlives the view; left out, the view keeps its own.
   */
  folds?: Map<string, boolean>;
}

/** A permission answer on its way (busy), or how it went. */
export type PermissionState = "busy" | PermissionOutcome;

/** Opens the card's session, or null when it has none to open (the button is then hidden). */
function sessionOpener(props: Pick<QueueViewProps, "onOpenSession" | "canOpenSession">, card: QueueCard): (() => void) | null {
  const open = props.onOpenSession;
  if (!open || props.canOpenSession?.(card) === false) return null;
  return () => open(card);
}

/** Discuss on the card, or null when it has none: permission requests, failed turns, older cards, hosts it cannot reach. */
function discusser(props: Pick<QueueViewProps, "onDiscuss" | "canDiscuss">, card: QueueCard): (() => void) | null {
  const discuss = props.onDiscuss;
  if (!discuss || discussLine(card) === null || props.canDiscuss?.(card) === false) return null;
  return () => discuss(card);
}

const STEPS = ["You asked", "It did", "Blocked"] as const;
const OLD_STEPS = ["Context", "Summary"] as const;

function useStyles(theme: PluginTheme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    const hairline = StyleSheet.hairlineWidth;
    const dim = mix(c.foregroundMuted, c.surface0, 0.35);
    const soft = mix(c.foreground, c.surface0, 0.13);
    return {
      dim,
      ...StyleSheet.create({
        content: {
          width: "100%",
          maxWidth: 720,
          alignSelf: "center",
          paddingHorizontal: compact ? 12 : 32,
          paddingTop: compact ? 16 : 28,
          paddingBottom: 48,
        },
        header: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 14, paddingHorizontal: 2 },
        headerTitle: { flexDirection: "row", alignItems: "baseline", gap: 8 },
        headerText: { color: c.foreground, fontSize: 20, lineHeight: 26, fontWeight: "600" },
        headerCount: { color: c.foregroundMuted, fontSize: 20, lineHeight: 26, fontVariant: ["tabular-nums"] },
        runningToggle: { flexDirection: "row", alignItems: "center", gap: 6, paddingVertical: 4, paddingHorizontal: 8, borderRadius: 6 },
        runningText: { color: c.foregroundMuted, fontSize: 13 },
        chevron: { color: c.foregroundMuted, fontSize: 16, lineHeight: 18, width: 10, textAlign: "center" },
        chevronOpen: { transform: [{ rotate: "90deg" }] },
        runningCount: { color: c.foreground, fontSize: 13, fontVariant: ["tabular-nums"] },
        trackList: { borderWidth: hairline, borderColor: c.border, borderRadius: 10, overflow: "hidden", marginBottom: 14 },
        trackRow: { paddingVertical: 10, paddingHorizontal: 14 },
        trackDivider: { borderTopWidth: hairline, borderTopColor: c.border },
        trackTitle: { color: c.foreground, fontSize: 14, lineHeight: 20 },
        trackMeta: { color: c.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] },
        empty: { color: c.foregroundMuted, fontSize: 15, paddingVertical: 24, paddingHorizontal: 2 },

        // overview: workspace rows, each over its session groups (indented); a session group is a header
        // row over its cards, and a child session nests one level in. Rows fold behind a chevron.
        workspaces: { gap: compact ? 20 : 24 },
        workspaceRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 30, paddingHorizontal: 2, borderRadius: 6 },
        workspaceName: { flexShrink: 1, minWidth: 0, color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" },
        workspaceFill: { flex: 1, minWidth: 8 },
        // the summary under the name on a phone: past the chevron and the dot
        workspaceSummaryLine: { marginLeft: 35, marginTop: -2 },
        workspaceBody: { gap: 22, marginTop: 10, marginLeft: compact ? 8 : 18 },
        statusDot: { width: 7, height: 7, borderRadius: 3.5 },
        summary: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
        // the oldest wait after the counts, set apart from them
        foldWaited: { marginLeft: 6 },
        group: { gap: 8 },
        children: { gap: 14, marginTop: 6, marginLeft: compact ? 4 : 6, paddingLeft: compact ? 10 : 14, borderLeftWidth: 1.5, borderLeftColor: c.border },
        groupHead: { paddingHorizontal: 2 },
        groupTitleRow: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24, marginHorizontal: -2, paddingHorizontal: 2, borderRadius: 6 },
        groupTitle: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: "600" },
        groupTitleMuted: { color: c.foregroundMuted, fontWeight: "500" },
        // the agent line under a session's title, past the chevron
        groupMeta: { marginLeft: 18 },
        groupCards: { gap: 8 },

        // one card: its line, the recall, then what it asks of the user
        item: {
          backgroundColor: c.surface1,
          borderWidth: hairline,
          borderColor: c.border,
          borderRadius: 12,
          paddingHorizontal: compact ? 12 : 16,
          paddingTop: 11,
          paddingBottom: 12,
        },
        itemHead: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
        itemTitle: { color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" },
        itemActions: { flexDirection: "row", alignItems: "flex-end", gap: 10, marginTop: 10 },
        itemButtons: { flexDirection: "row", gap: 6 },
        // Discussing: a small muted tag
        tag: { paddingHorizontal: 6, borderRadius: 5, borderWidth: hairline, borderColor: c.border, backgroundColor: c.surface2 },
        tagText: { color: c.foregroundMuted, fontSize: 11, lineHeight: 17 },
        itemActionsMain: { flex: 1, minWidth: 0 },
        itemChips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
        itemEffect: { color: c.foregroundMuted, fontSize: 12, lineHeight: 17, marginTop: 6 },
        itemLink: { flexDirection: "row", alignItems: "baseline", gap: 6, alignSelf: "flex-start", paddingVertical: 4, borderRadius: 6 },
        itemLinkText: { flexShrink: 1, color: soft, fontSize: 13, lineHeight: 19 },
        itemLinkGlyph: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 },
        itemNote: { flexShrink: 1, color: soft, fontSize: 13, lineHeight: 19 },
        itemPath: {
          marginTop: 8,
          paddingVertical: 6,
          paddingHorizontal: 8,
          borderRadius: 6,
          backgroundColor: c.surface2,
          color: c.foreground,
          fontSize: 12,
          lineHeight: 17,
          fontFamily: "Menlo, ui-monospace, monospace",
        },
        smallChip: {
          height: 30,
          paddingHorizontal: 10,
          borderRadius: 8,
          justifyContent: "center",
          backgroundColor: c.surface2,
          borderWidth: 1,
          borderColor: c.border,
        },
        small: { height: 30, paddingHorizontal: 12, borderRadius: 8, alignItems: "center", justifyContent: "center" },
        smallText: { fontSize: 13, fontWeight: "600" },

        // agent line: [logo] plan · model · effort · role, then [folder] workspace
        meta: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", columnGap: 10, rowGap: 1, marginTop: 2 },
        metaItem: { flexDirection: "row", alignItems: "center", gap: 5, flexShrink: 1, minWidth: 0, maxWidth: "100%" },
        metaText: { flexShrink: 1, minWidth: 0, color: c.foregroundMuted, fontSize: 12, lineHeight: 18 },
        metaDot: { width: 6, height: 6, marginHorizontal: 2, borderRadius: 3, backgroundColor: dim },

        // older multi-item cards in the overview
        card: {
          backgroundColor: c.surface1,
          borderWidth: hairline,
          borderColor: c.border,
          borderRadius: 12,
          paddingHorizontal: compact ? 12 : 16,
          paddingTop: 12,
        },
        cardHead: { flexDirection: "row", alignItems: "baseline", gap: 10 },
        cardTitle: { flex: 1, minWidth: 0, color: c.foreground, fontSize: 15, lineHeight: 21, fontWeight: "600" },
        waited: { color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] },
        needs: {
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          marginTop: 10,
          paddingTop: 10,
          paddingBottom: 11,
          borderTopWidth: hairline,
          borderTopColor: c.border,
        },
        counts: { flex: 1, color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontVariant: ["tabular-nums"] },
        countsStrong: { color: c.foreground },
        countsNumber: { fontWeight: "600" },
        countsSep: { color: dim },
        go: { color: c.foregroundMuted, fontSize: 16, lineHeight: 18 },

        // steps: You asked → It did → Blocked, or an old card's Context → Summary
        steps: { marginTop: 8 },
        stepsBox: {
          marginTop: 12,
          padding: 12,
          borderRadius: 12,
          backgroundColor: c.surface1,
          borderWidth: hairline,
          borderColor: c.border,
        },
        step: { flexDirection: "row", gap: 8 },
        stepGap: { paddingBottom: 5 },
        stepLabel: { width: 58, color: c.foregroundMuted, fontSize: 12, lineHeight: 19 },
        rail: { width: 10 },
        railDot: { position: "absolute", left: 1.5, top: 6, width: 7, height: 7, borderRadius: 3.5 },
        railLine: { position: "absolute", left: 4.5, top: 15.5, bottom: -9, width: 1, backgroundColor: mix(c.foregroundMuted, c.surface0, 0.55) },
        stepText: { flex: 1, minWidth: 0, color: soft, fontSize: 13, lineHeight: 19 },
        stepStuck: { color: c.foreground, fontWeight: "500" },
        stepDate: { color: c.foregroundMuted },

        // detail
        top: { flexDirection: "row", alignItems: "center", height: 44, marginTop: -8, marginBottom: 4 },
        back: { flexDirection: "row", alignItems: "center", gap: 4, paddingVertical: 6, paddingRight: 8, borderRadius: 6 },
        backChevron: { color: c.foregroundMuted, fontSize: 22, lineHeight: 22, marginTop: -2 },
        backText: { color: c.foregroundMuted, fontSize: 15 },
        topWaited: { marginLeft: "auto", color: c.foregroundMuted, fontSize: 13, fontVariant: ["tabular-nums"] },
        detail: { paddingHorizontal: compact ? 4 : 0 },
        topic: { color: c.foregroundMuted, fontSize: 13, lineHeight: 18, fontWeight: "600" },
        title: { color: c.foreground, fontSize: 22, lineHeight: 30, fontWeight: "600" },
        itemDetailTitle: { color: c.foreground, fontSize: 20, lineHeight: 28, fontWeight: "600", marginTop: 10 },
        body: { marginTop: 18, gap: 8 },
        bodyText: { color: soft, fontSize: 15, lineHeight: 23 },
        bodyMuted: { color: c.foregroundMuted, fontSize: 14, lineHeight: 21 },
        sectionHead: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 22, marginBottom: 4, minHeight: 22 },
        sectionLabel: { color: c.foregroundMuted, fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0.7 },
        sectionCount: { color: dim, fontSize: 12, fontVariant: ["tabular-nums"] },
        listItem: { paddingTop: 12, paddingBottom: 14, borderTopWidth: hairline, borderTopColor: c.border },
        itemFirst: { borderTopWidth: 0 },
        question: { color: c.foreground, fontSize: 15, lineHeight: 22, fontWeight: "500" },
        more: { color: dim, fontSize: 13, fontWeight: "400" },
        muted: { color: c.foregroundMuted, fontWeight: "400" },
        resolvedRow: { flexDirection: "row", gap: 8, alignItems: "flex-start" },
        check: { width: 14, color: c.statusSuccess, fontSize: 13, lineHeight: 22 },
        chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
        chip: {
          height: 32,
          paddingHorizontal: 11,
          borderRadius: 8,
          justifyContent: "center",
          backgroundColor: c.surface2,
          borderWidth: 1,
          borderColor: c.border,
        },
        chipPicked: { backgroundColor: "transparent", borderColor: c.foreground },
        chipText: { color: c.foreground, fontSize: 14 },
        chipTextPicked: { fontWeight: "600" },
        effect: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19, marginTop: 8 },
        answer: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
        tick: {
          width: 16,
          height: 16,
          borderRadius: 8,
          borderWidth: 1.5,
          borderColor: c.foreground,
          alignItems: "center",
          justifyContent: "center",
        },
        tickEmpty: { borderColor: dim },
        tickMark: { color: c.foreground, fontSize: 10, lineHeight: 12, fontWeight: "800" },
        answerText: { flexShrink: 1, color: c.foreground, fontSize: 14, lineHeight: 20 },
        answerNone: { color: dim },
        full: { marginTop: 8, gap: 6 },
        fullQuestion: { color: soft, fontSize: 13, lineHeight: 20 },
        fullWhy: { color: c.foregroundMuted, fontSize: 13, lineHeight: 20 },
        options: { marginTop: 10, borderWidth: hairline, borderColor: c.border, borderRadius: 10, overflow: "hidden" },
        option: { flexDirection: "row", gap: 10, paddingVertical: 10, paddingHorizontal: 12 },
        optionDivider: { borderTopWidth: hairline, borderTopColor: c.border },
        radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 1.5, borderColor: dim, marginTop: 2 },
        radioPicked: { borderWidth: 5, borderColor: c.foreground },
        optionBody: { flex: 1, minWidth: 0 },
        optionLabel: { color: c.foreground, fontSize: 14, lineHeight: 20 },
        optionTag: { color: c.foregroundMuted, fontSize: 11 },
        optionNote: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 },
        reply: { alignSelf: "flex-start", marginTop: 6, paddingVertical: 2, borderRadius: 4 },
        // permission requests: one line (› for the full request), then the choices or how it went
        permLine: { flexDirection: "row", alignItems: "baseline", gap: 8 },
        permText: { flex: 1, minWidth: 0 },
        permDetail: { color: soft, fontSize: 13, lineHeight: 20, marginTop: 8, fontFamily: "Menlo, ui-monospace, monospace" },
        permQuestion: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19, marginTop: 10 },
        permState: { fontSize: 14, lineHeight: 20, marginTop: 10, fontWeight: "500" },
        replyText: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 },
        row: {
          flexDirection: "row",
          alignItems: "flex-start",
          gap: 12,
          paddingVertical: 10,
          borderTopWidth: hairline,
          borderTopColor: c.border,
        },
        rowBody: { flex: 1, minWidth: 0 },
        rowTitle: { color: c.foreground, fontSize: 15, lineHeight: 22 },
        rowSub: { color: c.foregroundMuted, fontSize: 13, lineHeight: 19 },
        rowSide: { color: c.foregroundMuted, fontSize: 14, lineHeight: 22 },
        mark: { width: 14, fontSize: 13, lineHeight: 22 },
        footArea: { gap: 10, marginTop: 18, paddingTop: 14, borderTopWidth: hairline, borderTopColor: c.border },
        foot: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: compact ? 6 : 8 },
        replyInput: {
          minHeight: 40,
          maxHeight: 132,
          paddingHorizontal: 12,
          paddingVertical: 9,
          borderRadius: 10,
          borderWidth: hairline,
          borderColor: c.border,
          backgroundColor: c.surface1,
          color: c.foreground,
          fontSize: 15,
          lineHeight: 21,
        },
        // At 390 px the footer buttons (up to Send, Seen, Discuss, Open session, Later) fit on one row
        // only with the tighter phone spacing.
        footRight: { marginLeft: "auto" },
        button: { height: 36, paddingHorizontal: compact ? 10 : 16, borderRadius: 8, alignItems: "center", justifyContent: "center" },
        primary: { backgroundColor: c.foreground },
        primaryText: { color: c.surface0, fontSize: compact ? 13 : 14, fontWeight: "600" },
        secondary: { backgroundColor: c.surface2, borderWidth: hairline, borderColor: c.border },
        secondaryText: { color: c.foreground, fontSize: compact ? 13 : 14, fontWeight: "600" },
        quiet: { height: 36, paddingHorizontal: compact ? 4 : 8, borderRadius: 8, alignItems: "center", justifyContent: "center" },
        quietText: { color: c.foregroundMuted, fontSize: compact ? 13 : 14 },
        disabled: { opacity: 0.4 },
        hover: { backgroundColor: c.surface2 },
        cardHover: { borderColor: mix(c.border, c.foregroundMuted, 0.3) },
        pressed: { opacity: 0.7 },
      }),
    };
  }, [theme, compact]);
}

type Styles = ReturnType<typeof useStyles>;

function statusColor(theme: PluginTheme, status: CardStatus): string {
  if (status === "danger") return theme.colors.statusDanger;
  if (status === "warning") return theme.colors.statusWarning;
  return theme.colors.accent;
}

function pressStyle(base: ViewStyle | (ViewStyle | false | null | undefined)[], hover: ViewStyle, s: Styles) {
  return (state: PressableStateCallbackType) => {
    const hovered = (state as PressableStateCallbackType & { hovered?: boolean }).hovered;
    return [base, hovered ? hover : null, state.pressed ? s.pressed : null];
  };
}

// ---- steps ----------------------------------------------------------------

interface StepLine {
  label?: string;
  date?: string;
  text: string;
}

/**
 * The recall: three labelled steps from the timeline, or an old card's context then summary. When only
 * host asks are open on an older card (a permission request or a failed turn), one `Blocked` step names it instead.
 */
function Steps({ card, s, theme, boxed, lines }: { card: QueueCard; s: Styles; theme: PluginTheme; boxed: boolean; lines?: number }) {
  const t = card.timeline;
  const host = hostOnly(card) ? card.asks.find((ask) => !ask.resolved && isHostAsk(ask)) : undefined;
  const steps: StepLine[] = host
    ? [{ label: STEPS[2], text: hostAskLine(host) }]
    : t
    ? [
        { label: STEPS[0], date: t.asked.date, text: t.asked.text },
        { label: STEPS[1], date: t.did.date, text: t.did.text },
        { label: STEPS[2], text: t.stuck.text },
      ]
    : [
        { label: OLD_STEPS[0], text: card.context },
        { label: OLD_STEPS[1], text: card.summary },
      ];
  const last = steps.length - 1;
  return (
    <View style={boxed ? s.stepsBox : s.steps}>
      {steps.map((step, index) => (
        <View key={index} style={[s.step, index < last ? s.stepGap : null]}>
          <Text style={s.stepLabel} numberOfLines={1}>
            {step.label}
          </Text>
          <View style={s.rail}>
            <View style={[s.railDot, { backgroundColor: index === last ? statusColor(theme, cardStatus(card)) : s.dim }]} />
            {index < last ? <View style={s.railLine} /> : null}
          </View>
          <Text
            style={[s.stepText, index === last ? s.stepStuck : null, host ? { color: statusColor(theme, cardStatus(card)) } : null]}
            numberOfLines={lines}
          >
            {/* en spaces: plain spaces collapse on the web */}
            {step.date ? <Text style={s.stepDate}>{`${step.date} `}</Text> : null}
            {step.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ---- shared pieces ----------------------------------------------------------

function Counts({ card, s, theme }: { card: QueueCard; s: Styles; theme: PluginTheme }) {
  const n = cardCounts(card);
  const parts: { count: number; label: string; strong: boolean; color?: string }[] = [
    { count: n.permission, label: n.permission === 1 ? "permission" : "permissions", strong: true, color: statusColor(theme, cardStatus(card)) },
    { count: n.think, label: "decide", strong: true },
    { count: n.nod, label: "approve", strong: false },
    { count: n.look, label: "review", strong: false },
    { count: n.receipts, label: "returned", strong: false },
  ].filter((part) => part.count > 0);
  return (
    <Text style={s.counts} numberOfLines={1}>
      {parts.map((part, index) => (
        <Text key={part.label}>
          {index ? <Text style={s.countsSep}>{" · "}</Text> : null}
          <Text style={[part.strong ? s.countsStrong : null, part.color ? { color: part.color } : null]}>
            <Text style={s.countsNumber}>{part.count}</Text> {part.label}
          </Text>
        </Text>
      ))}
    </Text>
  );
}

/**
 * Which agent the card comes from, muted: logo, then plan · model · effort · role as one line that never
 * wraps, then the workspace, which moves to its own line when it does not fit beside them.
 */
function AgentLineView({ card, data, s, theme }: { card: QueueCard; data: QueueData; s: Styles; theme: PluginTheme }) {
  const line = agentLine(card, data);
  if (!line.items.length && !line.workspace) return null;
  const muted = theme.colors.foregroundMuted;
  return (
    <View style={s.meta}>
      {line.items.length ? (
        <View style={s.metaItem}>
          {line.icon ? <Icon icon={{ svg: PROVIDER_ICONS[line.icon] }} size={10} color={muted} /> : <View style={s.metaDot} />}
          {/* en spaces: plain spaces collapse on the web */}
          <Text style={s.metaText} numberOfLines={1}>
            {line.items.join(" · ")}
          </Text>
        </View>
      ) : null}
      {line.workspace ? (
        <View style={s.metaItem}>
          <Icon name="folder" size={10} color={muted} />
          <Text style={s.metaText} numberOfLines={1}>
            {line.workspace}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** A card's one line: the ask's short (or its question cut short), the request or error, the result label, the receipt title. */
function itemLine(card: QueueCard): string {
  const single = singleItem(card);
  if (!single) return cardTitle(card);
  if (single.kind === "ask") return isHostAsk(single.item) ? hostAskLine(single.item) : questionLine(single.item);
  return single.kind === "result" ? single.item.label : single.item.title;
}

/** The single ask of an ask, permission or error card. */
function soleAsk(card: QueueCard): QueueAsk | null {
  const single = singleItem(card);
  return single?.kind === "ask" ? single.item : null;
}

function SmallButton(props: { label: string; kind: "primary" | "secondary"; disabled?: boolean; onPress(): void; s: Styles }) {
  const { label, kind, disabled, onPress, s } = props;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={pressStyle([s.small, kind === "primary" ? s.primary : s.secondary, disabled ? s.disabled : null], kind === "primary" ? {} : s.hover, s)}
    >
      <Text style={[kind === "primary" ? s.primaryText : s.secondaryText, s.smallText]}>{label}</Text>
    </Pressable>
  );
}

/** The muted tag on a card the user asked its session to talk over. */
function DiscussingTag({ card, s, style }: { card: QueueCard; s: Styles; style?: ViewStyle }) {
  if (!card.discussingAt) return null;
  return (
    <View style={[s.tag, style]}>
      <Text style={s.tagText}>Discussing</Text>
    </View>
  );
}

// ---- overview ---------------------------------------------------------------

/** Per-card state the screen keeps (picks, a path shown after a failed copy) and the taps that change it. */
interface CardActions {
  chosen(card: QueueCard, ask: QueueAsk): number | null;
  pick(card: QueueCard, ask: QueueAsk, index: number): void;
  revealed(card: QueueCard): boolean;
  copyPath(card: QueueCard, path: string): void;
}

/** Chips for an ask's choices, the picked one outlined with ✓; a tap picks, a second tap clears. */
function ChoiceChips({ card, ask, actions, enabled, s }: { card: QueueCard; ask: QueueAsk; actions: CardActions; enabled: boolean; s: Styles }) {
  const chosen = actions.chosen(card, ask);
  return (
    <View style={s.itemChips}>
      {askChoices(ask).map((choice, index) => {
        const picked = chosen === index;
        return (
          <Pressable
            key={index}
            accessibilityRole="button"
            accessibilityState={{ selected: picked }}
            disabled={!enabled}
            onPress={() => actions.pick(card, ask, index)}
            style={pressStyle([s.smallChip, picked ? s.chipPicked : null], s.hover, s)}
          >
            <Text style={[s.chipText, picked ? s.chipTextPicked : null]} numberOfLines={1}>
              {picked ? `✓ ${choice.label}` : choice.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A result's link: http(s) opens (↗), an absolute path copies (⧉); the `look` line says what to check. */
function ResultLink({ card, actions, props, s }: { card: QueueCard; actions: CardActions; props: QueueViewProps; s: Styles }) {
  const single = singleItem(card);
  if (single?.kind !== "result") return null;
  const result = single.item;
  const kind = hrefKind(result.href);
  const href = result.href ?? "";
  const label = result.look ?? result.note ?? (kind === "path" ? displayPath(href) : kind === "url" ? href.replace(/^https?:\/\//, "") : null);
  if (kind === "text") return label ? <Text style={s.itemNote}>{label}</Text> : null;
  return (
    <Pressable
      accessibilityRole={kind === "url" ? "link" : "button"}
      accessibilityHint={kind === "path" ? href : undefined}
      onPress={() => (kind === "url" ? props.onOpenUrl(href) : actions.copyPath(card, href))}
      style={pressStyle(s.itemLink, s.hover, s)}
    >
      <Text style={s.itemLinkText} numberOfLines={2}>
        {label}
      </Text>
      <Text style={s.itemLinkGlyph}>{kind === "url" ? "↗" : "⧉"}</Text>
    </Pressable>
  );
}

const PERMISSION_DONE: Record<PermissionOutcome, string> = {
  allowed: "Allowed",
  denied: "Denied",
  sent: "Sent",
  stale: "Already answered",
};

/**
 * A permission request's choices: a tap answers at once (the session is blocked on it); a question
 * request takes one pick per question, the last answering. Then how it went, or `Answer in session`
 * when there is nothing to pick.
 */
function PermissionChoices(props: {
  ask: QueueAsk;
  s: Styles;
  theme: PluginTheme;
  progress: PermissionState | undefined;
  onAnswer: ((answer: PermissionAnswer) => void) | null;
  onReply: (() => void) | null;
}) {
  const { ask, s, theme, progress, onAnswer } = props;
  const [picks, setPicks] = useState<Record<string, string>>({});
  const permission = ask.permission;
  const busy = progress === "busy";
  const done = progress && progress !== "busy" ? progress : null;
  const live = Boolean(onAnswer) && !busy && !ask.resolved;
  const doneColor = done === "allowed" || done === "sent" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;

  const chip = (key: string, label: string, picked: boolean, onPress: () => void) => (
    <Pressable
      key={key}
      accessibilityRole="button"
      accessibilityState={{ selected: picked, disabled: !live }}
      disabled={!live}
      onPress={onPress}
      style={pressStyle([s.chip, picked ? s.chipPicked : null, live ? null : s.disabled], s.hover, s)}
    >
      <Text style={[s.chipText, picked ? s.chipTextPicked : null]} numberOfLines={1}>
        {picked ? `✓ ${label}` : label}
      </Text>
    </Pressable>
  );

  if (done) {
    return <Text style={[s.permState, { color: doneColor }]}>{done === "stale" ? PERMISSION_DONE.stale : `✓ ${PERMISSION_DONE[done]}`}</Text>;
  }
  if (permission?.choices?.length) {
    return <View style={s.chips}>{permission.choices.map((choice) => chip(choice.id, choice.label, false, () => onAnswer?.({ actionId: choice.id })))}</View>;
  }
  if (permission?.questions?.length) {
    const questions = permission.questions;
    return (
      <>
        {questions.map((question) => (
          <View key={question.header}>
            <Text style={s.permQuestion}>{question.question}</Text>
            <View style={s.chips}>
              {question.options.map((option) =>
                chip(`${question.header}/${option}`, option, picks[question.header] === option, () => {
                  const next = { ...picks, [question.header]: option };
                  setPicks(next);
                  if (questions.every((q) => next[q.header] !== undefined)) onAnswer?.({ answers: next });
                }),
              )}
            </View>
          </View>
        ))}
      </>
    );
  }
  return props.onReply ? (
    <Pressable accessibilityRole="button" onPress={props.onReply} style={pressStyle(s.reply, s.hover, s)}>
      <Text style={s.replyText}>Answer in session</Text>
    </Pressable>
  ) : (
    <Text style={[s.replyText, { marginTop: 6 }]}>Answer in session</Text>
  );
}

/** What a card asks of the user, in the overview: chips and Send, a link and Seen, a line and Seen, or a request's choices. */
function ItemActions({ card, props, actions, s }: { card: QueueCard; props: QueueViewProps; actions: CardActions; s: Styles }) {
  const { theme } = props;
  const kind = cardKind(card);
  const busy = props.busyCardId === card.id;
  const seen = <SmallButton label="Seen" kind="secondary" disabled={busy} onPress={() => props.onDone(card)} s={s} />;
  const onDiscuss = discusser(props, card);
  const discuss = onDiscuss ? <SmallButton label="Discuss" kind="secondary" disabled={busy} onPress={onDiscuss} s={s} /> : null;
  const ask = soleAsk(card);

  if (kind === "permission" && ask) {
    const onPermission = card.host === "paseo" ? props.onPermission : null;
    return (
      <PermissionChoices
        ask={ask}
        s={s}
        theme={theme}
        progress={props.permissionStates?.[`${card.id}/${ask.id}`]}
        onAnswer={onPermission ? (answer) => onPermission(card, ask, answer) : null}
        onReply={sessionOpener(props, card)}
      />
    );
  }

  if (kind === "ask" && ask) {
    const sendable = Boolean(props.onAnswer) && card.host === "paseo";
    if (askKind(ask) === "plain") {
      // Nothing to tap: the answer is the user's own words, written in the detail.
      return (
        <View style={s.itemActions}>
          <View style={s.itemActionsMain} />
          <View style={s.itemButtons}>
            {discuss}
            <SmallButton label="Reply ›" kind="secondary" onPress={() => props.onSelect(card.id)} s={s} />
          </View>
        </View>
      );
    }
    const chosen = actions.chosen(card, ask);
    const effect = chosen !== null ? askChoices(ask)[chosen]?.effect : undefined;
    return (
      <View style={s.itemActions}>
        <View style={s.itemActionsMain}>
          <ChoiceChips card={card} ask={ask} actions={actions} enabled={sendable && !busy} s={s} />
          {effect ? <Text style={s.itemEffect}>{effect}</Text> : null}
        </View>
        <View style={s.itemButtons}>
          {discuss}
          {sendable ? (
            <SmallButton
              label="Send"
              kind="primary"
              disabled={busy || chosen === null}
              onPress={() => {
                if (chosen !== null) props.onAnswer?.(card, { [ask.id]: chosen }, "");
              }}
              s={s}
            />
          ) : null}
        </View>
      </View>
    );
  }

  if (kind === "result") {
    const single = singleItem(card);
    const path = single?.kind === "result" && hrefKind(single.item.href) === "path" ? single.item.href : null;
    return (
      <View>
        <View style={[s.itemActions, { alignItems: "center" }]}>
          <View style={s.itemActionsMain}>
            <ResultLink card={card} actions={actions} props={props} s={s} />
          </View>
          <View style={s.itemButtons}>
            {discuss}
            {seen}
          </View>
        </View>
        {path && actions.revealed(card) ? (
          <Text style={s.itemPath} selectable>
            {path}
          </Text>
        ) : null}
      </View>
    );
  }

  if (kind === "receipt") {
    const single = singleItem(card);
    if (single?.kind !== "receipt") return null;
    const receipt = single.item;
    const failed = receipt.status === "failed";
    return (
      <View style={[s.itemActions, { alignItems: "center" }]}>
        <Text style={[s.itemNote, s.itemActionsMain]} numberOfLines={2}>
          <Text style={{ color: failed ? theme.colors.statusDanger : theme.colors.statusSuccess }}>{failed ? "✕ " : "✓ "}</Text>
          {receipt.line ?? receipt.conclusion}
        </Text>
        <View style={s.itemButtons}>
          {discuss}
          {seen}
        </View>
      </View>
    );
  }

  // error: the turn failed; the session is where to look
  const openSession = sessionOpener(props, card);
  return (
    <View style={[s.itemActions, { alignItems: "center" }]}>
      <View style={s.itemActionsMain}>
        {openSession ? (
          <Pressable accessibilityRole="button" onPress={openSession} style={pressStyle(s.itemLink, s.hover, s)}>
            <Text style={s.itemLinkText}>Open session</Text>
            <Text style={s.itemLinkGlyph}>›</Text>
          </Pressable>
        ) : null}
      </View>
      {seen}
    </View>
  );
}

/** One card in the overview: its line (tap for detail), its recall (none for host requests), then what it asks of the user. */
function ItemCard({ card, props, actions, s }: { card: QueueCard; props: QueueViewProps; actions: CardActions; s: Styles }) {
  const { theme } = props;
  const kind = cardKind(card);
  const host = kind === "permission" || kind === "error";
  return (
    <View style={s.item}>
      <View style={s.itemHead}>
        <Pressable accessibilityRole="button" onPress={() => props.onSelect(card.id)} style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.itemTitle, host ? { color: statusColor(theme, cardStatus(card)) } : null]} numberOfLines={host ? 2 : undefined}>
            {itemLine(card)}
          </Text>
        </Pressable>
        <DiscussingTag card={card} s={s} style={{ marginTop: 2 }} />
      </View>
      {host || !card.timeline ? null : <Steps card={card} s={s} theme={theme} boxed={false} lines={2} />}
      <ItemActions card={card} props={props} actions={actions} s={s} />
    </View>
  );
}

/** An older card that holds several items: its recall and counts, as before; tap to open. */
function ListCard({ card, s, theme, onSelect }: { card: QueueCard; s: Styles; theme: PluginTheme; onSelect(id: string): void }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => onSelect(card.id)} style={pressStyle(s.card, s.cardHover, s)}>
      <View style={s.cardHead}>
        <Text style={s.cardTitle} numberOfLines={1}>
          {cardTitle(card)}
        </Text>
      </View>
      <Steps card={card} s={s} theme={theme} boxed={false} lines={2} />
      <View style={s.needs}>
        <Counts card={card} s={s} theme={theme} />
        <Text style={s.go}>›</Text>
      </View>
    </Pressable>
  );
}

/** Fold state for the overview: whether a row is folded, and the tap that flips it. */
interface FoldControl {
  folded(key: string, byDefault: boolean): boolean;
  toggle(key: string, byDefault: boolean): void;
  /** Whether workspaces start folded, by the count of open cards. */
  workspaceDefault: boolean;
}

/** The fold chevron, as on Running: › turned down while open. */
function Chevron({ open, s }: { open: boolean; s: Styles }) {
  return <Text style={[s.chevron, open ? s.chevronOpen : null]}>›</Text>;
}

/** The status dot's color: a pending permission and a decision in the warning color, review and returned work in the accent. */
function foldColor(theme: PluginTheme, status: FoldStatus | null): string {
  return statusColor(theme, status === "review" ? "accent" : "warning");
}

const SEP = "\u2002·\u2002"; // en spaces: plain spaces collapse on the web
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** `2 sessions · 4 waiting · 1 permission`: sessions on workspace rows only, permissions only when one is pending (in the warning color). */
function SummaryText({ summary, sessions, s, theme }: { summary: FoldSummary; sessions: boolean; s: Styles; theme: PluginTheme }) {
  const counts = [...(sessions ? [plural(summary.sessions, "session")] : []), `${summary.waiting} waiting`].join(SEP);
  return (
    <Text style={s.summary} numberOfLines={1}>
      {counts}
      {summary.permissions ? <Text style={{ color: theme.colors.statusWarning }}>{`${SEP}${plural(summary.permissions, "permission")}`}</Text> : null}
    </Text>
  );
}

/**
 * A session's header: its topic and how long its oldest card has waited, then the agent line. A parent
 * without open cards is muted. Tapping the title row folds the session; folded, it says how many cards
 * wait under it (its children's included) and the oldest wait among them.
 */
function GroupHeader(props: { group: SessionGroup; data: QueueData; s: Styles; theme: PluginTheme; nowMs: number; folded: boolean; onToggle(): void }) {
  const { group, data, s, theme, nowMs, folded } = props;
  const latest = latestCard(group.cards);
  const own = group.cards.reduce<string | null>((a, b) => (a === null || b.firstReadyAt < a ? b.firstReadyAt : a), null);
  const summary = folded ? summarize([group]) : null;
  const oldest = summary ? summary.oldest : own;
  const name = latest
    ? latest.topic?.trim() || data.sessionTitles[group.sessionId] || cardTitle(latest)
    : data.sessionTitles[group.sessionId] || group.sessionId.slice(0, 8);
  return (
    <View style={s.groupHead}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !folded }}
        onPress={props.onToggle}
        style={pressStyle(s.groupTitleRow, s.hover, s)}
      >
        <Chevron open={!folded} s={s} />
        <Text style={[s.groupTitle, group.placeholder ? s.groupTitleMuted : null]} numberOfLines={1}>
          {name}
        </Text>
        {summary ? <SummaryText summary={summary} sessions={false} s={s} theme={theme} /> : null}
        {oldest ? <Text style={[s.waited, summary ? s.foldWaited : null]}>{elapsed(oldest, nowMs)}</Text> : null}
      </Pressable>
      {latest ? (
        <View style={s.groupMeta}>
          <AgentLineView card={latest} data={data} s={s} theme={theme} />
        </View>
      ) : null}
    </View>
  );
}

function GroupView(props: { group: SessionGroup; data: QueueData; view: QueueViewProps; actions: CardActions; fold: FoldControl; s: Styles; nowMs: number }) {
  const { group, data, view, actions, fold, s, nowMs } = props;
  const key = sessionFoldKey(group);
  const folded = fold.folded(key, false);
  return (
    <View style={s.group}>
      <GroupHeader group={group} data={data} s={s} theme={view.theme} nowMs={nowMs} folded={folded} onToggle={() => fold.toggle(key, false)} />
      {!folded && group.cards.length ? (
        <View style={s.groupCards}>
          {group.cards.map((card) =>
            cardKind(card) === "list" ? (
              <ListCard key={card.id} card={card} s={s} theme={view.theme} onSelect={view.onSelect} />
            ) : (
              <ItemCard key={card.id} card={card} props={view} actions={actions} s={s} />
            ),
          )}
        </View>
      ) : null}
      {!folded && group.children.length ? (
        <View style={s.children}>
          {group.children.map((child) => (
            <GroupView key={child.key} {...props} group={child} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * A workspace: one row (chevron, status dot, name, `N sessions · M waiting`, a pending permission, the
 * oldest wait) over its session groups, indented. Tapping the row folds it to the row alone. On a phone
 * the counts go under the name.
 */
function WorkspaceView(props: { workspace: WorkspaceGroup; data: QueueData; view: QueueViewProps; actions: CardActions; fold: FoldControl; s: Styles; nowMs: number }) {
  const { workspace, data, view, actions, fold, s, nowMs } = props;
  const { theme, compact } = view;
  const key = workspaceFoldKey(workspace);
  const folded = fold.folded(key, fold.workspaceDefault);
  const summary = summarize(workspace.sessions);
  const counts = <SummaryText summary={summary} sessions s={s} theme={theme} />;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !folded }}
        onPress={() => fold.toggle(key, fold.workspaceDefault)}
        style={pressStyle(s.workspaceRow, s.hover, s)}
      >
        <Chevron open={!folded} s={s} />
        <View style={[s.statusDot, { backgroundColor: foldColor(theme, summary.status) }]} />
        <Text style={s.workspaceName} numberOfLines={1}>
          {workspace.name}
        </Text>
        <View style={s.workspaceFill} />
        {compact ? null : counts}
        {summary.oldest ? <Text style={[s.waited, compact ? null : s.foldWaited]}>{elapsed(summary.oldest, nowMs)}</Text> : null}
      </Pressable>
      {compact ? <View style={s.workspaceSummaryLine}>{counts}</View> : null}
      {folded ? null : (
        <View style={s.workspaceBody}>
          {workspace.sessions.map((group) => (
            <GroupView key={group.key} group={group} data={data} view={view} actions={actions} fold={fold} s={s} nowMs={nowMs} />
          ))}
        </View>
      )}
    </View>
  );
}

// ---- detail: one card ---------------------------------------------------------

interface ItemDetailProps extends QueueViewProps {
  card: QueueCard;
  s: Styles;
  nowMs: number;
  actions: CardActions;
  reply: string;
  onReplyChange(text: string): void;
}

/** One card in full: the question, why now and every option with what it does; the result, receipt or request in full; a reply box. */
function ItemDetail(props: ItemDetailProps) {
  const { card, s, theme, nowMs, actions } = props;
  const kind = cardKind(card);
  const single = singleItem(card);
  const ask = soleAsk(card);
  const busy = props.busyCardId === card.id;
  const host = kind === "permission" || kind === "error";
  const sendable = Boolean(props.onAnswer) && card.host === "paseo";
  const chosen = kind === "ask" && ask && askKind(ask) !== "plain" ? actions.chosen(card, ask) : null;
  // Send takes a pick or a reply on an ask, a reply on a result; receipts and host requests have none.
  const canReply = sendable && (kind === "ask" || kind === "result");
  const ready = !busy && (chosen !== null || props.reply.trim() !== "");
  const picks: Picks = ask && chosen !== null ? { [ask.id]: chosen } : {};
  const onReply = sessionOpener(props, card);
  const onDiscuss = discusser(props, card);

  let body: ReactNode = null;
  if (kind === "ask" && ask) {
    const choices = askChoices(ask);
    const recommended = recommendedChoice(ask);
    body = (
      <View style={s.body}>
        {ask.short ? <Text style={s.bodyText}>{ask.question}</Text> : null}
        {ask.whyNow ? <Text style={s.bodyMuted}>{ask.whyNow}</Text> : null}
        {choices.length ? (
          <View style={s.options}>
            {choices.map((choice, index) => (
              <Pressable
                key={index}
                accessibilityRole="radio"
                accessibilityState={{ checked: chosen === index }}
                disabled={!sendable || busy}
                onPress={() => actions.pick(card, ask, index)}
                style={pressStyle([s.option, index ? s.optionDivider : null], s.hover, s)}
              >
                <View style={[s.radio, chosen === index ? s.radioPicked : null]} />
                <View style={s.optionBody}>
                  <Text style={s.optionLabel}>
                    {choice.label}
                    {index === recommended ? <Text style={s.optionTag}>{"  recommended"}</Text> : null}
                  </Text>
                  {choice.effect ? <Text style={s.optionNote}>{choice.effect}</Text> : null}
                  {index === recommended && ask.why ? <Text style={s.optionNote}>Why: {ask.why}</Text> : null}
                </View>
              </Pressable>
            ))}
          </View>
        ) : ask.why ? (
          <Text style={s.bodyMuted}>{ask.why}</Text>
        ) : null}
      </View>
    );
  } else if (kind === "result" && single?.kind === "result") {
    const result = single.item;
    const linkKind = hrefKind(result.href);
    body = (
      <View style={s.body}>
        {result.look ? <Text style={s.bodyText}>{result.look}</Text> : null}
        {result.note ? <Text style={s.bodyMuted}>{result.note}</Text> : null}
        {linkKind === "url" ? (
          <Pressable accessibilityRole="link" onPress={() => props.onOpenUrl(result.href ?? "")} style={pressStyle(s.itemLink, s.hover, s)}>
            <Text style={s.itemLinkText}>{result.href}</Text>
            <Text style={s.itemLinkGlyph}>↗</Text>
          </Pressable>
        ) : linkKind === "path" ? (
          <View>
            <Text style={[s.itemPath, { marginTop: 0 }]} selectable>
              {result.href}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => actions.copyPath(card, result.href ?? "")} style={pressStyle(s.itemLink, s.hover, s)}>
              <Text style={s.itemLinkText}>Copy path</Text>
              <Text style={s.itemLinkGlyph}>⧉</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  } else if (kind === "receipt" && single?.kind === "receipt") {
    const receipt = single.item;
    const failed = receipt.status === "failed";
    body = (
      <View style={s.body}>
        <Text style={[s.bodyMuted, { color: failed ? theme.colors.statusDanger : theme.colors.statusSuccess }]}>{failed ? "✕ Failed" : "✓ Returned"}</Text>
        <Text style={s.bodyText}>{receipt.conclusion}</Text>
      </View>
    );
  } else if (kind === "permission" && ask) {
    const onPermission = card.host === "paseo" ? props.onPermission : null;
    body = (
      <View style={s.body}>
        <Text style={[s.permDetail, { marginTop: 0 }]}>{ask.permission?.detail ?? ask.question}</Text>
        <PermissionChoices
          ask={ask}
          s={s}
          theme={theme}
          progress={props.permissionStates?.[`${card.id}/${ask.id}`]}
          onAnswer={onPermission ? (answer) => onPermission(card, ask, answer) : null}
          onReply={onReply}
        />
      </View>
    );
  } else if (kind === "error" && ask) {
    body = (
      <View style={s.body}>
        <Text style={s.bodyText}>{ask.question}</Text>
      </View>
    );
  }

  return (
    <View>
      <View style={s.top}>
        <Pressable accessibilityRole="button" onPress={() => props.onSelect(null)} style={pressStyle(s.back, s.hover, s)}>
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backText}>Inbox</Text>
        </Pressable>
        <DiscussingTag card={card} s={s} style={{ marginLeft: "auto", marginRight: 10 }} />
        <Text style={[s.topWaited, card.discussingAt ? { marginLeft: 0 } : null]}>{elapsed(card.firstReadyAt, nowMs)}</Text>
      </View>
      <View style={s.detail}>
        <Text style={s.topic} numberOfLines={1}>
          {cardTitle(card)}
        </Text>
        <AgentLineView card={card} data={props.data} s={s} theme={theme} />
        <Text style={[s.itemDetailTitle, host ? { color: statusColor(theme, cardStatus(card)) } : null]} accessibilityRole="header">
          {itemLine(card)}
        </Text>
        {host || !card.timeline ? null : <Steps card={card} s={s} theme={theme} boxed />}
        {body}

        <View style={s.footArea}>
          {canReply ? (
            <TextInput
              value={props.reply}
              onChangeText={props.onReplyChange}
              placeholder="Reply…"
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!busy}
              multiline
              style={s.replyInput}
            />
          ) : null}
          <View style={s.foot}>
            {canReply ? (
              <Pressable
                accessibilityRole="button"
                disabled={!ready}
                onPress={() => props.onAnswer?.(card, picks, props.reply)}
                style={pressStyle([s.button, s.primary, ready ? null : s.disabled], {}, s)}
              >
                <Text style={s.primaryText}>Send</Text>
              </Pressable>
            ) : null}
            {kind === "result" || kind === "receipt" || kind === "error" ? (
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => props.onDone(card)} style={pressStyle([s.button, s.secondary], s.hover, s)}>
                <Text style={s.secondaryText}>Seen</Text>
              </Pressable>
            ) : null}
            {onDiscuss ? (
              <Pressable accessibilityRole="button" disabled={busy} onPress={onDiscuss} style={pressStyle([s.button, s.secondary], s.hover, s)}>
                <Text style={s.secondaryText}>Discuss</Text>
              </Pressable>
            ) : null}
            {onReply ? (
              <Pressable accessibilityRole="button" onPress={onReply} style={pressStyle([s.button, s.secondary], s.hover, s)}>
                <Text style={s.secondaryText}>Open session</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => props.onSnooze(card)} style={pressStyle([s.quiet, s.footRight], s.hover, s)}>
              <Text style={s.quietText}>Later</Text>
            </Pressable>
            {kind === "ask" ? (
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => props.onDone(card)} style={pressStyle(s.quiet, s.hover, s)}>
                <Text style={s.quietText}>Dismiss</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </View>
  );
}

// ---- detail: an older card with several items -----------------------------------

interface AskState {
  chosen: number | null;
  expanded: boolean;
  /** False on cards from an external host and while sending: choices are shown but not picked. */
  pickable: boolean;
  onPick(index: number): void;
  onToggle(): void;
}

function Section({ label, count, s, children }: { label: string; count: number; s: Styles; children: ReactNode }) {
  return (
    <View>
      <View style={s.sectionHead}>
        <Text style={s.sectionLabel}>{label}</Text>
        {count ? <Text style={s.sectionCount}>{count}</Text> : null}
      </View>
      {children}
    </View>
  );
}

/** The question line: `short` (one line) with › to expand; old asks show the question in two lines. */
function QuestionLine({ ask, state, s }: { ask: QueueAsk; state: AskState; s: Styles }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: state.expanded }} onPress={state.onToggle}>
      <Text style={s.question} numberOfLines={ask.short || state.expanded ? undefined : 2}>
        {ask.short ?? ask.question}
        <Text style={s.more}>{state.expanded ? "  Hide" : "  ›"}</Text>
      </Text>
    </Pressable>
  );
}

/** Expanded ask: the full question, why now, and every choice with what it does. */
function FullAsk({ ask, state, s }: { ask: QueueAsk; state: AskState; s: Styles }) {
  const choices = askChoices(ask);
  const recommended = recommendedChoice(ask);
  return (
    <View>
      {ask.short || ask.whyNow ? (
        <View style={s.full}>
          {ask.short ? <Text style={s.fullQuestion}>{ask.question}</Text> : null}
          {ask.whyNow ? <Text style={s.fullWhy}>{ask.whyNow}</Text> : null}
        </View>
      ) : null}
      {choices.length ? (
        <View style={s.options}>
          {choices.map((choice, index) => (
            <Pressable
              key={index}
              accessibilityRole="radio"
              accessibilityState={{ checked: state.chosen === index }}
              disabled={!state.pickable}
              onPress={() => state.onPick(index)}
              style={pressStyle([s.option, index ? s.optionDivider : null], s.hover, s)}
            >
              <View style={[s.radio, state.chosen === index ? s.radioPicked : null]} />
              <View style={s.optionBody}>
                <Text style={s.optionLabel}>
                  {choice.label}
                  {index === recommended ? <Text style={s.optionTag}>{"  recommended"}</Text> : null}
                </Text>
                {choice.effect ? <Text style={s.optionNote}>{choice.effect}</Text> : null}
                {index === recommended && ask.why ? <Text style={s.optionNote}>Why: {ask.why}</Text> : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : ask.why ? (
        <View style={s.full}>
          <Text style={s.fullWhy}>{ask.why}</Text>
        </View>
      ) : null}
    </View>
  );
}

function ResolvedAsk({ ask, first, s }: { ask: QueueAsk; first: boolean; s: Styles }) {
  return (
    <View style={[s.listItem, first ? s.itemFirst : null]}>
      <View style={s.resolvedRow}>
        <Text style={s.check}>✓</Text>
        <Text style={[s.question, s.muted, { flex: 1 }]} numberOfLines={2}>
          {ask.short ?? ask.question}
        </Text>
      </View>
    </View>
  );
}

/** Decide: tap a chip to pick it, tap again to clear. */
function ThinkAsk({ ask, state, first, s }: { ask: QueueAsk; state: AskState; first: boolean; s: Styles }) {
  const choices = askChoices(ask);
  const effect = state.chosen !== null ? choices[state.chosen]?.effect : undefined;
  return (
    <View style={[s.listItem, first ? s.itemFirst : null]}>
      <QuestionLine ask={ask} state={state} s={s} />
      {state.expanded ? (
        <FullAsk ask={ask} state={state} s={s} />
      ) : (
        <>
          <View style={s.chips}>
            {choices.map((choice, index) => {
              const picked = state.chosen === index;
              return (
                <Pressable
                  key={index}
                  accessibilityRole="button"
                  accessibilityState={{ selected: picked }}
                  disabled={!state.pickable}
                  onPress={() => state.onPick(index)}
                  style={pressStyle([s.chip, picked ? s.chipPicked : null], s.hover, s)}
                >
                  <Text style={[s.chipText, picked ? s.chipTextPicked : null]} numberOfLines={1}>
                    {picked ? `✓ ${choice.label}` : choice.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {effect ? <Text style={s.effect}>{effect}</Text> : null}
        </>
      )}
    </View>
  );
}

/** Approve: the recommended choice starts picked; › shows every choice to change it. */
function NodAsk({ ask, state, first, s }: { ask: QueueAsk; state: AskState; first: boolean; s: Styles }) {
  const label = state.chosen !== null ? askChoices(ask)[state.chosen]?.label : undefined;
  return (
    <View style={[s.listItem, first ? s.itemFirst : null, { paddingTop: 11, paddingBottom: 12 }]}>
      <QuestionLine ask={ask} state={state} s={s} />
      {state.expanded ? (
        <FullAsk ask={ask} state={state} s={s} />
      ) : (
        <View style={s.answer}>
          <View style={[s.tick, label ? null : s.tickEmpty]}>{label ? <Text style={s.tickMark}>✓</Text> : null}</View>
          <Text style={[s.answerText, label ? null : s.answerNone]} numberOfLines={1}>
            {label ?? "No answer"}
          </Text>
        </View>
      )}
    </View>
  );
}

/** Nothing to pick (host asks, old asks without a recommendation): answered in the session. */
function PlainAsk({ ask, state, first, s, onReply }: { ask: QueueAsk; state: AskState; first: boolean; s: Styles; onReply: (() => void) | null }) {
  return (
    <View style={[s.listItem, first ? s.itemFirst : null]}>
      <QuestionLine ask={ask} state={state} s={s} />
      {state.expanded ? <FullAsk ask={ask} state={state} s={s} /> : null}
      {onReply ? (
        <Pressable accessibilityRole="button" onPress={onReply} style={pressStyle(s.reply, s.hover, s)}>
          <Text style={s.replyText}>Answer in session</Text>
        </Pressable>
      ) : (
        <Text style={[s.replyText, { marginTop: 6 }]}>Answer in session</Text>
      )}
    </View>
  );
}

/** A permission request on an older card: one line (› for the full request), then its choices or how it went. */
function PermissionAsk(props: {
  ask: QueueAsk;
  state: AskState;
  first: boolean;
  s: Styles;
  theme: PluginTheme;
  progress: PermissionState | undefined;
  onAnswer: ((answer: PermissionAnswer) => void) | null;
  onReply: (() => void) | null;
}) {
  const { ask, state, first, s, progress } = props;
  const done = progress && progress !== "busy" ? progress : null;
  return (
    <View style={[s.listItem, first ? s.itemFirst : null]}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: state.expanded }} onPress={state.onToggle} style={s.permLine}>
        <Text style={[s.question, s.permText, ask.resolved && !done ? s.muted : null]} numberOfLines={state.expanded ? undefined : 1}>
          {hostAskLine(ask)}
        </Text>
        <Text style={s.more}>{state.expanded ? "Hide" : "›"}</Text>
      </Pressable>
      {state.expanded ? <Text style={s.permDetail}>{ask.permission?.detail ?? ask.question}</Text> : null}
      <PermissionChoices ask={ask} s={s} theme={props.theme} progress={progress} onAnswer={props.onAnswer} onReply={props.onReply} />
    </View>
  );
}

function ExpandableText({ text, style, lines }: { text: string; style: (TextStyle | null)[]; lines: number }) {
  const [open, setOpen] = useState(false);
  return (
    <Text style={style} numberOfLines={open ? undefined : lines} onPress={() => setOpen((value) => !value)}>
      {text}
    </Text>
  );
}

interface DetailProps extends QueueViewProps {
  card: QueueCard;
  s: Styles;
  nowMs: number;
  actions: CardActions;
  askState(ask: QueueAsk): AskState;
  answers: Picks;
  reply: string;
  onReplyChange(text: string): void;
}

function Detail(props: DetailProps) {
  const { card, s, theme, nowMs, askState, answers } = props;
  const busy = props.busyCardId === card.id;
  // Resolved items stay visible, after the open ones.
  const openFirst = <T extends { resolved: boolean }>(items: T[]) => [...items.filter((i) => !i.resolved), ...items.filter((i) => i.resolved)];
  // Only host asks open (a host-made card, or one handed back with a permission pending): show just those.
  const host = hostOnly(card);
  const permissions = openFirst(card.asks.filter(isPermissionAsk));
  const think = openFirst(card.asks.filter((ask) => !isPermissionAsk(ask) && askKind(ask) !== "nod" && (!host || isHostAsk(ask))));
  const nod = host ? [] : openFirst(card.asks.filter((ask) => askKind(ask) === "nod"));
  const results = host ? [] : openFirst(card.results);
  const receipts = host ? [] : openFirst(card.receipts);
  // Send and Dismiss leave permission requests open, so with only those open they would do nothing.
  const waitingOnly = onlyPermissionsOpen(card);
  const open = (items: { resolved: boolean }[]) => items.filter((item) => !item.resolved).length;
  // Send hands the card back with the picks and an optional reply; external-host cards answer in the session.
  const canSend = Boolean(props.onAnswer) && card.host === "paseo" && !waitingOnly;
  const picked = Object.keys(answers).length;
  const ready = !busy && (picked > 0 || props.reply.trim() !== "");
  const onReply = sessionOpener(props, card);

  const permissionItem = (ask: QueueAsk, index: number) => {
    const key = `${card.id}/${ask.id}`;
    const progress = props.permissionStates?.[key];
    if (ask.resolved && !progress) return <ResolvedAsk key={ask.id} ask={ask} first={index === 0} s={s} />;
    const onPermission = card.host === "paseo" ? props.onPermission : null;
    return (
      <PermissionAsk
        key={ask.id}
        ask={ask}
        state={askState(ask)}
        first={index === 0}
        s={s}
        theme={theme}
        progress={progress}
        onAnswer={onPermission ? (answer) => onPermission(card, ask, answer) : null}
        onReply={onReply}
      />
    );
  };

  const askItem = (ask: QueueAsk, index: number) => {
    const first = index === 0;
    if (ask.resolved) return <ResolvedAsk key={ask.id} ask={ask} first={first} s={s} />;
    const state = askState(ask);
    const kind = askKind(ask);
    if (kind === "think") return <ThinkAsk key={ask.id} ask={ask} state={state} first={first} s={s} />;
    if (kind === "nod") return <NodAsk key={ask.id} ask={ask} state={state} first={first} s={s} />;
    return <PlainAsk key={ask.id} ask={ask} state={state} first={first} s={s} onReply={onReply} />;
  };

  return (
    <View>
      <View style={s.top}>
        <Pressable accessibilityRole="button" onPress={() => props.onSelect(null)} style={pressStyle(s.back, s.hover, s)}>
          <Text style={s.backChevron}>‹</Text>
          <Text style={s.backText}>Inbox</Text>
        </Pressable>
        <Text style={s.topWaited}>{elapsed(card.firstReadyAt, nowMs)}</Text>
      </View>
      <View style={s.detail}>
        <Text style={s.title} accessibilityRole="header">
          {cardTitle(card)}
        </Text>
        <AgentLineView card={card} data={props.data} s={s} theme={theme} />
        {host ? null : <Steps card={card} s={s} theme={theme} boxed lines={card.timeline ? 2 : undefined} />}

        {permissions.length ? (
          <Section label="Permission" count={open(permissions)} s={s}>
            {permissions.map(permissionItem)}
          </Section>
        ) : null}

        {think.length ? (
          <Section label="Decide" count={open(think)} s={s}>
            {think.map(askItem)}
          </Section>
        ) : null}

        {nod.length ? (
          <Section label="Approve" count={open(nod)} s={s}>
            {/* every nod row has a rule above it, the first one too */}
            {nod.map((ask, index) => askItem(ask, index + 1))}
          </Section>
        ) : null}

        {results.length ? (
          <Section label="Review" count={open(results)} s={s}>
            {results.map((result) => {
              const kind = hrefKind(result.href);
              const href = result.href ?? "";
              const sub = result.look ?? result.note ?? (kind === "path" ? displayPath(href) : null);
              return (
                <View key={result.id}>
                  <Pressable
                    accessibilityRole={kind === "url" ? "link" : "button"}
                    accessibilityHint={kind === "path" ? href : undefined}
                    disabled={kind === "text"}
                    onPress={() => (kind === "url" ? props.onOpenUrl(href) : props.actions.copyPath(card, href))}
                    style={pressStyle(s.row, s.hover, s)}
                  >
                    <View style={s.rowBody}>
                      <Text style={[s.rowTitle, result.resolved ? s.muted : null]} numberOfLines={2}>
                        {result.label}
                      </Text>
                      {sub ? (
                        <Text style={s.rowSub} numberOfLines={2}>
                          {sub}
                        </Text>
                      ) : null}
                    </View>
                    {result.resolved ? (
                      <Text style={[s.rowSide, { color: theme.colors.statusSuccess }]}>✓</Text>
                    ) : kind === "text" ? null : (
                      <Text style={s.rowSide}>{kind === "url" ? "↗" : "⧉"}</Text>
                    )}
                  </Pressable>
                  {kind === "path" && props.actions.revealed(card) ? (
                    <Text style={[s.itemPath, { marginTop: 0, marginBottom: 8 }]} selectable>
                      {href}
                    </Text>
                  ) : null}
                </View>
              );
            })}
          </Section>
        ) : null}

        {receipts.length ? (
          <Section label="Returned" count={open(receipts)} s={s}>
            {receipts.map((receipt) => {
              const failed = receipt.status === "failed" && !receipt.resolved;
              return (
                <View key={receipt.id} style={s.row}>
                  <Text style={[s.mark, { color: failed ? theme.colors.statusDanger : theme.colors.statusSuccess }]}>
                    {failed ? "✕" : "✓"}
                  </Text>
                  <View style={s.rowBody}>
                    <Text style={[s.rowTitle, receipt.resolved ? s.muted : null]}>{receipt.title}</Text>
                    {receipt.line ? (
                      <Text style={s.rowSub}>{receipt.line}</Text>
                    ) : (
                      <ExpandableText text={receipt.conclusion} lines={2} style={[s.rowSub]} />
                    )}
                  </View>
                </View>
              );
            })}
          </Section>
        ) : null}

        <View style={s.footArea}>
          {canSend ? (
            <TextInput
              value={props.reply}
              onChangeText={props.onReplyChange}
              placeholder="Reply…"
              placeholderTextColor={theme.colors.foregroundMuted}
              editable={!busy}
              multiline
              style={s.replyInput}
            />
          ) : null}
          <View style={s.foot}>
            {canSend ? (
              <Pressable
                accessibilityRole="button"
                disabled={!ready}
                onPress={() => props.onAnswer?.(card, answers, props.reply)}
                style={pressStyle([s.button, s.primary, ready ? null : s.disabled], {}, s)}
              >
                <Text style={s.primaryText}>{picked === 0 ? "Send" : picked === 1 ? "Send 1 answer" : `Send ${picked} answers`}</Text>
              </Pressable>
            ) : null}
            {onReply ? (
              <Pressable accessibilityRole="button" onPress={onReply} style={pressStyle([s.button, s.secondary], s.hover, s)}>
                <Text style={s.secondaryText}>Open session</Text>
              </Pressable>
            ) : null}
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => props.onSnooze(card)} style={pressStyle([s.quiet, s.footRight], s.hover, s)}>
              <Text style={s.quietText}>Later</Text>
            </Pressable>
            {waitingOnly ? null : (
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => props.onDone(card)} style={pressStyle(s.quiet, s.hover, s)}>
                <Text style={s.quietText}>Dismiss</Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

// ---- screen ---------------------------------------------------------------

function trackParentName(track: QueueTrack, data: QueueData): string {
  const id = track.parentSessionId;
  if (!id) return "—";
  const card = data.cards.find((c) => c.sessionId === id);
  return card ? cardTitle(card) : data.sessionTitles[id] ?? id.slice(0, 8);
}

/** Picks per card and ask; null means the user cleared a preselected recommendation. */
type PickState = Record<string, Record<string, number | null>>;

/** Items a re-filing replaced stay stored (so ids are never reused) but are not shown. */
function withoutDropped(card: QueueCard): QueueCard {
  if (!card.asks.some((a) => a.dropped) && !card.results.some((r) => r.dropped)) return card;
  return { ...card, asks: card.asks.filter((a) => !a.dropped), results: card.results.filter((r) => !r.dropped) };
}

export function QueueView(input: QueueViewProps) {
  const shownCards = useMemo(() => input.data.cards.map(withoutDropped), [input.data.cards]);
  const props = { ...input, data: { ...input.data, cards: shownCards } };
  const { theme, compact, data } = props;
  const s = useStyles(theme, compact);
  const [runningOpen, setRunningOpen] = useState(props.defaultRunningOpen ?? false);
  const [picks, setPicks] = useState<PickState>({});
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(props.defaultExpanded ?? []));
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() => new Set(props.defaultRevealed ?? []));
  const workspaces = useMemo(() => groupWorkspaces(groupSessions(data.cards, data.childOf), data.home), [data.cards, data.childOf, data.home]);
  const [ownFolds] = useState(() => new Map<string, boolean>());
  const folds = props.folds ?? ownFolds;
  const [, setFoldVersion] = useState(0);
  const nowMs = Date.parse(data.now) + (props.clockSkewMs ?? 0);
  const selected = data.cards.find((card) => card.id === props.selectedId) ?? null;
  const running = data.tracks;

  const chosen = (card: QueueCard, ask: QueueAsk): number | null => {
    const value = picks[card.id]?.[ask.id];
    if (value !== undefined) return value;
    return askKind(ask) === "nod" ? recommendedChoice(ask) : null;
  };

  const actions: CardActions = {
    chosen,
    pick: (card, ask, index) => {
      const current = chosen(card, ask);
      setPicks((all) => ({ ...all, [card.id]: { ...all[card.id], [ask.id]: current === index ? null : index } }));
    },
    revealed: (card) => revealed.has(card.id),
    // A path that could not be copied is shown in full on its card, to select by hand.
    copyPath: (card, path) => {
      void Promise.resolve(props.onCopyPath(path)).then((copied) => {
        if (copied === false) setRevealed((all) => new Set(all).add(card.id));
      });
    },
  };

  // Folding changes only what is shown; every count still covers all open cards.
  const fold: FoldControl = {
    folded: (key, byDefault) => isFolded(folds, key, byDefault),
    toggle: (key, byDefault) => {
      folds.set(key, !isFolded(folds, key, byDefault));
      setFoldVersion((version) => version + 1);
    },
    workspaceDefault: workspaceFoldedByDefault(data.cards.length),
  };

  /** What Send sends on an older card: unresolved asks with a pick. */
  const answersFor = (card: QueueCard): Picks => {
    const out: Picks = {};
    for (const ask of card.asks) {
      if (ask.resolved || askKind(ask) === "plain") continue;
      const index = chosen(card, ask);
      if (index !== null) out[ask.id] = index;
    }
    return out;
  };

  const askState = (card: QueueCard) => (ask: QueueAsk): AskState => {
    const key = `${card.id}/${ask.id}`;
    return {
      chosen: chosen(card, ask),
      expanded: expanded.has(key),
      pickable: card.host === "paseo" && Boolean(props.onAnswer) && props.busyCardId !== card.id,
      onPick: (index) => actions.pick(card, ask, index),
      onToggle: () =>
        setExpanded((all) => {
          const next = new Set(all);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        }),
    };
  };

  if (selected) {
    const reply = replies[selected.id] ?? "";
    const onReplyChange = (text: string) => setReplies((all) => ({ ...all, [selected.id]: text }));
    return (
      <View style={s.content}>
        {cardKind(selected) === "list" ? (
          <Detail
            {...props}
            card={selected}
            s={s}
            nowMs={nowMs}
            actions={actions}
            askState={askState(selected)}
            answers={answersFor(selected)}
            reply={reply}
            onReplyChange={onReplyChange}
          />
        ) : (
          <ItemDetail {...props} card={selected} s={s} nowMs={nowMs} actions={actions} reply={reply} onReplyChange={onReplyChange} />
        )}
      </View>
    );
  }

  return (
    <View style={s.content}>
      <View style={s.header}>
        <View style={s.headerTitle}>
          <Text style={s.headerText}>Inbox</Text>
          <Text style={s.headerCount}>{data.cards.length}</Text>
        </View>
        {running.length ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: runningOpen }}
            onPress={() => setRunningOpen((open) => !open)}
            style={pressStyle(s.runningToggle, s.hover, s)}
          >
            <Text style={[s.chevron, runningOpen ? s.chevronOpen : null]}>›</Text>
            <Text style={s.runningText}>Running</Text>
            <Text style={s.runningCount}>{running.length}</Text>
          </Pressable>
        ) : null}
      </View>

      {runningOpen && running.length ? (
        <View style={s.trackList}>
          {running.map((track, index) => (
            <View key={track.id} style={[s.trackRow, index ? s.trackDivider : null]}>
              <Text style={s.trackTitle} numberOfLines={2}>
                {track.title}
                <Text style={s.trackMeta}>{` · ${trackParentName(track, data)} · ${elapsed(track.startedAt, nowMs)}`}</Text>
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {workspaces.length ? (
        <View style={s.workspaces}>
          {workspaces.map((workspace) => (
            <WorkspaceView key={workspace.name} workspace={workspace} data={data} view={props} actions={actions} fold={fold} s={s} nowMs={nowMs} />
          ))}
        </View>
      ) : (
        <Text style={s.empty}>Nothing waiting</Text>
      )}
    </View>
  );
}
