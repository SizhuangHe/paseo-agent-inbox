// Pure display helpers for the inbox screen.
import { askKind, isPermissionAsk, singleItem } from "../shared/cards";
import type { QueueCard } from "../shared/rpc";

export { cardTitle, isPermissionAsk } from "../shared/cards";

export type CardStatus = "danger" | "warning" | "accent";

const ERROR_ASK = "err:";

/** Dot color: an unresolved error → danger; other unresolved asks → warning; results only → accent. */
export function cardStatus(card: QueueCard): CardStatus {
  const open = card.asks.filter((ask) => !ask.resolved);
  if (open.some((ask) => ask.id.startsWith(ERROR_ASK))) return "danger";
  if (card.receipts.some((receipt) => receipt.status === "failed" && !receipt.resolved) && open.length === 0) return "danger";
  if (open.length) return "warning";
  return "accent";
}

/** "now", "40m", "3h", "2d". */
export function elapsed(fromIso: string, nowMs: number): string {
  const ms = Math.max(0, nowMs - Date.parse(fromIso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** An ask the host filed (a permission request or a failed turn), not the agent. */
export const isHostAsk = (ask: { id: string }) => isPermissionAsk(ask) || ask.id.startsWith(ERROR_ASK);

/** A host ask as one line: the request or the error, without its `Permission:` / `Error:` prefix. */
export function hostAskLine(ask: { question: string }): string {
  return ask.question.replace(/^(Permission:|Error:)\s*/, "");
}

/**
 * What a card holds, as the screen shows it: an agent ask, a permission request, a failed turn, a
 * result or a receipt; `list` for older cards that hold several items.
 */
export type CardKind = "ask" | "permission" | "error" | "result" | "receipt" | "list";

export function cardKind(card: QueueCard): CardKind {
  const single = singleItem(card);
  if (!single) return "list";
  if (single.kind !== "ask") return single.kind;
  if (isPermissionAsk(single.item)) return "permission";
  return single.item.id.startsWith(ERROR_ASK) ? "error" : "ask";
}

function openItems(card: QueueCard): { id: string }[] {
  return [...card.asks, ...card.results, ...card.receipts].filter((item) => !item.resolved);
}

/**
 * Only host asks are open: a card the host made (a permission request or a failed turn), or one the
 * user handed back while a permission request is still pending. It shows just those asks.
 */
export function hostOnly(card: QueueCard): boolean {
  const open = openItems(card);
  return open.length > 0 && open.every(isHostAsk);
}

/** Only permission requests are open: nothing to send or dismiss until they are answered. */
export function onlyPermissionsOpen(card: QueueCard): boolean {
  const open = openItems(card);
  return open.length > 0 && open.every(isPermissionAsk);
}

/**
 * Unresolved items by what they ask of the user: permission requests, decide (think), approve (nod),
 * review (look), returned (receipts).
 */
export interface CardCounts {
  permission: number;
  think: number;
  nod: number;
  look: number;
  receipts: number;
}

export function cardCounts(card: QueueCard): CardCounts {
  const asks = card.asks.filter((ask) => !ask.resolved);
  return {
    permission: asks.filter(isPermissionAsk).length,
    think: asks.filter((ask) => !isPermissionAsk(ask) && askKind(ask) !== "nod").length,
    nod: asks.filter((ask) => askKind(ask) === "nod").length,
    look: card.results.filter((result) => !result.resolved).length,
    receipts: card.receipts.filter((receipt) => !receipt.resolved).length,
  };
}

/** Home directory shown as ~. */
export function displayPath(path: string | null): string | null {
  if (!path) return null;
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, "~").replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

/** `#rrggbb` a moved toward b by t (0–1); a when either is not a 6-digit hex color. */
export function mix(a: string, b: string, t: number): string {
  const parse = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) : null);
  const from = parse(a);
  const to = parse(b);
  if (!from || !to) return a;
  return `#${from.map((v, i) => Math.round(v + (to[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

const HTTP_URL = /^https?:\/\/\S+$/i;

/** True only for http(s) URLs; javascript:, file:, custom protocols and anything else are never opened. */
export function isOpenableUrl(href: string): boolean {
  if (!HTTP_URL.test(href)) return false;
  let protocol: string;
  try {
    protocol = new URL(href).protocol;
  } catch (error) {
    // React Native's URL polyfill may not implement `protocol`; the strict pattern above
    // already limits the scheme to http(s), so only a parse failure on the web rejects here.
    return error instanceof TypeError ? false : true;
  }
  return protocol === "http:" || protocol === "https:";
}

export function isAbsolutePath(href: string): boolean {
  return href.startsWith("/") || href.startsWith("~/");
}

/** How a result link is shown: opened (http/https), copied (absolute path) or plain text. */
export function hrefKind(href: string | undefined): "url" | "path" | "text" {
  if (!href) return "text";
  if (isOpenableUrl(href)) return "url";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(href) && isAbsolutePath(href)) return "path";
  return "text";
}
