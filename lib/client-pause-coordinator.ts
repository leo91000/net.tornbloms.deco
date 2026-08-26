import {
  normalizeClientMac,
  normalizePauseDurationMinutes,
} from './advanced-controls';

export interface PausedClient {
  restoreAt: number;
}

export type PausedClients = Record<string, PausedClient>;

export interface ClientPauseGateway {
  ensureConnected(): Promise<boolean>;
  setClientAccess(mac: string, allowed: boolean): Promise<void>;
  persist(pausedClients: PausedClients): Promise<void>;
  clearPersistence(): Promise<void>;
  refresh(): Promise<void>;
}

export interface ClientPauseEffects {
  restored(mac: string): void;
  retrying(mac: string, error: unknown): void;
  rollbackFailed(mac: string, error: unknown): void;
  removalRestoreFailed(mac: string, error: unknown): void;
}

export interface ClientPauseScheduler {
  now(): number;
  schedule(task: () => void, delayMs: number): unknown;
  cancel(timer: unknown): void;
}

interface ClientPauseOptions {
  retryDelayMs?: number;
  scheduler?: ClientPauseScheduler;
}

const DEFAULT_RETRY_DELAY_MS = 60_000;
const defaultScheduler: ClientPauseScheduler = {
  now: () => Date.now(),
  schedule: (task, delayMs) => setTimeout(task, delayMs),
  cancel: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Owns the complete lifecycle of temporary client-access pauses. */
export class ClientPauseCoordinator {
  private readonly retryDelayMs: number;
  private readonly scheduler: ClientPauseScheduler;
  private readonly timers = new Map<string, unknown>();
  private pausedClients: PausedClients = {};

  constructor(
    private readonly gateway: ClientPauseGateway,
    private readonly effects: ClientPauseEffects,
    options: ClientPauseOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  async restore(persisted: PausedClients): Promise<void> {
    this.stopTimers();
    this.pausedClients = {};
    for (const [rawMac, pause] of Object.entries(persisted)) {
      if (!Number.isFinite(pause?.restoreAt)) continue;
      try {
        const mac = normalizeClientMac(rawMac);
        this.pausedClients[mac] = { restoreAt: pause.restoreAt };
        this.scheduleRestore(mac, pause.restoreAt);
      } catch {
        // Ignore malformed legacy state and replace persistence below.
      }
    }
    await this.persist();
  }

  async pause(mac: string, durationMinutes: unknown): Promise<void> {
    const normalizedMac = normalizeClientMac(mac);
    const duration = normalizePauseDurationMinutes(durationMinutes);
    await this.requireConnection();
    await this.gateway.setClientAccess(normalizedMac, false);
    const wasAlreadyPaused = Object.hasOwn(this.pausedClients, normalizedMac);
    const restoreAt = this.scheduler.now() + duration * 60_000;
    const nextState = {
      ...this.pausedClients,
      [normalizedMac]: { restoreAt },
    };
    try {
      await this.gateway.persist(nextState);
    } catch (error) {
      if (!wasAlreadyPaused) {
        await this.gateway.setClientAccess(normalizedMac, true)
          .catch((rollbackError) => this.effects.rollbackFailed(normalizedMac, rollbackError));
      }
      throw error;
    }
    this.pausedClients = nextState;
    this.scheduleRestore(normalizedMac, restoreAt);
  }

  async cancel(mac: string): Promise<void> {
    const normalizedMac = normalizeClientMac(mac);
    if (!Object.hasOwn(this.pausedClients, normalizedMac)) return;
    const nextState = { ...this.pausedClients };
    delete nextState[normalizedMac];
    await this.gateway.persist(nextState);
    this.pausedClients = nextState;
    this.cancelTimer(normalizedMac);
  }

  async shutdownAndRestore(): Promise<void> {
    this.stopTimers();
    const macs = Object.keys(this.pausedClients);
    if (macs.length > 0 && await this.gateway.ensureConnected()) {
      for (const mac of macs) {
        await this.gateway.setClientAccess(mac, true)
          .catch((error) => this.effects.removalRestoreFailed(mac, error));
      }
    }
    this.pausedClients = {};
    await this.gateway.clearPersistence();
  }

  private scheduleRestore(mac: string, restoreAt: number, delayMs?: number): void {
    this.cancelTimer(mac);
    const delay = delayMs ?? Math.max(0, restoreAt - this.scheduler.now());
    const timer = this.scheduler.schedule(() => {
      this.timers.delete(mac);
      void this.restoreClient(mac);
    }, delay);
    this.timers.set(mac, timer);
  }

  private async restoreClient(mac: string): Promise<void> {
    try {
      await this.requireConnection();
      await this.gateway.setClientAccess(mac, true);
      delete this.pausedClients[mac];
      await this.persist();
      this.effects.restored(mac);
      await this.gateway.refresh();
    } catch (error) {
      if (!Object.hasOwn(this.pausedClients, mac)) return;
      this.effects.retrying(mac, error);
      this.scheduleRestore(mac, this.pausedClients[mac].restoreAt, this.retryDelayMs);
    }
  }

  private async requireConnection(): Promise<void> {
    if (await this.gateway.ensureConnected()) return;
    throw new Error('Could not authenticate with the Deco.');
  }

  private persist(): Promise<void> {
    return this.gateway.persist({ ...this.pausedClients });
  }

  private cancelTimer(mac: string): void {
    const timer = this.timers.get(mac);
    if (timer !== undefined) this.scheduler.cancel(timer);
    this.timers.delete(mac);
  }

  private stopTimers(): void {
    for (const timer of this.timers.values()) this.scheduler.cancel(timer);
    this.timers.clear();
  }
}
