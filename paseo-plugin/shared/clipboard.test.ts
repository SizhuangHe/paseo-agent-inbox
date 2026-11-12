import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clientCopyDeps, copyBySelection, copyWithFallback, type CopyDocument } from "./clipboard.ts";

/** A fake document that records the textarea copy; `exec` decides how execCommand goes. */
function fakeDocument(exec: () => boolean) {
  const log: string[] = [];
  const attached = new Set<unknown>();
  const doc: CopyDocument = {
    body: {
      appendChild(node) {
        attached.add(node);
        log.push("append");
        return node;
      },
      removeChild(node) {
        attached.delete(node);
        log.push("remove");
        return node;
      },
    },
    createElement() {
      const area = {
        value: "",
        style: {} as Record<string, string>,
        setAttribute: (name: string) => log.push(`attr ${name}`),
        focus: () => log.push("focus"),
        select: () => log.push(`select ${area.value}`),
        setSelectionRange: (start: number, end: number) => log.push(`range ${start}-${end}`),
      };
      return area;
    },
    execCommand(command) {
      log.push(`exec ${command}`);
      return exec();
    },
  };
  return { doc, log, attached };
}

describe("copyBySelection", () => {
  it("selects the text in a hidden textarea, copies it, and removes the textarea", () => {
    const { doc, log, attached } = fakeDocument(() => true);
    assert.equal(copyBySelection("/tmp/a b.md", doc), true);
    assert.deepEqual(log, ["attr readonly", "append", "focus", "select /tmp/a b.md", "range 0-11", "exec copy", "remove"]);
    assert.equal(attached.size, 0);
  });

  it("is false when the browser refuses or throws, and still removes the textarea", () => {
    for (const exec of [() => false, () => { throw new Error("SecurityError"); }]) {
      const { doc, attached } = fakeDocument(exec);
      assert.equal(copyBySelection("/tmp/x", doc), false);
      assert.equal(attached.size, 0);
    }
  });
});

describe("copyWithFallback", () => {
  const deps = (over: Partial<Parameters<typeof copyWithFallback>[1]> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        clipboard: async (text: string) => {
          calls.push(`clipboard ${text}`);
        },
        clipboardAvailable: true,
        selectionCopy: (text: string) => {
          calls.push(`selection ${text}`);
          return true;
        },
        ...over,
      },
    };
  };

  it("uses the clipboard when it works", async () => {
    const { calls, deps: d } = deps();
    assert.equal(await copyWithFallback("/p", d), true);
    assert.deepEqual(calls, ["clipboard /p"]);
  });

  it("falls back to the textarea copy when the clipboard rejects", async () => {
    const { calls, deps: d } = deps({
      clipboard: async () => {
        calls.push("clipboard");
        throw new Error("Clipboard copy is unavailable in this browser");
      },
    });
    assert.equal(await copyWithFallback("/p", d), true);
    assert.deepEqual(calls, ["clipboard", "selection /p"]);
  });

  it("without the clipboard (plain http), copies by selection at once, inside the tap", () => {
    const { calls, deps: d } = deps({ clipboardAvailable: false });
    const pending = copyWithFallback("/p", d);
    assert.deepEqual(calls, ["selection /p"], "ran before the first await");
    return pending.then((copied) => assert.equal(copied, true));
  });

  it("is false when both fail, or there is no textarea copy, so the card shows the path instead", async () => {
    const failing = async () => {
      throw new Error("denied");
    };
    assert.equal(await copyWithFallback("/p", deps({ clipboard: failing, selectionCopy: () => false }).deps), false);
    assert.equal(await copyWithFallback("/p", deps({ clipboard: failing, selectionCopy: null }).deps), false);
    const throwing = () => {
      throw new Error("no document");
    };
    assert.equal(await copyWithFallback("/p", deps({ clipboardAvailable: false, selectionCopy: throwing }).deps), false);
  });
});

describe("clientCopyDeps", () => {
  const web = globalThis as { document?: unknown; isSecureContext?: boolean };

  it("off the web (no document), uses the host's clipboard only", () => {
    assert.equal(web.document, undefined);
    const deps = clientCopyDeps(async () => {});
    assert.equal(deps.clipboardAvailable, true);
    assert.equal(deps.selectionCopy, null);
  });

  it("on an insecure web page, skips the clipboard and copies by selection", () => {
    const { doc, log } = fakeDocument(() => true);
    web.document = doc;
    web.isSecureContext = false;
    try {
      const deps = clientCopyDeps(async () => {});
      assert.equal(deps.clipboardAvailable, false);
      assert.equal(deps.selectionCopy?.("/p"), true);
      assert.ok(log.includes("exec copy"));
    } finally {
      delete web.document;
      delete web.isSecureContext;
    }
  });
});
