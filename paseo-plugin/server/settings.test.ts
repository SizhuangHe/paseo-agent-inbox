import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { externalSessionUrl } from "../shared/cards.ts";
import { readConfigFile, readSettings } from "./settings.ts";

/** A settings file with the given text, in a new directory. */
function configFile(text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "agent-inbox-config-")), "config.json");
  writeFileSync(path, text);
  return path;
}

describe("readSettings", () => {
  it("defaults to English messages and no external session page", () => {
    assert.deepEqual(readSettings({}), { lang: "en", externalUrl: null, invalidExternalUrl: null });
  });

  it("reads the message language and an http(s) external session URL", () => {
    assert.deepEqual(readSettings({ AGENT_INBOX_LANG: "zh", AGENT_INBOX_EXTERNAL_URL: " https://agents.example.com/s/{session} " }), {
      lang: "zh",
      externalUrl: "https://agents.example.com/s/{session}",
      invalidExternalUrl: null,
    });
  });

  it("ignores an external URL that is not http(s), and says so", () => {
    for (const url of ["ftp://agents.example.com", "javascript:alert(1)", "agents.example.com"]) {
      assert.deepEqual(readSettings({ AGENT_INBOX_EXTERNAL_URL: url }), { lang: "en", externalUrl: null, invalidExternalUrl: url });
    }
    assert.equal(readSettings({ AGENT_INBOX_EXTERNAL_URL: "  " }).invalidExternalUrl, null);
  });
});

describe("settings file", () => {
  const URL_FILE = "https://file.example.com/s/{session}";
  const URL_ENV = "https://env.example.com/s/{session}";

  it("supplies the language and external URL when the environment does not set them", () => {
    assert.deepEqual(readSettings({}, { lang: "zh", externalUrl: URL_FILE }), { lang: "zh", externalUrl: URL_FILE, invalidExternalUrl: null });
    assert.deepEqual(readSettings({ AGENT_INBOX_LANG: "", AGENT_INBOX_EXTERNAL_URL: "  " }, { lang: "zh", externalUrl: URL_FILE }), {
      lang: "zh",
      externalUrl: URL_FILE,
      invalidExternalUrl: null,
    });
  });

  it("loses to an environment variable that is set", () => {
    assert.deepEqual(readSettings({ AGENT_INBOX_LANG: "en", AGENT_INBOX_EXTERNAL_URL: URL_ENV }, { lang: "zh", externalUrl: URL_FILE }), {
      lang: "en",
      externalUrl: URL_ENV,
      invalidExternalUrl: null,
    });
    assert.equal(readSettings({ AGENT_INBOX_LANG: "zh" }, { lang: "en" }).lang, "zh");
    assert.deepEqual(readSettings({ AGENT_INBOX_EXTERNAL_URL: "ftp://env.example.com" }, { externalUrl: URL_FILE }), {
      lang: "en",
      externalUrl: null,
      invalidExternalUrl: "ftp://env.example.com",
    });
  });

  it("reads lang and externalUrl from the file, ignoring other keys and values that are not strings", () => {
    assert.deepEqual(readConfigFile(configFile(JSON.stringify({ lang: "zh", externalUrl: URL_FILE, other: 1 }))), {
      config: { lang: "zh", externalUrl: URL_FILE },
      error: null,
    });
    assert.deepEqual(readConfigFile(configFile(JSON.stringify({ lang: 1, externalUrl: null }))), { config: {}, error: null });
  });

  it("treats a missing file as no settings, and a broken one as none with the reason", () => {
    assert.deepEqual(readConfigFile(join(tmpdir(), "agent-inbox-no-such-dir", "config.json")), { config: {}, error: null });
    for (const text of ["{lang: zh}", "[]", "null", '"zh"']) {
      const result = readConfigFile(configFile(text));
      assert.deepEqual(result.config, {}, text);
      assert.match(result.error ?? "", /config\.json: not (valid JSON|a JSON object)/, text);
    }
  });
});

describe("externalSessionUrl", () => {
  it("puts the session id, encoded, wherever {session} stands; a URL without it opens as is", () => {
    assert.equal(externalSessionUrl("https://agents.example.com/s/{session}?from={session}", "a b/c"), "https://agents.example.com/s/a%20b%2Fc?from=a%20b%2Fc");
    assert.equal(externalSessionUrl("http://localhost:3080/", "s1"), "http://localhost:3080/");
  });
});
