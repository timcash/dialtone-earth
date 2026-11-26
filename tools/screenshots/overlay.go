package main

import (
	"encoding/json"
	"fmt"
)

// MatchedRegion records the viewport coordinates of a highlighted DOM element.
type MatchedRegion struct {
	Selector string  `json:"selector"`
	Label    string  `json:"label"`
	Color    string  `json:"color"`
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Width    float64 `json:"width"`
	Height   float64 `json:"height"`
}

// OverlayResult reports what the injected overlay script matched or skipped.
type OverlayResult struct {
	Matched      []MatchedRegion `json:"matched"`
	Missed       []string        `json:"missed"`
	OverlayDrawn bool            `json:"overlay_drawn"`
}

// BuildClearOverlayScript returns JS that cleanly removes any injected overlay nodes.
func BuildClearOverlayScript() string {
	return `(() => {
		const prev = document.getElementById("dt-screenshot-overlay-root");
		if (prev) prev.remove();
		return true;
	})()`
}

type overlayPayload struct {
	TestName string         `json:"test_name"`
	Title    string         `json:"title"`
	Status   string         `json:"status"`
	Regions  []RegionTarget `json:"regions"`
}

// BuildInjectOverlayScript builds self-contained JS to highlight declared DOM
// regions. When regions is empty (or none of the selectors resolve to a visible
// element), no overlay nodes are inserted into the DOM.
func BuildInjectOverlayScript(testName, title, status string, regions []RegionTarget) (string, error) {
	if len(regions) == 0 {
		return `(() => {
			const prev = document.getElementById("dt-screenshot-overlay-root");
			if (prev) prev.remove();
			return { matched: [], missed: [], overlay_drawn: false };
		})()`, nil
	}
	raw, err := json.Marshal(overlayPayload{
		TestName: testName,
		Title:    title,
		Status:   status,
		Regions:  regions,
	})
	if err != nil {
		return "", fmt.Errorf("marshal overlay payload: %w", err)
	}

	script := fmt.Sprintf(`(() => {
		const cfg = %s;
		const prev = document.getElementById("dt-screenshot-overlay-root");
		if (prev) prev.remove();

		const regions = Array.isArray(cfg.regions) ? cfg.regions : [];
		if (regions.length === 0) {
			return { matched: [], missed: [], overlay_drawn: false };
		}

		// Scroll primary marked target into view before measuring coordinates.
		for (const r of regions) {
			if (r && r.scroll_into_view && r.selector) {
				try {
					const el = document.querySelector(r.selector);
					if (el && typeof el.scrollIntoView === "function") {
						el.scrollIntoView({ behavior: "instant", block: "center", inline: "nearest" });
					}
				} catch (_) {
					// ignore invalid selector
				}
			}
		}

		const vw = window.innerWidth || document.documentElement.clientWidth || 1440;
		const vh = window.innerHeight || document.documentElement.clientHeight || 900;
		const palette = ["#38bdf8", "#2fd065", "#f1c84b", "#a78bfa", "#fb7185"];
		const matched = [];
		const missed = [];

		regions.forEach((r, idx) => {
			if (!r || !r.selector) return;
			let el = null;
			try {
				el = document.querySelector(r.selector);
			} catch (_) {
				missed.push(r.selector);
				return;
			}
			if (!el) {
				missed.push(r.selector);
				return;
			}
			const rect = el.getBoundingClientRect();
			if (!rect || rect.width <= 1 || rect.height <= 1) {
				missed.push(r.selector);
				return;
			}
			let left = rect.left;
			let top = rect.top;
			let right = rect.right;
			let bottom = rect.bottom;
			let ancestor = el.parentElement;
			while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
				const st = getComputedStyle(ancestor);
				const clipX = st.overflowX === "hidden" || st.overflowX === "auto" || st.overflowX === "scroll" || st.overflowX === "clip";
				const clipY = st.overflowY === "hidden" || st.overflowY === "auto" || st.overflowY === "scroll" || st.overflowY === "clip";
				if (clipX || clipY) {
					const ar = ancestor.getBoundingClientRect();
					if (clipX) {
						left = Math.max(left, ar.left);
						right = Math.min(right, ar.right);
					}
					if (clipY) {
						top = Math.max(top, ar.top);
						bottom = Math.min(bottom, ar.bottom);
					}
				}
				ancestor = ancestor.parentElement;
			}
			const x = Math.max(2, Math.min(vw - 4, left));
			const y = Math.max(2, Math.min(vh - 4, top));
			const clampedRight = Math.max(x + 2, Math.min(vw - 2, right));
			const clampedBottom = Math.max(y + 2, Math.min(vh - 2, bottom));
			const w = clampedRight - x;
			const h = clampedBottom - y;
			if (w <= 4 || h <= 4) {
				missed.push(r.selector);
				return;
			}
			matched.push({
				selector: r.selector,
				label: r.label || r.selector,
				color: r.color || palette[idx %% palette.length],
				x: Math.round(x),
				y: Math.round(y),
				width: Math.round(w),
				height: Math.round(h),
			});
		});

		if (matched.length === 0) {
			return { matched: [], missed, overlay_drawn: false };
		}

		const root = document.createElement("div");
		root.id = "dt-screenshot-overlay-root";
		Object.assign(root.style, {
			position: "fixed",
			inset: "0",
			pointerEvents: "none",
			zIndex: "2147483647",
			fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
		});

		matched.forEach((m, idx) => {
			const box = document.createElement("div");
			Object.assign(box.style, {
				position: "fixed",
				left: m.x + "px",
				top: m.y + "px",
				width: m.width + "px",
				height: m.height + "px",
				border: "3px solid " + m.color,
				background: m.color + "1f",
				boxShadow: "0 0 0 1px rgba(0, 0, 0, 0.85), inset 0 0 0 1px rgba(0, 0, 0, 0.45)",
				boxSizing: "border-box",
			});

			const tag = document.createElement("div");
			const placeInside = m.y < 26;
			tag.textContent = (idx + 1) + ". " + m.label;
			Object.assign(tag.style, {
				position: "absolute",
				left: "-3px",
				top: placeInside ? "0px" : "-22px",
				background: m.color,
				color: "#050505",
				fontSize: "11px",
				fontWeight: "700",
				letterSpacing: "0.04em",
				lineHeight: "1",
				padding: "4px 7px",
				whiteSpace: "nowrap",
				boxShadow: "0 2px 6px rgba(0,0,0,0.6)",
			});
			box.appendChild(tag);
			root.appendChild(box);
		});

		const statusColors = {
			pass: "#2fd065",
			fail: "#ef4136",
			skip: "#f1c84b",
			running: "#38bdf8",
			pending: "#9ca3af",
		};
		const st = String(cfg.status || "pending").toLowerCase();
		const stColor = statusColors[st] || "#d4d4d4";

		const badge = document.createElement("div");
		Object.assign(badge.style, {
			position: "fixed",
			right: "14px",
			top: "10px",
			background: "rgba(8, 8, 8, 0.92)",
			border: "1px solid " + stColor,
			color: "#f5f5f5",
			padding: "6px 10px",
			fontSize: "11px",
			lineHeight: "1.35",
			maxWidth: "460px",
			boxShadow: "0 4px 16px rgba(0, 0, 0, 0.7)",
		});
		const line1 = document.createElement("div");
		line1.style.fontWeight = "700";
		line1.style.color = stColor;
		line1.textContent = "[" + st.toUpperCase() + "] " + (cfg.test_name || "");
		const line2 = document.createElement("div");
		line2.style.color = "#d4d4d4";
		line2.textContent = matched.length + " UI region(s) highlighted";
		badge.appendChild(line1);
		badge.appendChild(line2);
		root.appendChild(badge);

		document.documentElement.appendChild(root);
		return { matched, missed, overlay_drawn: true };
	})()`, string(raw))

	return script, nil
}
