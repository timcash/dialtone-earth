import { buildQueryDrivenGlobeLayers } from "./h3-geodata";
import { mountOverviewGlobe } from "./overview-globe";
import { createDefaultQuerySet } from "./query-workspace";
import { SIMULATED_NETWORKS } from "./simulation";

async function bootAuthGlobe(): Promise<void> {
  const stage = document.getElementById("auth-globe-stage");
  if (!stage) return;
  try {
    const queries = createDefaultQuerySet(SIMULATED_NETWORKS);
    const layers = buildQueryDrivenGlobeLayers(
      SIMULATED_NETWORKS,
      queries,
      "",
      true,
    );
    await mountOverviewGlobe(stage, layers, { autoSpin: true });
  } catch {
    // WebGL unavailable — sign-in form remains fully usable over dark canvas.
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void bootAuthGlobe();
  });
} else {
  void bootAuthGlobe();
}
