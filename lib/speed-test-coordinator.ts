import type { SingleFlightResult } from './polling';
import type { SpeedTestSnapshot } from './deco-features';

const DEFAULT_POLL_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_ACTIVE_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_ACTIVE_POLLS = 60;
const UNSUPPORTED_CONFIRMATION_POLLS = 2;

export interface SpeedTestGateway {
  startSpeedTest(): Promise<void>;
  readSpeedTest(): Promise<SpeedTestSnapshot>;
}

export interface SpeedTestEffects {
  apply(snapshot: SpeedTestSnapshot): Promise<void>;
  completed(snapshot: SpeedTestSnapshot): Promise<void>;
  failed(error: unknown): void;
}

export interface SpeedTestScheduler {
  now(): number;
  schedule(task: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

type RunExclusive = (
  task: () => Promise<void>,
) => Promise<SingleFlightResult<void>>;

interface SpeedTestOptions {
  regularPollIntervalMs?: number;
  activePollIntervalMs?: number;
  maxActivePolls?: number;
  scheduler?: SpeedTestScheduler;
}

const defaultScheduler: SpeedTestScheduler = {
  now: () => Date.now(),
  schedule: (task, delayMs) => setTimeout(task, delayMs),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

function isActive(status: string): boolean {
  return !['idle', 'failed', 'error', 'unsupported'].includes(status.toLowerCase());
}

function runningSnapshot(previous: SpeedTestSnapshot | undefined): SpeedTestSnapshot {
  return {
    ...(previous ?? {
      supported: true,
      downMbps: 0,
      upMbps: 0,
      pingMs: 0,
      jitterMs: 0,
      lastRunAt: '',
    }),
    status: 'running',
  };
}

export class SpeedTestCoordinator {
  private readonly regularPollIntervalMs: number;
  private readonly activePollIntervalMs: number;
  private readonly maxActivePolls: number;
  private readonly scheduler: SpeedTestScheduler;
  private timer: unknown;
  private lastPollAt = 0;
  private lastSnapshot: SpeedTestSnapshot | undefined;
  private unsupportedPolls = 0;

  constructor(
    private readonly gateway: SpeedTestGateway,
    private readonly effects: SpeedTestEffects,
    private readonly runExclusive: RunExclusive,
    options: SpeedTestOptions = {},
  ) {
    this.regularPollIntervalMs = options.regularPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.activePollIntervalMs = options.activePollIntervalMs ?? DEFAULT_ACTIVE_POLL_INTERVAL_MS;
    this.maxActivePolls = options.maxActivePolls ?? DEFAULT_MAX_ACTIVE_POLLS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  async start(): Promise<void> {
    await this.gateway.startSpeedTest();
    this.lastPollAt = 0;
    const snapshot = runningSnapshot(this.lastSnapshot);
    this.lastSnapshot = snapshot;
    await this.effects.apply(snapshot);
    this.scheduleActivePoll(0);
  }

  async pollIfDue(force = false): Promise<boolean> {
    const now = this.scheduler.now();
    if (!force && now - this.lastPollAt < this.regularPollIntervalMs) return false;
    this.lastPollAt = now;
    const snapshot = await this.gateway.readSpeedTest();
    await this.observe(snapshot);
    if (snapshot.supported && isActive(snapshot.status)) this.scheduleActivePoll(0);
    return true;
  }

  resetPollSchedule(): void {
    this.lastPollAt = 0;
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.scheduler.cancel(this.timer);
    this.timer = undefined;
  }

  private async observe(snapshot: SpeedTestSnapshot): Promise<void> {
    if (!snapshot.supported) {
      this.unsupportedPolls += 1;
      if (this.unsupportedPolls < UNSUPPORTED_CONFIRMATION_POLLS) return;
    } else {
      this.unsupportedPolls = 0;
    }

    const completed = snapshot.supported
      && this.lastSnapshot !== undefined
      && this.lastSnapshot.status !== 'idle'
      && snapshot.status === 'idle'
      && Boolean(snapshot.lastRunAt);
    this.lastSnapshot = snapshot;
    await this.effects.apply(snapshot);
    if (completed) await this.effects.completed(snapshot);
  }

  private scheduleActivePoll(attempt: number): void {
    this.stop();
    if (attempt >= this.maxActivePolls) return;
    this.timer = this.scheduler.schedule(() => {
      this.timer = undefined;
      void this.pollActive(attempt);
    }, this.activePollIntervalMs);
  }

  private async pollActive(attempt: number): Promise<void> {
    try {
      let snapshot: SpeedTestSnapshot | undefined;
      const result = await this.runExclusive(async () => {
        snapshot = await this.gateway.readSpeedTest();
        this.lastPollAt = this.scheduler.now();
        await this.observe(snapshot);
      });
      if (!result.started || (snapshot?.supported && isActive(snapshot.status))) {
        this.scheduleActivePoll(attempt + 1);
      }
    } catch (error) {
      this.effects.failed(error);
      this.scheduleActivePoll(attempt + 1);
    }
  }
}
