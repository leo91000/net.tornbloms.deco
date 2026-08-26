export const MIN_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_POLL_INTERVAL_SECONDS = 30;
export const MAX_POLL_INTERVAL_SECONDS = 3600;

export function normalizePollIntervalSeconds(
  value: unknown,
  fallback = DEFAULT_POLL_INTERVAL_SECONDS,
): number {
  const numericValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numericValue)) return fallback;
  return Math.min(
    MAX_POLL_INTERVAL_SECONDS,
    Math.max(MIN_POLL_INTERVAL_SECONDS, Math.round(numericValue)),
  );
}

export type SingleFlightResult<T> =
  | { started: false }
  | { started: true; value: T };

export class SingleFlightTask {
  private inFlight = false;

  async run<T>(task: () => Promise<T>): Promise<SingleFlightResult<T>> {
    if (this.inFlight) return { started: false };

    this.inFlight = true;
    try {
      return { started: true, value: await task() };
    } finally {
      this.inFlight = false;
    }
  }
}

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export async function tryApiCall<T>(
  apiMethod: () => Promise<T>,
  onError: (error: unknown) => void,
): Promise<T | null> {
  try {
    return await apiMethod();
  } catch (error) {
    onError(error);
    return null;
  }
}
