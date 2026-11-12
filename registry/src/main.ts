import "./styles.css";
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
    <main class="registry-shell">
      <header class="site-header">
        <a class="wordmark" href="/" aria-label="dialtone.earth home">
          <span class="wordmark-mark" aria-hidden="true"></span>
          dialtone<span>.earth</span>
        </a>
        <p class="eyebrow">network registry / live snapshots</p>
      </header>
      <section class="registry-intro">
        <p class="kicker">dialtone networks</p>
        <h1>Find the signal.</h1>
        <p>
          A public registry of dialtone networks and the machines carrying
          them around the world.
        </p>
      </section>
      <section class="network-list" aria-labelledby="networks-title">
        <div class="section-heading">
          <h2 id="networks-title">Networks</h2>
          <span>01 registered</span>
        </div>
        <div class="loading-card" role="status">loading registry…</div>
      </section>
      <footer class="site-footer">
        <span>dialtone.earth</span>
        <span>registry / 2026</span>
      </footer>
    </main>
  `;

  const list = app.querySelector<HTMLElement>(".network-list");
  if (!list) return;

  try {
    const index = await fetchJson<NetworkIndex>("/networks/index.json");
    const headingCount = list.querySelector(".section-heading span");
    if (headingCount) {
      headingCount.textContent = `${String(index.networks.length).padStart(2, "0")} registered`;
    }
    const loading = list.querySelector(".loading-card");
    loading?.remove();
    index.networks.forEach((network) => {
      list.append(createNetworkCard(network));
    });
  } catch (error) {
    showLoadError(list, error);
  }
}

function createNetworkCard(network: NetworkIndexEntry): HTMLAnchorElement {
  const card = document.createElement("a");
  card.className = "network-card";
  card.href = `/n/${network.slug}`;
  card.innerHTML = `
    <div class="network-card-main">
      <div class="network-status">
        <span class="status-dot" aria-hidden="true"></span>
        <span>${network.online_count > 0 ? "operational" : "offline"}</span>
      </div>
      <h3>${escapeHtml(network.name)}</h3>
      <p>public mesh network</p>
    </div>
    <dl class="network-metrics">
      <div>
        <dt>nodes</dt>
        <dd>${network.node_count}</dd>
      </div>
      <div>
        <dt>online</dt>
        <dd>${network.online_count}<span>/${network.node_count}</span></dd>
      </div>
      <div>
        <dt>release</dt>
        <dd>${escapeHtml(network.latest_release)}</dd>
      </div>
      <div>
        <dt>updated</dt>
        <dd class="metric-time">
          <time datetime="${network.generated_at}" title="${formatDate(network.generated_at)}">
            ${formatRelativeTime(network.generated_at)}
          </time>
        </dd>
      </div>
    </dl>
    <span class="network-arrow" aria-hidden="true">↗</span>
  `;
  return card;
}

async function renderNetwork(slug: string): Promise<void> {
  app.innerHTML = `
    <main class="network-shell">
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
        <header class="network-header">
          <a class="wordmark compact" href="/">
            <span class="wordmark-mark" aria-hidden="true"></span>
            dialtone<span>.earth</span>
          </a>
          <a class="back-link" href="/">← all networks</a>
        </header>
        <aside class="stats-panel" aria-label="${escapeHtml(snapshot.network)} network status">
          <div class="panel-heading">
            <div>
              <p class="kicker">network / live snapshot</p>
              <h1>${escapeHtml(snapshot.network)}</h1>
            </div>
            <span class="live-chip"><i></i> live</span>
          </div>
          <dl class="summary-grid">
            <div>
              <dt>nodes</dt>
              <dd>${snapshot.node_count}</dd>
            </div>
            <div>
              <dt>online</dt>
              <dd>${onlineCount}<span>/${snapshot.node_count}</span></dd>
            </div>
            <div>
              <dt>release</dt>
              <dd>${escapeHtml(snapshot.latest_release)}</dd>
            </div>
          </dl>
          <div class="nodes-heading">
            <h2>Nodes</h2>
            <span>${onlineCount} reporting</span>
          </div>
          <div class="node-list">
            ${snapshot.nodes.map(renderNode).join("")}
          </div>
          <div class="snapshot-time">
            <span>snapshot</span>
            <time datetime="${snapshot.generated_at}">
              ${formatDate(snapshot.generated_at)}
            </time>
          </div>
        </aside>
        <div class="globe-hint" aria-hidden="true">
          <span></span> drag to orbit · scroll to zoom
        </div>
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
    <article class="node-row">
      <div class="node-identity">
        <span class="node-dot ${node.online ? "online" : "offline"}"></span>
        <div>
          <h3>${escapeHtml(node.name)}</h3>
          <p>${escapeHtml(node.os)}</p>
        </div>
      </div>
      <dl>
        <div>
          <dt>version</dt>
          <dd>v${escapeHtml(node.version)}</dd>
        </div>
        <div>
          <dt>relay</dt>
          <dd>${escapeHtml(node.relay_region)}</dd>
        </div>
        <div>
          <dt>rtt</dt>
          <dd>${rtt}</dd>
        </div>
      </dl>
    </article>
  `;
}

function renderNotFound(): void {
  document.title = "not found — dialtone.earth";
  app.innerHTML = `
    <main class="error-page">
      <a class="wordmark" href="/">
        <span class="wordmark-mark" aria-hidden="true"></span>
        dialtone<span>.earth</span>
      </a>
      <p class="kicker">404 / signal lost</p>
      <h1>Network not found.</h1>
      <a class="text-link" href="/">return to registry →</a>
    </main>
  `;
}

function showLoadError(container: HTMLElement, error: unknown): void {
  const message = error instanceof Error ? error.message : "unknown error";
  container.querySelector(".loading-card")?.remove();
  container.insertAdjacentHTML(
    "beforeend",
    `<div class="error-card">registry unavailable · ${escapeHtml(message)}</div>`,
  );
}

function showNetworkError(
  container: HTMLElement,
  slug: string,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : "unknown error";
  container.innerHTML = `
    <div class="network-error">
      <p class="kicker">network / ${escapeHtml(slug)}</p>
      <h1>Snapshot unavailable.</h1>
      <p>${escapeHtml(message)}</p>
      <a class="text-link" href="/">return to registry →</a>
    </div>
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
