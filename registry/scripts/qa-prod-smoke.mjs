import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CdpClient, DEFAULT_CDP_PORT, findChromeBinary, probeCdp, sleep } from "./cdp-session.mjs";

const PROD_ORIGIN = (process.env.PROD_ORIGIN || "https://dialtone.earth").replace(/\/+$/, "");
const METAL_ORIGIN = (process.env.PROD_METAL_ORIGIN || "https://metal.dialtone.earth").replace(/\/+$/, "");
const STAGING_ORIGIN = (process.env.PROD_STAGING_ORIGIN || "https://test.dialtone.earth").replace(/\/+$/, "");
const CDP_PORT = Number(process.env.DIALTONE_CDP_PORT || DEFAULT_CDP_PORT);
const OWNER_TOKEN = (process.env.DIALTONE_LIVE_TOKEN || "").trim();

async function checkHttpEndpoints() {
  console.log(`[prod-verify] 1/4 Checking live HTTP, headers & installer endpoints on ${PROD_ORIGIN}`);
  const home = await fetch(`${PROD_ORIGIN}/`, { redirect: "follow", signal: AbortSignal.timeout(15_000) });
  assert.equal(home.status, 200, `GET ${PROD_ORIGIN}/ expected 200, got ${home.status}`);
  const html = await home.text();
  assert.ok(html.includes("id=\"app\""), "Production HTML missing #app root");
  assert.ok(home.headers.get("strict-transport-security"), "Missing HSTS header on production");
  assert.ok(home.headers.get("content-security-policy"), "Missing CSP header on production");
  assert.equal(home.headers.get("x-frame-options"), "DENY", "Missing X-Frame-Options: DENY");

  const sessResp = await fetch(`${PROD_ORIGIN}/api/session`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(sessResp.status, 200, "GET /api/session must return 200");
  const sess = await sessResp.json();
  assert.equal(sess.authenticated, false, "Anonymous /api/session must not be authenticated");
  assert.equal(sess.mode, "simulated", "Anonymous /api/session must be in simulated mode");

  for (const installer of ["/install.sh", "/install.ps1"]) {
    const resp = await fetch(`${PROD_ORIGIN}${installer}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(resp.status, 200, `GET ${installer} expected 200, got ${resp.status}`);
    const body = await resp.text();
    assert.ok(!body.includes("github.com"), `${installer} must not depend on github.com`);
  }
  console.log("  [PASS] Production HTML, security headers, /api/session, and zero-GitHub installers OK");

  console.log(`[prod-verify] 2/4 Checking Cloudflare R2 plugins & release channels on ${PROD_ORIGIN}`);
  const pluginsResp = await fetch(`${PROD_ORIGIN}/api/plugins`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(pluginsResp.status, 200, `GET /api/plugins expected 200, got ${pluginsResp.status}`);
  const pluginsJson = await pluginsResp.json();
  assert.ok(
    Array.isArray(pluginsJson.plugins) && pluginsJson.plugins.some((p) => p.name === "dialtone-shell"),
    "Public plugin catalog missing dialtone-shell",
  );

  const channelsResp = await fetch(`${PROD_ORIGIN}/api/releases/dialtone/channels`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(channelsResp.status, 200, `GET /api/releases/dialtone/channels expected 200, got ${channelsResp.status}`);
  const channelsJson = await channelsResp.json();
  assert.equal(channelsJson.repo, "dialtone", "Unexpected channels repo payload");

  const releasesResp = await fetch(`${PROD_ORIGIN}/api/releases/dialtone-earth`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(releasesResp.status, 200, `GET /api/releases/dialtone-earth expected 200, got ${releasesResp.status}`);
  console.log("  [PASS] Public plugins catalog (dialtone-shell) and Cloudflare R2 release channels OK");

  console.log("[prod-verify] 3/4 Checking owner-only security containment across dialtone.earth, metal & test");
  const anonCode = await fetch(`${PROD_ORIGIN}/api/code`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(anonCode.status, 401, `Anonymous GET /api/code must be 401 (got ${anonCode.status})`);

  const anonBundle = await fetch(`${PROD_ORIGIN}/api/code/dialtone-earth/bundle`, {
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(anonBundle.status, 401, `Anonymous GET /api/code/dialtone-earth/bundle must be 401 (got ${anonBundle.status})`);

  const anonLivePatch = await fetch(`${PROD_ORIGIN}/api/live`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ banner: "unauthorized-smoke" }),
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(anonLivePatch.status, 401, `Anonymous PATCH /api/live must be 401 (got ${anonLivePatch.status})`);

  const anonMetal = await fetch(`${METAL_ORIGIN}/api/mesh/state`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(anonMetal.status, 401, `Anonymous GET ${METAL_ORIGIN}/api/mesh/state must be 401 (got ${anonMetal.status})`);

  const anonStaging = await fetch(`${STAGING_ORIGIN}/`, {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  assert.ok(
    anonStaging.status === 302 || anonStaging.status === 401 || anonStaging.status === 403,
    `Anonymous GET ${STAGING_ORIGIN}/ must redirect or block (got ${anonStaging.status})`,
  );

  if (OWNER_TOKEN) {
    const ownerCode = await fetch(`${PROD_ORIGIN}/api/code`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(ownerCode.status, 200, `Owner Bearer GET /api/code expected 200, got ${ownerCode.status}`);
    const ownerJson = await ownerCode.json();
    assert.ok(
      Array.isArray(ownerJson.repos) && ownerJson.repos.some((r) => r.name === "dialtone-earth"),
      "Owner /api/code missing dialtone-earth repo",
    );
  }
  console.log("  [PASS] Owner-only security containment verified across production, metal, and staging");
}

async function openTempBrowserTarget() {
  const status = await probeCdp(CDP_PORT);
  if (status.connected && status.browserWsUrl) {
    const browserCdp = new CdpClient(status.browserWsUrl, { headed: false });
    const created = await browserCdp.send("Target.createTarget", { url: "about:blank" });
    const targetId = created.targetId;
    await sleep(300);
    const updated = await probeCdp(CDP_PORT);
    const tab = (updated.targets || []).find((t) => t.id === targetId);
    if (tab?.webSocketDebuggerUrl) {
      const cdp = new CdpClient(tab.webSocketDebuggerUrl, {
        headed: false,
        targetOrigin: PROD_ORIGIN,
      });
      return {
        cdp,
        async cleanup() {
          cdp.disconnect();
          try {
            await browserCdp.send("Target.closeTarget", { targetId });
          } catch {
            // ignore
          }
          browserCdp.disconnect();
        },
      };
    }
    browserCdp.disconnect();
  }

  // Fallback: ephemeral headless Chrome
  const bin = findChromeBinary();
  const profileDir = mkdtempSync(join(tmpdir(), "dialtone-prod-smoke-"));
  const proc = spawn(
    bin,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--window-size=1440,900",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderrBuf = "";
  const wsPort = await new Promise((resolveFn, rejectFn) => {
    const timer = setTimeout(() => rejectFn(new Error("Headless Chrome did not start")), 10_000);
    proc.stderr.on("data", (chunk) => {
      stderrBuf += chunk.toString("utf8");
      const m = stderrBuf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolveFn(Number(m[1]));
      }
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      rejectFn(new Error(`Headless Chrome exited early (${code})`));
    });
  });
  const listResp = await fetch(`http://127.0.0.1:${wsPort}/json/list`);
  const list = await listResp.json();
  const page = list.find((t) => t.type === "page");
  const cdp = new CdpClient(page.webSocketDebuggerUrl, {
    headed: false,
    targetOrigin: PROD_ORIGIN,
  });
  return {
    cdp,
    async cleanup() {
      cdp.disconnect();
      try {
        proc.kill();
      } catch {
        // ignore
      }
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

async function checkLiveBrowserRender() {
  console.log(`[prod-verify] 4/4 Verifying live production UI render (wide + 1-col mobile) on ${PROD_ORIGIN}`);
  const { cdp, cleanup } = await openTempBrowserTarget();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Page.navigate", { url: `${PROD_ORIGIN}/` });
    await cdp.waitFor(
      "live production 3D globe & menu button",
      `document.querySelector('canvas[aria-label="Interactive H3 Earth globe"]') !== null && document.querySelector('[data-testid="open-config"]') !== null && document.body.innerText.includes("DIALTONE")`,
      20_000,
    );

    const desktopCheck = await cdp.eval(`(() => {
      const tabs = document.querySelectorAll('.earth-bar-tabs [data-pick-content]').length;
      const bottomButtons = document.querySelectorAll('#bottom-table-dock .earth-table-bar button, #bottom-table-dock .earth-table-bar a').length;
      const bottomCaptions = document.querySelectorAll('#bottom-table-dock [data-testid="tour-captions"]').length;
      const globeHeaders = document.querySelectorAll('.globe-pane .earth-pane-head').length;
      const globeOverlay = document.querySelectorAll('.globe-pane [data-testid="globe-meta-overlay"]').length;
      const menuBtn = document.querySelector('[data-testid="open-config"]')?.textContent?.trim() || "";
      const hasSim = document.body.innerText.includes("SIM");
      const leaked = document.body.innerText.includes("legion") || document.body.innerText.includes("test-alpha");
      return { tabs, bottomButtons, bottomCaptions, globeHeaders, globeOverlay, menuBtn, hasSim, leaked };
    })()`);
    assert.equal(desktopCheck.tabs, 0, `Expected 0 bottom-bar window-set tabs on production, got ${desktopCheck.tabs}`);
    assert.equal(desktopCheck.bottomButtons, 1, `Expected only menu button on bottom bar, got ${desktopCheck.bottomButtons}`);
    assert.equal(desktopCheck.bottomCaptions, 1, "Expected closed captions on bottom bar");
    assert.equal(desktopCheck.globeHeaders, 0, "Expected 0 header bars on 3D globe pane");
    assert.equal(desktopCheck.globeOverlay, 1, "Expected right-side metadata overlay inside 3D globe");
    assert.equal(desktopCheck.hasSim, true, "Production signed-out landing should show SIM badge");
    assert.equal(desktopCheck.leaked, false, "Production signed-out landing leaked private node names");

    // Verify mobile viewport strictly renders 1 column on live production
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await cdp.eval(`window.dispatchEvent(new Event("resize"))`);
    await sleep(350);
    const mobileCheck = await cdp.eval(`(() => {
      const grid = document.querySelector('[data-testid="split-grid"]');
      if (!grid) return { ok: false, reason: "missing split-grid" };
      const cols = getComputedStyle(grid).gridTemplateColumns.trim().split(/\\s+/).filter(Boolean).length;
      const layout = grid.getAttribute("data-layout");
      return { ok: cols === 1 && (layout === "1" || layout === "1/1"), width: window.innerWidth, cols, layout };
    })()`);
    assert.equal(
      mobileCheck.ok,
      true,
      `Live production mobile viewport must strictly render 1 column (got ${JSON.stringify(mobileCheck)})`,
    );

    assert.equal(
      cdp.exceptions.length,
      0,
      `Uncaught runtime JS exceptions on live ${PROD_ORIGIN}:\n${cdp.exceptions.join("\n")}`,
    );
    assert.equal(
      cdp.serverErrors.length,
      0,
      `Unexpected 5xx responses on live ${PROD_ORIGIN}:\n${cdp.serverErrors.join("\n")}`,
    );
    console.log(
      `  [PASS] Live production UI verified (0 JS errors, 0 5xx, menu="${desktopCheck.menuBtn}", bottomTabs=${desktopCheck.tabs}, mobile=${mobileCheck.width}px cols=${mobileCheck.cols} layout="${mobileCheck.layout}")`,
    );
  } finally {
    await cleanup();
  }
}

async function main() {
  await checkHttpEndpoints();
  await checkLiveBrowserRender();
  console.log("ALL LIVE PRODUCTION SMOKE CHECKS PASSED.");
}

main().catch((err) => {
  console.error("LIVE PRODUCTION SMOKE CHECK FAILED:", err?.message || err);
  process.exit(1);
});
