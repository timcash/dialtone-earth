# Plugin: www

> **Agent Note**: Use `./dialtone.sh www` on macOS/Linux and `.\dialtone.ps1 www` on Windows to interact with this plugin.

![Dialtone WWW Summary](screenshots/summary.png)

Live website at [dialtone.earth](https://dialtone.earth).

## Agent Guide: Working with WWW

This plugin manages the Dialtone public website, a high-performance Three.js application built with Vite and TypeScript. It uses a "snap-slide" architecture where each section is a lazy-loaded Three.js component.

### 1. Development Workflows

#### Launching Demos (Preferred for Agents)
Demos orchestrate a local dev server and a Chrome instance locked to a specific section with GPU acceleration and console log forwarding.

```powershell
# Windows
.\dialtone.ps1 www vision demo
.\dialtone.ps1 www earth demo
.\dialtone.ps1 www music demo
.\dialtone.ps1 www radio demo
.\dialtone.ps1 www cad demo
```

```bash
# macOS/Linux
./dialtone.sh www vision demo
./dialtone.sh www earth demo
# ... etc
```

#### Standard Vite Workflow
```powershell
.\dialtone.ps1 www dev      # Start dev server
.\dialtone.ps1 www build    # Production build
.\dialtone.ps1 www publish  # Test, build, and deploy the registry Worker
```

The live `dialtone.earth` site is the standalone app in `registry/`. Pushes to
`main` that touch `registry/**` automatically test, build, and deploy the
`dialtone-earth` Cloudflare Worker through
`.github/workflows/deploy-registry.yml`.

### 2. Architecture & Components

The application core is located in `app/src/`.

- **Main Entry**: `app/src/main.ts` handles section registration and global event listeners (scroll, swipe, hash changes).
- **Section Manager**: `app/src/components/util/section.ts` manages lazy loading and pauses/resumes animations based on visibility to save resources.
- **Menu System**: `app/src/components/util/menu.ts` provides a unified UI for sliders and buttons.
- **Styles**: `app/style.css` contains global layout, snap-scroll logic, and marketing overlay animations.

#### Creating a New Section
1. Create a folder in `app/src/components/<name>/`.
2. Implement a `mount<Name>(container: HTMLElement)` function that returns a `VisualizationControl`.
3. Register the section in `app/src/main.ts`.
4. Add a `<section id="s-<name>">` block in `app/index.html`.

### 3. Verification & Testing

#### Smoke Test
Always run a smoke test before publishing. It captures screenshots and performance metrics (FPS, GPU/CPU time) for every section.

```powershell
.\dialtone.ps1 www smoke
```

Reports are generated at `src/plugins/www/SMOKE.md`.

#### Chrome Lifecycle & Process Management (CRITICAL)
Due to the high-performance nature of the Three.js visualizations, the Chrome instances used for testing and demos consume significant system resources (GPU/Memory).

- **The Leak Problem**: Improperly managed `chromedp` contexts can result in "Zombie" Chrome processes that persist even after the test script finishes. This is especially prevalent in WSL 2 environments.
- **Mitigation**:
    - **Single Tab Architecture**: Smoke tests are designed to use a **single shared headless tab** for the entire suite. Never initialize a new `chromedp` context inside a loop.
    - **Pre-Test Cleanup**: The smoke suite automatically runs `browser.KillDialtoneChromeProcesses()` before starting to ensure a clean slate.
    - **Manual Cleanup**: If you notice system slowdown or hundreds of Chrome processes in `top`/`Task Manager`, run:
      ```bash
      ./dialtone.sh chrome kill all
      ```
- **Lifecycle Verification**: Run the lifecycle test to verify that Dialtone is correctly reaping its browsers:
  ```bash
  ./dialtone.sh www smoke-chrome
  ```

### 4. Specialized Tooling

#### Earth Land Layer (H3)
The Earth section uses precomputed H3 hexagonal grids. To regenerate from GeoJSON:
```bash
cd src/plugins/www/app
node scripts/build_land_h3.cjs 3
```

## Cloudflare Workers deployment

The GitHub repository must define these Actions secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

For a manual deployment from the repository root, export the same variables
and run `./dialtone.sh www publish`. The command installs the locked registry
dependencies, runs its tests and build, then runs `pnpm exec wrangler deploy`
from `registry/`.

# Log

## 2026-02-16
- **Consolidated Smoke Suite**: Unified performance and menu tests into a single pass using a shared headless tab for maximum efficiency.
- **Chrome Lifecycle Hardening**: Fixed WSL process tree leakage and implemented strict session management via the `chrome` plugin.
- **Async Loading Lifecycle**: Optimized all 11 sections to settle within 5 seconds using non-blocking background asset initialization.
- **Policy Mobile Polish**: Improved framing (16.5z camera), implemented compact white-grey histogram, and integrated simulation count into typography overlay.
- **New Tooling**: Added `www smoke-chrome` command to verify browser reaping.
- **Architectural Cleanup**: Decoupled WWW tests from the global test registry to ensure leak-free execution.

## 2026-02-13
- Added `vision` component with real-time 3D pose estimation.
- Integrated `tinygesture` for mobile swipe navigation.
- Moved marketing text to top-left and menu to bottom-right.
- Added `www vision demo` CLI command.

## 2026-02-07
- Fixed cloud transparency/renderOrder bug in Earth section.

## 2026-02-06
- Migrated to unified `Menu` utility in `util/menu.ts`.
