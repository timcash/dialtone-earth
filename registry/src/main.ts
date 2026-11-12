import "./hud.css";
import {
  createGlobePlan,
  formatResource,
  loadNetworkIndex,
  loadNetworkOverview,
  resourceColumns,
  snapshotTimes,
  type OverviewEntry,
  type SnapshotTime,
} from "./overview";
import type { NetworkNode, NetworkSnapshot } from "./types";

const app = document.querySelector<HTMLDivElement>("#app")!;
if (!app) throw new Error("Missing app root");

void renderRoute();

async function renderRoute(): Promise<void> {
  const match = window.location.pathname.match(/^\/n\/([a-z0-9-]+)\/?$/);
  if (match) {
    await renderNetwork(match[1]);
    return;
  }

  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  await renderRegistry();
}

async function renderRegistry(): Promise<void> {
  document.title = "dialtone.earth - network registry";
  app.innerHTML = `
    <main class="hud-shell registry-page" aria-label="Dialtone network registry">
      <div class="globe-stage registry-globe" aria-hidden="true"></div>
      <div class="registry-tour" role="group" aria-label="Globe tour">
        <p class="tour-stop">Loading globe.</p>
        <div class="tour-actions">
          <button type="button" class="tour-toggle" hidden>Pause tour</button>
          <button type="button" class="tour-next" hidden>Next stop</button>
        </div>
      </div>
      <section class="registry-overlay" tabindex="0" aria-label="Network resources">
        <p class="registry-list-status" role="status">Loading registry.</p>
        <p class="registry-map-status" role="status"></p>
        <ul class="registry-list" role="list" aria-label="Dialtone networks"></ul>
        <details class="registry-notes">
          <summary>Snapshot and map details</summary>
          <p>CPU, MEM, DISK and GPU MEM show published capacity. Partial values cover only the
            indicated reporting nodes. Load is the mean one-minute load across reporting nodes.</p>
          <p>Dots mark approximate published locations. Schematic lines show network membership only.</p>
          <ul class="registry-provenance" role="list" aria-label="Snapshot times"></ul>
        </details>
      </section>
    </main>
  `;

  const list = app.querySelector<HTMLUListElement>(".registry-list")!;
  const provenance = app.querySelector<HTMLUListElement>(".registry-provenance")!;
  const listStatus = app.querySelector<HTMLElement>(".registry-list-status")!;
  const mapStatus = app.querySelector<HTMLElement>(".registry-map-status")!;
  const label = app.querySelector<HTMLElement>(".tour-stop")!;
  const toggle = app.querySelector<HTMLButtonElement>(".tour-toggle")!;
  const next = app.querySelector<HTMLButtonElement>(".tour-next")!;
  const stage = app.querySelector<HTMLElement>(".globe-stage")!;
  const index = await loadNetworkIndex().catch(() => null);
  const entries = index?.entries ?? [];
  if (!index || (index.skipped && !entries.length)) {
    listStatus.textContent = "Registry index unavailable.";
  } else if (index.skipped) {
    listStatus.textContent = "Some network index entries are unavailable.";
  } else {
    listStatus.textContent = entries.length ? "" : "No networks are published.";
  }

  const overviews = await Promise.all(entries.map(async (entry) => {
    const { row, nodeCount, resourceValues } = createNetworkRow(entry);
    list.append(row);
    const overview = await loadNetworkOverview(entry);
    const suffix = overview.snapshotStatus === "partial" ? " (partial)"
      : overview.snapshotStatus === "unavailable" ? " (index only)" : "";
    nodeCount.textContent = overview.nodeCount === null ? "Unavailable" : `${overview.nodeCount}${suffix}`;
    resourceColumns.forEach(({ key }, index) => {
      resourceValues[index].textContent = formatResource(key, overview.resources[key]);
    });
    return overview;
  }));
  provenance.innerHTML = overviews.filter(({ times }) => times.length).map(({ name, times }) =>
    `<li><strong>${escapeHtml(name)}</strong>${renderSnapshotTimes(times)}</li>`,
  ).join("");
  const plan = createGlobePlan(overviews);
  const incompleteMap = !!index?.skipped || overviews.some(({ nodes, nodeCount, snapshotStatus }) =>
    snapshotStatus !== "available" || nodes.length !== nodeCount,
  );
  mapStatus.textContent = !plan.stops.length ? "No node locations available."
    : incompleteMap ? "Some node locations are unavailable." : "";
  try {
    const { mountGlobe } = await import("./globe");
    await mountGlobe(stage, { plan, ui: { toggle, next, label } });
  } catch {
    label.textContent = "Globe unavailable.";
    toggle.hidden = true;
    next.hidden = true;
  }
}

function createNetworkRow(network: OverviewEntry) {
  const row = document.createElement("li");
  row.className = "registry-row";
  row.innerHTML = `
    <a class="registry-name" href="/n/${encodeURIComponent(network.slug)}">${escapeHtml(network.name)}</a>
    <dl class="registry-metrics">
      <div><dt>Nodes</dt><dd>${network.node_count ?? "Loading."}</dd></div>
      ${resourceColumns.map(({ label }) => `<div><dt>${label}</dt><dd>Loading.</dd></div>`).join("")}
    </dl>
  `;
  const [nodeCount, ...resourceValues] = row.querySelectorAll("dd");
  return { row, nodeCount, resourceValues };
}

