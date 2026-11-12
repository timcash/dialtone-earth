const HOLD_MS = 1_800;
const MOVE_MS = 2_200;
export const TOUR_STOP_MS = HOLD_MS + MOVE_MS;

export function shouldAnimateTour(state: {
  hidden: boolean;
  inView: boolean;
  reducedMotion: boolean;
  paused: boolean;
  stopCount: number;
}): boolean {
  const { hidden, inView, reducedMotion, paused, stopCount } = state;
  return !hidden && inView && !reducedMotion && !paused && stopCount > 1;
}

export function sampleTour(elapsed: number, stopCount: number) {
  const from = Math.floor(elapsed / TOUR_STOP_MS) % stopCount;
  const to = (from + 1) % stopCount;
  const fraction = Math.max(0, (elapsed % TOUR_STOP_MS - HOLD_MS) / MOVE_MS);
  const progress = fraction * fraction * (3 - 2 * fraction);
  return { from, to, progress };
}
