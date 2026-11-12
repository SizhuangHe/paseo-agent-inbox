// Copying a path from the queue. Paseo's `copyText` needs the async clipboard, which a browser only
// offers on https or localhost; over plain http (Paseo web on a phone) it rejects. The fallback is the
// older hidden-textarea copy; when that fails too, the screen shows the path for the user to select.

/** The few DOM pieces the textarea copy needs, so it can run against a fake document in tests. */
export interface CopyDocument {
  body: { appendChild(node: unknown): unknown; removeChild(node: unknown): unknown };
  createElement(tag: "textarea"): {
    value: string;
    style: Record<string, string>;
    setAttribute(name: string, value: string): void;
    focus(): void;
    select(): void;
    setSelectionRange?(start: number, end: number): void;
  };
  execCommand(command: "copy"): boolean;
}

/** Copies through a hidden, selected textarea (`document.execCommand("copy")`). False when the browser refuses. */
export function copyBySelection(text: string, doc: CopyDocument): boolean {
  const area = doc.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  Object.assign(area.style, { position: "fixed", top: "0", left: "0", opacity: "0", pointerEvents: "none" });
  doc.body.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange?.(0, text.length);
    return doc.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    doc.body.removeChild(area);
  }
}

export interface CopyDeps {
  /** The host's clipboard copy (Paseo's `copyText`); rejects when unavailable or denied. */
  clipboard(text: string): Promise<void>;
  /**
   * False when the async clipboard is known to be missing (an insecure page): the textarea copy then
   * runs at once, inside the tap, where browsers allow it.
   */
  clipboardAvailable: boolean;
  /** The textarea copy, on the web only; null elsewhere. */
  selectionCopy: ((text: string) => boolean) | null;
}

/** Tries the clipboard, then the textarea copy. True when either copied; false means show the text instead. */
export async function copyWithFallback(text: string, deps: CopyDeps): Promise<boolean> {
  if (deps.clipboardAvailable) {
    try {
      await deps.clipboard(text);
      return true;
    } catch {
      // fall through to the textarea copy
    }
  }
  try {
    return deps.selectionCopy?.(text) ?? false;
  } catch {
    return false;
  }
}

/** Copy deps for the running client: the web's document and secure-context flag, when there is one. */
export function clientCopyDeps(clipboard: (text: string) => Promise<void>): CopyDeps {
  const web = globalThis as {
    document?: CopyDocument;
    isSecureContext?: boolean;
    navigator?: { clipboard?: unknown };
  };
  const doc = web.document && typeof web.document.execCommand === "function" ? web.document : null;
  return {
    clipboard,
    // Native apps have no document and copy through the host; a web page without the async API skips it.
    clipboardAvailable: !doc || (web.isSecureContext !== false && Boolean(web.navigator?.clipboard)),
    selectionCopy: doc ? (text) => copyBySelection(text, doc) : null,
  };
}
