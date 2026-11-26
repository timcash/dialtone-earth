package main

import (
	"fmt"
	"html"
	"strings"
)

// RenderGalleryHTML builds a self-contained dark-mode gallery index.html that
// links every overview and per-test annotated screenshot from the latest loop.
func RenderGalleryHTML(m *CaptureManifest) string {
	var overviewCards strings.Builder
	var testCards strings.Builder

	for _, shot := range m.Shots {
		if shot.Kind == "overview" {
			overviewCards.WriteString(renderShotCard(shot))
		} else {
			testCards.WriteString(renderShotCard(shot))
		}
	}

	commitMeta := "local"
	if m.GitBranch != "" || m.GitCommit != "" {
		commitMeta = strings.TrimSpace(m.GitBranch + " " + m.GitCommit)
	}
	stage := m.Pipeline.Stage
	if stage == "" {
		stage = "idle"
	}

	return fmt.Sprintf(`<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="color-scheme" content="dark" />
    <title>DIALTONE.EARTH // Test UI Screenshots (Latest Loop)</title>
    <style>
      *, *::before, *::after { box-sizing: border-box; }
      :root {
        --bg: #080808;
        --panel: #101010;
        --panel-hi: #161616;
        --line: #282828;
        --line-hi: #4a4a4a;
        --ink: #f2f2f2;
        --muted: #929292;
        --ok: #2fd065;
        --err: #ef4136;
        --warn: #f1c84b;
        --accent: #38bdf8;
      }
      html, body {
        margin: 0;
        min-height: 100%%;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        font-size: 13px;
        line-height: 1.45;
      }
      a { color: var(--accent); text-decoration: none; }
      a:hover { text-decoration: underline; }
      header.topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        background: #0c0c0c;
        border-bottom: 1px solid var(--line);
        padding: 12px 18px;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .brand {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 10px;
        font-weight: 700;
        letter-spacing: 0.05em;
      }
      .pill {
        display: inline-block;
        padding: 2px 7px;
        font-size: 11px;
        border: 1px solid var(--line-hi);
        color: var(--muted);
      }
      .pill.is-ok { color: var(--ok); border-color: rgba(47, 208, 101, 0.5); }
      .pill.is-err { color: var(--err); border-color: rgba(239, 65, 54, 0.55); }
      .pill.is-warn { color: var(--warn); border-color: rgba(241, 200, 75, 0.55); }
      .pill.is-accent { color: var(--accent); border-color: rgba(56, 189, 248, 0.55); }
      nav.nav { display: flex; flex-wrap: wrap; gap: 8px; }
      .chip {
        display: inline-flex;
        align-items: center;
        padding: 5px 10px;
        border: 1px solid var(--line-hi);
        background: #141414;
        color: var(--ink);
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .chip:hover { border-color: #fff; background: #1d1d1d; text-decoration: none; }
      .chip.is-active { background: #f2f2f2; color: #050505; border-color: #f2f2f2; font-weight: 700; }
      main { max-width: 1440px; margin: 0 auto; padding: 18px 18px 48px; }
      .summary {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
        gap: 10px;
        margin-bottom: 18px;
      }
      .stat-box {
        background: var(--panel);
        border: 1px solid var(--line);
        padding: 10px 12px;
      }
      .stat-k { font-size: 10px; letter-spacing: 0.08em; color: var(--muted); }
      .stat-v { font-size: 16px; font-weight: 700; margin-top: 2px; word-break: break-all; }
      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin: 14px 0 18px;
        padding-bottom: 10px;
        border-bottom: 1px solid var(--line);
      }
      .filters { display: flex; flex-wrap: wrap; gap: 6px; }
      h2.section-title {
        font-size: 13px;
        letter-spacing: 0.08em;
        color: var(--muted);
        margin: 22px 0 10px;
        text-transform: uppercase;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
        gap: 14px;
      }
      .card {
        background: var(--panel);
        border: 1px solid var(--line);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .card:hover { border-color: var(--line-hi); }
      .card-thumb {
        display: block;
        background: #050505;
        border-bottom: 1px solid var(--line);
        aspect-ratio: 16 / 10;
        overflow: hidden;
      }
      .card-thumb img {
        width: 100%%;
        height: 100%%;
        object-fit: cover;
        object-position: top left;
        display: block;
      }
      .card-body {
        padding: 10px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        flex: 1;
      }
      .card-head {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 8px;
      }
      .card-title { font-weight: 700; font-size: 13px; color: var(--ink); }
      .card-sub { font-size: 11px; color: var(--muted); word-break: break-word; }
      .card-desc { font-size: 11px; color: #cfcfcf; }
      .regions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
      .region-tag {
        font-size: 10px;
        padding: 2px 6px;
        border: 1px solid var(--line-hi);
        background: #141414;
        color: var(--ink);
      }
      .fallback-note {
        font-size: 11px;
        color: var(--muted);
        border-left: 2px solid var(--line-hi);
        padding-left: 8px;
      }
      .card-foot {
        margin-top: auto;
        padding-top: 8px;
        border-top: 1px solid #1d1d1d;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-size: 11px;
        color: var(--muted);
      }
      .card[hidden] { display: none; }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">
        <span>DIALTONE.EARTH // TEST UI SCREENSHOTS</span>
        <span class="pill is-accent">LATEST LOOP (OVERWRITES EACH RUN)</span>
        <span class="pill">LOOP %s</span>
      </div>
      <nav class="nav">
        <a class="chip" href="/">test dashboard</a>
        <a class="chip" href="/logs">logs</a>
        <a class="chip" href="manifest.json" target="_blank" rel="noreferrer">manifest.json</a>
      </nav>
    </header>
    <main>
      <section class="summary">
        <div class="stat-box">
          <div class="stat-k">GENERATED (UTC)</div>
          <div class="stat-v">%s</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">PIPELINE STAGE</div>
          <div class="stat-v">%s</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">TEST RESULTS</div>
          <div class="stat-v">%d pass / %d fail / %d skip</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">ANNOTATED COVERAGE</div>
          <div class="stat-v">%d annotated / %d clean fallback</div>
        </div>
        <div class="stat-box">
          <div class="stat-k">BRANCH / COMMIT</div>
          <div class="stat-v">%s</div>
        </div>
      </section>

      <div class="toolbar">
        <div class="filters" data-testid="gallery-filters">
          <button type="button" class="chip is-active" data-filter="all">All (%d)</button>
          <button type="button" class="chip" data-filter="annotated">Annotated (%d)</button>
          <button type="button" class="chip" data-filter="fallback">Clean Fallback (%d)</button>
          <button type="button" class="chip" data-filter="fail">Failed (%d)</button>
          <button type="button" class="chip" data-filter="pass">Passed (%d)</button>
        </div>
        <div class="card-sub">Stable link target: <code>%s</code></div>
      </div>

      <h2 class="section-title">Overview Pages (%d)</h2>
      <section class="grid" data-testid="overview-grid">
        %s
      </section>

      <h2 class="section-title">Per-Test Annotated Screenshots (%d)</h2>
      <section class="grid" data-testid="tests-grid">
        %s
      </section>
    </main>
    <script>
      (() => {
        const buttons = Array.from(document.querySelectorAll("[data-filter]"));
        const cards = Array.from(document.querySelectorAll("[data-shot-kind='test']"));
        buttons.forEach((btn) => {
          btn.addEventListener("click", () => {
            const mode = btn.getAttribute("data-filter") || "all";
            buttons.forEach((b) => b.classList.toggle("is-active", b === btn));
            cards.forEach((card) => {
              const ann = card.getAttribute("data-annotated") === "true";
              const st = card.getAttribute("data-status") || "";
              let show = true;
              if (mode === "annotated") show = ann;
              else if (mode === "fallback") show = !ann;
              else if (mode === "fail") show = st === "fail";
              else if (mode === "pass") show = st === "pass";
              card.hidden = !show;
            });
          });
        });
      })();
    </script>
  </body>
</html>
`,
		html.EscapeString(m.LoopID),
		html.EscapeString(m.GeneratedAt),
		html.EscapeString(strings.ToUpper(stage)),
		m.Passed, m.Failed, m.Skipped,
		m.AnnotatedShots, m.FallbackShots,
		html.EscapeString(commitMeta),
		m.TestShots, m.AnnotatedShots, m.FallbackShots, m.Failed, m.Passed,
		html.EscapeString(m.StableURL),
		m.OverviewShots,
		overviewCards.String(),
		m.TestShots,
		testCards.String(),
	)
}

