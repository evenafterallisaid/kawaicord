export type StoredWindowState = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  maximized?: boolean;
};

export type WorkArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type RestoredWindowState = {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
};

const intersects = (bounds: WorkArea, workArea: WorkArea) => (
  bounds.x < workArea.x + workArea.width &&
  bounds.x + bounds.width > workArea.x &&
  bounds.y < workArea.y + workArea.height &&
  bounds.y + bounds.height > workArea.y
);

export function restoreWindowState(
  stored: StoredWindowState,
  workAreas: WorkArea[],
  defaults = { width: 1280, height: 720 },
  minimums = { width: 800, height: 600 }
): RestoredWindowState {
  const width = Number.isFinite(stored.width) && Number(stored.width) >= minimums.width
    ? Math.round(Number(stored.width))
    : defaults.width;
  const height = Number.isFinite(stored.height) && Number(stored.height) >= minimums.height
    ? Math.round(Number(stored.height))
    : defaults.height;
  const hasPosition = Number.isFinite(stored.x) && Number.isFinite(stored.y);
  const candidate = {
    x: Math.round(Number(stored.x)),
    y: Math.round(Number(stored.y)),
    width,
    height
  };
  const isVisible = hasPosition && workAreas.some(workArea => intersects(candidate, workArea));

  return {
    width,
    height,
    ...(isVisible ? { x: candidate.x, y: candidate.y } : {}),
    maximized: stored.maximized === true
  };
}
