import "./hud.css";
import type {
  NetworkIndex,
  NetworkIndexEntry,
  NetworkNode,
  NetworkSnapshot,
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
  document.title = "dialtone.earth — network registry";
  app.innerHTML = `
    <main class="hud-shell registry-page">
      <div class="scene-shade" aria-hidden="true"></div>
      <section class="terminal-overlay registry-terminal" aria-labelledby="registry-title">
        <a class="hud-brand" href="/">dialtone // earth</a>
        <div class="hud-title-row">
          <h1 id="registry-title">DIALTONE NETWORK REGISTRY</h1>
          <span id="registry-count">00 NETWORKS</span>
        </div>
        <p class="hud-caption">PUBLIC MESH SNAPSHOTS // SELECT NETWORK</p>
        <div class="registry-table" role="table" aria-label="Dialtone networks">
          <div class="registry-row registry-row-header" role="row">
            <span role="columnheader">NETWORK</span>
            <span role="columnheader">STATUS</span>
            <span role="columnheader">NODES</span>
            <span role="columnheader">ONLINE</span>
            <span role="columnheader">RELEASE</span>
            <span role="columnheader">UPDATED</span>
          </div>
          <div class="loading-row" role="status">LOADING REGISTRY...</div>
        </div>
      </section>
      <section class="tour-cc-bar" aria-label="Registry help">
        <p class="cc-channel"><span class="dim">CH:</span> REGISTRY <span class="focus">READY</span></p>
        <p class="cc-body">Choose a network row to open its H3 globe and node telemetry.</p>
      </section>
    </main>
  `;

  const list = app.querySelector<HTMLElement>(".registry-table");
  if (!list) return;

  try {
    const index = await fetchJson<NetworkIndex>("/networks/index.json");
    const headingCount = app.querySelector("#registry-count");
    if (headingCount) {
      headingCount.textContent = `${String(index.networks.length).padStart(2, "0")} NETWORKS`;
    }
    const loading = list.querySelector(".loading-row");
    loading?.remove();
    index.networks.forEach((network) => {
      list.append(createNetworkRow(network));
    });
  } catch (error) {
    showLoadError(list, error);
  }
}

function createNetworkRow(network: NetworkIndexEntry): HTMLAnchorElement {
  const row = document.createElement("a");
  row.className = "registry-row registry-network-row";
  row.href = `/n/${network.slug}`;
  row.setAttribute("role", "row");
  row.innerHTML = `
    <span class="registry-name" role="cell"><i aria-hidden="true"></i>${escapeHtml(network.name)}</span>
    <span role="cell">${network.online_count > 0 ? "ACTIVE" : "OFFLINE"}</span>
    <span role="cell">${network.node_count}</span>
    <span role="cell">${network.online_count}/${network.node_count}</span>
    <span role="cell">${escapeHtml(network.latest_release)}</span>
    <time role="cell" datetime="${network.generated_at}" title="${formatDate(network.generated_at)}">
      ${formatRelativeTime(network.generated_at)}
    </time>
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
          <div class="node-table" role="table" aria-label="Metal nodes">
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
            <time datetime="${snapshot.generated_at}">SNAPSHOT ${formatDate(snapshot.generated_at).toUpperCase()}</time>
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
  const rtt =
    node.rtt_ms_from_grok_bot_metal === null
      ? "origin"
      : `${node.rtt_ms_from_grok_bot_metal.toFixed(1)} ms`;
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
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
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

function formatRelativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const [unit, divisor] =
    units.find(([, unitSeconds]) => Math.abs(seconds) >= unitSeconds) ??
    (["second", 1] as const);
  return formatter.format(Math.round(seconds / divisor), unit);
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