async function renderNetwork(slug: string): Promise<void> {
  app.innerHTML = `
    <main class="hud-shell network-shell">
      <div class="globe-stage" aria-hidden="true"></div>
      <div class="network-loading" role="status">
        <span></span>
        acquiring network snapshot.
      </div>
    </main>
  `;

  try {
    const snapshot = await fetchJson<NetworkSnapshot>(
      `/networks/${encodeURIComponent(slug)}.json`,
    );
    if (!Array.isArray(snapshot?.nodes)) throw new Error("Invalid node list");
    const nodes = snapshot.nodes.filter((node) => node && typeof node === "object" && !Array.isArray(node));
    const networkName = displayText(snapshot.network, slug);
    document.title = `${networkName} - dialtone.earth`;
    const nodeCount = typeof snapshot.node_count === "number" &&
      Number.isSafeInteger(snapshot.node_count) && snapshot.node_count >= 0
      ? snapshot.node_count : nodes.length;
    const statusCount = nodes.filter((node) => typeof node.online === "boolean").length;
    const onlineCount = nodes.filter((node) => node.online === true).length;
    const online = statusCount === 0 && nodeCount > 0 ? "Unavailable"
      : `${onlineCount}/${nodeCount}${statusCount !== nodeCount ? " (partial)" : ""}`;
    const active = online === "Unavailable" ? "STATUS UNAVAILABLE" : `ACTIVE ${online}`;
    const dates = renderSnapshotTimes(snapshotTimes(snapshot)) || "Snapshot time unavailable";
    const shell = app.querySelector<HTMLElement>(".network-shell");
    const stage = app.querySelector<HTMLElement>(".globe-stage");
    if (!shell || !stage) return;

    app.querySelector(".network-loading")?.remove();
    shell.insertAdjacentHTML(
      "beforeend",
      `
        <div class="scene-shade" aria-hidden="true"></div>
        <section class="terminal-overlay network-terminal" aria-label="${escapeHtml(networkName)} network status">
          <a class="hud-brand" href="/">dialtone // earth</a>
          <div class="hud-title-row">
            <h1>NETWORK // ${escapeHtml(networkName.toUpperCase())}</h1>
            <span>SNAPSHOT</span>
          </div>
          <div class="network-summary" role="group" aria-label="Network summary">
            <span><b>NDS</b> ${nodeCount}</span>
            <span><b>ONL</b> ${online}</span>
            <span><b>REL</b> ${escapeHtml(displayText(snapshot.latest_release))}</span>
          </div>
          <div class="node-table" role="table" aria-label="${escapeHtml(networkName)} nodes">
            <div class="node-row node-row-header" role="row">
              <span role="columnheader">NODE</span>
              <span role="columnheader">OS</span>
              <span role="columnheader">VERSION</span>
              <span role="columnheader">RELAY</span>
              <span role="columnheader">RTT</span>
            </div>
            ${nodes.map(renderNode).join("")}
          </div>
        </section>
        <section class="tour-cc-bar network-cc" aria-label="Globe controls and snapshot">
          <p class="cc-channel">
            <span class="dim">CH:</span> ${escapeHtml(networkName.toUpperCase())}
            <span class="focus">${active}</span>
          </p>
          <div class="cc-footer-line">
            <a href="/">[ ESC ] REGISTRY</a>
            <span class="network-globe-help" role="status">DRAG TO ORBIT // SCROLL TO ZOOM</span>
            <span class="network-snapshot-times">${dates}</span>
          </div>
        </section>
      `,
    );
    try {
      const { mountGlobe } = await import("./globe");
      await mountGlobe(stage, { nodes });
    } catch {
      stage.replaceChildren();
      const help = app.querySelector(".network-globe-help");
      if (help) help.textContent = "Globe unavailable.";
    }
  } catch (error) {
    const shell = app.querySelector<HTMLElement>(".network-shell");
    if (shell) showNetworkError(shell, slug, error);
  }
}

function renderNode(node: NetworkNode): string {
  const latency = node.rtt_ms_from_grok_bot_metal;
  const rtt = latency === null ? "origin"
    : typeof latency === "number" && Number.isFinite(latency) && latency >= 0
      ? `${latency.toFixed(1)} ms` : "Unavailable";
  const version = displayText(node.version, "");
  const state = node.online === true ? "online" : node.online === false ? "offline" : "unknown";
  return `
    <div class="node-row" role="row">
      <span class="node-name" role="cell">
        <i class="${state}" aria-hidden="true"></i>
        ${escapeHtml(displayText(node.name))}
      </span>
      <span class="dim" role="cell">${escapeHtml(displayText(node.os))}</span>
      <span role="cell">${version ? `v${escapeHtml(version)}` : "Unavailable"}</span>
      <span class="dim" role="cell">${escapeHtml(displayText(node.relay_region))}</span>
      <span role="cell">${rtt}</span>
    </div>
  `;
}

function displayText(value: unknown, fallback = "Unavailable"): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function renderNotFound(): void {
  document.title = "not found - dialtone.earth";
  app.innerHTML = `
    <main class="hud-shell error-page">
      <section class="terminal-overlay">
        <a class="hud-brand" href="/">dialtone // earth</a>
        <h1>404 // NETWORK NOT FOUND</h1>
        <a class="text-link" href="/">[ ESC ] RETURN TO REGISTRY</a>
      </section>
    </main>
  `;
}

function showNetworkError(
  container: HTMLElement,
  slug: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : "unknown error";
  container.innerHTML = `
    <section class="terminal-overlay network-error">
      <p>NETWORK // ${escapeHtml(slug).toUpperCase()}</p>
      <h1>SNAPSHOT UNAVAILABLE</h1>
      <p class="dim">${escapeHtml(message)}</p>
      <a class="text-link" href="/">[ ESC ] RETURN TO REGISTRY</a>
    </section>
  `;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function renderSnapshotTimes(times: SnapshotTime[]): string {
  return times.map(({ label, dateTime, text }) =>
    `<span>${escapeHtml(label)} <time datetime="${escapeHtml(dateTime)}">${escapeHtml(text)}</time></span>`,
  ).join("");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#039;",
      })[character] ?? character,
  );
}
