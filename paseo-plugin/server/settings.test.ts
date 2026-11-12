import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { externalSessionUrl } from "../shared/cards.ts";
import { readSettings } from "./settings.ts";

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

describe("externalSessionUrl", () => {
  it("puts the session id, encoded, wherever {session} stands; a URL without it opens as is", () => {
    assert.equal(externalSessionUrl("https://agents.example.com/s/{session}?from={session}", "a b/c"), "https://agents.example.com/s/a%20b%2Fc?from=a%20b%2Fc");
    assert.equal(externalSessionUrl("http://localhost:3080/", "s1"), "http://localhost:3080/");
  });
});
