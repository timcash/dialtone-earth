import "./hud.css";
import { aggregateNetwork } from "./aggregates";
import type {
  NetworkIndex,
  NetworkNode,
  NetworkSnapshot,
  OverviewNetwork,
} from "./types";

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
  document.title = "dialtone.earth — network overview";
  app.innerHTML = `
    <main class="hud-shell overview-page">
      <div class="globe-stage"></div>
      <div class="scene-shade" aria-hidden="true"></div>
      <section class="overview-overlay" aria-label="Dialtone network totals">
        <a class="overview-wordmark" href="/">dialtone // earth</a>
        <div class="overview-table" role="table" aria-label="Dialtone networks">
          <div class="overview-row overview-row-header" role="row">
            <span role="columnheader">NETWORK</span>
            <span role="columnheader">NODES</span>
            <span role="columnheader">CPU</span>
            <span role="columnheader">MEM</span>
            <span role="columnheader">DISK</span>
            <span role="columnheader">GPU MEM</span>
            <span role="columnheader">LOAD</span>
          </div>
          <div class="loading-row" role="status">LOADING NETWORKS...</div>
        </div>
      </section>
    </main>
  `;

  const list = app.querySelector<HTMLElement>(".overview-table");
  const stage = app.querySelector<HTMLElement>(".globe-stage");
  if (!list || !stage) return;

  try {
    const index = await fetchJson<NetworkIndex>("/networks/index.json");
    const networks = await Promise.all(
      index.networks.map(async (entry): Promise<OverviewNetwork> => ({
        slug: entry.slug,
        snapshot: await fetchJson<NetworkSnapshot>(
          `/networks/${encodeURIComponent(entry.slug)}.json`,
        ),
      })),
    );
    const loading = list.querySelector(".loading-row");
    loading?.remove();
    networks.forEach((network) => {
      list.append(createOverviewRow(network));
    });
    const { mountOverviewGlobe } = await import("./overview-globe");
    await mountOverviewGlobe(stage, networks, (slug) => {
      list
        .querySelectorAll<HTMLElement>(".overview-network-row")
        .forEach((row) => {
          row.classList.toggle("is-active", row.dataset.network === slug);
        });
    });
  } catch (error) {
    showLoadError(list, error);
  }
}

function createOverviewRow(network: OverviewNetwork): HTMLDivElement {
  const metrics = aggregateNetwork(network.snapshot);
  const row = document.createElement("div");
  row.className = "overview-row overview-network-row";
  row.dataset.network = network.slug;
  row.setAttribute("role", "row");
  row.innerHTML = `
    <a class="overview-network-name" role="cell" href="/n/${network.slug}">${escapeHtml(network.snapshot.network)}</a>
    <span role="cell">${network.snapshot.node_count}</span>
    <span role="cell">${metrics.cpu}</span>
    <span role="cell">${metrics.memory}</span>
    <span role="cell">${metrics.disk}</span>
    <span role="cell">${metrics.gpuMemory}</span>
    <span role="cell">${metrics.load}</span>
  `;
  return row;
}

