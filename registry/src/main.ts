import "./hud.css";

const appElement = document.querySelector<HTMLDivElement>("#app");
if (!appElement) throw new Error("Missing app root");
const app: HTMLDivElement = appElement;

void renderRoute();

async function renderRoute(): Promise<void> {
  if (window.location.pathname !== "/") {
    renderNotFound();
    return;
  }

  await renderPublicLanding();
}

async function renderPublicLanding(): Promise<void> {
  document.title = "dialtone.earth";
  app.innerHTML = `
    <main class="hud-shell overview-page">
      <div class="globe-stage"></div>
      <div class="scene-shade" aria-hidden="true"></div>
      <section class="overview-overlay" aria-label="Dialtone Earth public landing">
        <a class="overview-wordmark" href="/">dialtone // earth</a>
        <div class="overview-table" role="status" aria-live="polite">
          <div class="overview-row overview-row-header">
            <span>ACCESS // SIGN-IN REQUIRED</span>
          </div>
          <div class="loading-row">
            Network telemetry, node metrics, and test runs are private and protected behind Cloudflare Access on authorized network hostnames.
          </div>
        </div>
      </section>
    </main>
  `;

  const stage = app.querySelector<HTMLElement>(".globe-stage");
  if (!stage) return;

  const { mountOverviewGlobe } = await import("./overview-globe");
  await mountOverviewGlobe(stage, [], () => {});
}

function renderNotFound(): void {
  document.title = "404 — dialtone.earth";
  app.innerHTML = `
    <main class="hud-shell error-page">
      <section class="terminal-overlay">
        <a class="hud-brand" href="/">dialtone // earth</a>
        <h1>404 // NOT FOUND</h1>
        <a class="text-link" href="/">[ ESC ] RETURN TO DIALTONE.EARTH</a>
      </section>
    </main>
  `;
}