func renderShotCard(shot ShotRecord) string {
	statusClass := ""
	switch strings.ToLower(shot.Status) {
	case "pass":
		statusClass = "is-ok"
	case "fail":
		statusClass = "is-err"
	case "skip":
		statusClass = "is-warn"
	}

	statusPill := ""
	if shot.Kind == "overview" {
		statusPill = `<span class="pill is-accent">OVERVIEW</span>`
	} else {
		label := strings.ToUpper(strings.TrimSpace(shot.Status))
		if label == "" {
			label = "PENDING"
		}
		statusPill = fmt.Sprintf(`<span class="pill %s">%s</span>`, statusClass, html.EscapeString(label))
	}

	var regionsHTML strings.Builder
	if shot.Annotated && len(shot.MatchedRegions) > 0 {
		regionsHTML.WriteString(`<div class="regions">`)
		for _, r := range shot.MatchedRegions {
			color := html.EscapeString(r.Color)
			regionsHTML.WriteString(fmt.Sprintf(
				`<span class="region-tag" style="border-color:%s" title="%s">%s</span>`,
				color, html.EscapeString(r.Selector), html.EscapeString(r.Label),
			))
		}
		regionsHTML.WriteString(`</div>`)
	} else if shot.Kind == "test" {
		reason := shot.FallbackReason
		if reason == "" {
			reason = "No UI region declared (clean capture, no overlay)"
		}
		regionsHTML.WriteString(fmt.Sprintf(
			`<div class="fallback-note">%s</div>`,
			html.EscapeString(reason),
		))
	}

	subLine := shot.PagePath
	if shot.TestName != "" {
		subLine = shot.TestName + " | " + shot.PagePath
	}

	logLink := ""
	if isHexTestID(shot.TestID) {
		logLink = fmt.Sprintf(` | <a href="/logs?test-id=%s">log</a>`, html.EscapeString(shot.TestID))
	}
	elapsedPart := ""
	if shot.Elapsed != "" && shot.Elapsed != "0" {
		elapsedPart = " | " + html.EscapeString(shot.Elapsed) + "s"
	}

	return fmt.Sprintf(`
        <article class="card" data-shot-kind="%s" data-annotated="%t" data-status="%s">
          <a class="card-thumb" href="%s" target="_blank" rel="noreferrer">
            <img src="%s" alt="%s" loading="lazy" />
          </a>
          <div class="card-body">
            <div class="card-head">
              <div class="card-title">%s</div>
              %s
            </div>
            <div class="card-sub">%s</div>
            <div class="card-desc">%s</div>
            %s
            <div class="card-foot">
              <span>%s%s</span>
              <span><a href="%s" target="_blank" rel="noreferrer">full png</a>%s</span>
            </div>
          </div>
        </article>`,
		html.EscapeString(shot.Kind),
		shot.Annotated,
		html.EscapeString(strings.ToLower(shot.Status)),
		html.EscapeString(shot.Filename),
		html.EscapeString(shot.Filename),
		html.EscapeString(shot.Title),
		html.EscapeString(shot.Title),
		statusPill,
		html.EscapeString(subLine),
		html.EscapeString(shot.Description),
		regionsHTML.String(),
		html.EscapeString(formatBytes(shot.Bytes)),
		elapsedPart,
		html.EscapeString(shot.Filename),
		logLink,
	)
}

func formatBytes(n int) string {
	if n >= 1024*1024 {
		return fmt.Sprintf("%.2f MB", float64(n)/(1024*1024))
	}
	if n >= 1024 {
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	}
	return fmt.Sprintf("%d B", n)
}