async function renderNetwork(slug: string): Promise<void> {
  app.innerHTML = `
    <main class="hud-shell network-shell">
      <div class="globe-stage" aria-hidden="true"></div>
      <div class="network-loading" role="status">
        <span></span>
        acquiring network snapshot…
      </div>
    </main>
  `;

  try {
    const snapshot = await fetchJson<NetworkSnapshot>(
      `/networks/${encodeURIComponent(slug)}.json`,
    );
    document.title = `${snapshot.network} — dialtone.earth`;
    const onlineCount = snapshot.nodes.filter((node) => node.online).length;
    const shell = app.querySelector<HTMLElement>(".network-shell");
    const stage = app.querySelector<HTMLElement>(".globe-stage");
    if (!shell || !stage) return;

    app.querySelector(".network-loading")?.remove();
    shell.insertAdjacentHTML(
      "beforeend",
      `
        <div class="scene-shade" aria-hidden="true"></div>
        <section class="terminal-overlay network-terminal" aria-label="${escapeHtml(snapshot.network)} network status">
          <a class="hud-brand" href="/">dialtone // earth</a>
          <div class="hud-title-row">
            <h1>NETWORK // ${escapeHtml(snapshot.network).toUpperCase()}</h1>
            <span>LIVE SNAPSHOT</span>
          </div>
          <div class="network-summary" role="group" aria-label="Network summary">
            <span><b>NDS</b> ${snapshot.node_count}</span>
            <span><b>ONL</b> ${onlineCount}/${snapshot.node_count}</span>
            <span><b>REL</b> ${escapeHtml(snapshot.latest_release)}</span>
          </div>
          <div class="node-table" role="table" aria-label="${escapeHtml(snapshot.network)} nodes">
            <div class="node-row node-row-header" role="row">
              <span role="columnheader">NODE</span>
              <span role="columnheader">OS</span>
              <span role="columnheader">VERSION</span>
              <span role="columnheader">RELAY</span>
              <span role="columnheader">RTT</span>
            </div>
            ${snapshot.nodes.map(renderNode).join("")}
          </div>
        </section>
        <section class="tour-cc-bar network-cc" aria-label="Globe controls and snapshot">
          <p class="cc-channel">
            <span class="dim">CH:</span> ${escapeHtml(snapshot.network).toUpperCase()}
            <span class="focus">ACTIVE ${onlineCount}/${snapshot.node_count}</span>
          </p>
          <div class="cc-footer-line">
            <a href="/">[ ESC ] REGISTRY</a>
            <span>DRAG TO ORBIT // SCROLL TO ZOOM</span>
            <span class="network-snapshot-times">${renderSnapshotTimes(snapshot)}</span>
          </div>
        </section>
      `,
    );
    const { mountGlobe } = await import("./globe");
    await mountGlobe(stage, snapshot.nodes);
  } catch (error) {
    const shell = app.querySelector<HTMLElement>(".network-shell");
    if (shell) showNetworkError(shell, slug, error);
  }
}

function renderNode(node: NetworkNode): string {
  const reportedRtt =
    node.rtt_ms ?? node.rtt_ms_from_grok_bot_metal ?? null;
  const rtt =
    reportedRtt === null ? "origin" : `${reportedRtt.toFixed(1)} ms`;
  return `
    <div class="node-row" role="row">
      <span class="node-name" role="cell">
        <i class="${node.online ? "online" : "offline"}" aria-hidden="true"></i>
        ${escapeHtml(node.name)}
      </span>
      <span class="dim" role="cell">${escapeHtml(node.os)}</span>
      <span role="cell">v${escapeHtml(node.version)}</span>
      <span class="dim" role="cell">${escapeHtml(node.relay_region)}</span>
      <span role="cell">${rtt}</span>
    </div>
  `;
}

function renderNotFound(): void {
  document.title = "not found — dialtone.earth";
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

function showLoadError(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown error";
  container.querySelector(".loading-row")?.remove();
  container.insertAdjacentHTML(
    "beforeend",
    `<div class="error-row">REGISTRY UNAVAILABLE // ${escapeHtml(message)}</div>`,
  );
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
  const response = await fetch(path, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

function renderSnapshotTimes(snapshot: NetworkSnapshot): string {
  const times = [
    snapshot.telemetry_generated_at
      ? ["TELEMETRY", snapshot.telemetry_generated_at]
      : null,
    snapshot.coordinates_generated_at
      ? ["LOCATION", snapshot.coordinates_generated_at]
      : ["SNAPSHOT", snapshot.generated_at],
  ].filter(
    (value): value is [string, string] => value !== null,
  );
  return times
    .filter(([, value]) => Number.isFinite(Date.parse(value)))
    .map(
      ([label, value]) =>
        `<span>${label} <time datetime="${escapeHtml(value)}">${formatDate(value).toUpperCase()}</time></span>`,
    )
    .join("");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
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
