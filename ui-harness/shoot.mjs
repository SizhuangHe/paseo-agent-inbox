// Headless screenshots of dist/index.html through the Chrome DevTools protocol, so the phone
// shot gets a true 390px viewport (a plain --window-size is clamped to Chrome's minimum width).
// usage: node shoot.mjs <out.png> <width> <scale> <mobile 0|1> [query]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const [out, width, scale, mobile, query = ""] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const page = `file://${join(here, "dist", "index.html")}?${query}`;
const profile = mkdtempSync(join(tmpdir(), "aq-chrome-"));
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"],
  { stdio: "ignore" },
);

try {
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !existsSync(portFile); i += 1) await sleep(100);
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = targets.find((t) => t.type === "page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (message) => {
    const data = JSON.parse(message.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    } else if (data.method) events.push(data.method);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (data) => (data.error ? reject(new Error(data.error.message)) : resolve(data.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  const w = Number(width);
  const metrics = { width: w, height: 900, deviceScaleFactor: Number(scale), mobile: mobile === "1" };
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", metrics);
  await send("Page.navigate", { url: page });
  for (let i = 0; i < 100 && !events.includes("Page.loadEventFired"); i += 1) await sleep(50);
  await sleep(500);
  const { result } = await send("Runtime.evaluate", {
    expression: "JSON.stringify({h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth})",
    returnByValue: true,
  });
  const size = JSON.parse(result.value);
  await send("Emulation.setDeviceMetricsOverride", { ...metrics, height: size.h });
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log(`${out}: viewport ${w}px, content ${size.w}x${size.h}px`);
  ws.close();
} finally {
  chrome.kill("SIGTERM"); // the Chrome process this script started
}
