import type {
  FirmwareUpdateSnapshot,
  RadioFeature,
  RadioFeatureSnapshot,
  SpeedTestSnapshot,
  WirelessSnapshot,
} from './deco-features';
import type { SingleFlightResult } from './polling';
import {
  SpeedTestCoordinator,
  SpeedTestEffects,
  SpeedTestGateway,
} from './speed-test-coordinator';

const UNSUPPORTED_CONFIRMATION_POLLS = 2;

interface MasterFeatureGateway extends SpeedTestGateway {
  readWireless(): Promise<WirelessSnapshot>;
  readRadioFeature(feature: RadioFeature): Promise<RadioFeatureSnapshot>;
  checkFirmwareUpdate(mac: string): Promise<FirmwareUpdateSnapshot>;
}

export interface MasterFeatureEffects {
  wireless(snapshot: WirelessSnapshot): Promise<void>;
  radio(feature: RadioFeature, snapshot: RadioFeatureSnapshot): Promise<void>;
  firmware(snapshot: FirmwareUpdateSnapshot): Promise<void>;
  speedTest: SpeedTestEffects;
  failed(feature: string, error: unknown): void;
}

type RunExclusive = (
  task: () => Promise<void>,
) => Promise<SingleFlightResult<void>>;

interface MasterFeatureOptions {
  now?: () => number;
  networkFeaturePollIntervalMs?: number;
  speedTestStatusPollIntervalMs?: number;
  firmwarePollIntervalMs?: number;
}

export class MasterFeatureCoordinator {
  private readonly speedTest: SpeedTestCoordinator;
  private readonly now: () => number;
  private readonly networkFeaturePollIntervalMs: number;
  private readonly firmwarePollIntervalMs: number;
  private lastWirelessPollAt = 0;
  private lastFirmwarePollAt = 0;
  private lastRadioPollAt = 0;
  private readonly unsupportedRadioPolls = new Map<RadioFeature, number>();

  constructor(
    private readonly gateway: MasterFeatureGateway,
    private readonly effects: MasterFeatureEffects,
    runExclusive: RunExclusive,
    options: MasterFeatureOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.networkFeaturePollIntervalMs = options.networkFeaturePollIntervalMs ?? 5 * 60_000;
    this.firmwarePollIntervalMs = options.firmwarePollIntervalMs ?? 6 * 60 * 60_000;
    this.speedTest = new SpeedTestCoordinator(
      gateway,
      effects.speedTest,
      runExclusive,
      { regularPollIntervalMs: options.speedTestStatusPollIntervalMs },
    );
  }

  async poll(deviceMac: string): Promise<void> {
    const now = this.now();
    if (now - this.lastWirelessPollAt >= this.networkFeaturePollIntervalMs) {
      this.lastWirelessPollAt = now;
      await this.pollWireless();
    }
    if (now - this.lastRadioPollAt >= this.networkFeaturePollIntervalMs) {
      this.lastRadioPollAt = now;
      await this.pollRadioFeatures();
    }
    try {
      await this.speedTest.pollIfDue();
    } catch (error) {
      this.effects.failed('speed test', error);
    }
    if (now - this.lastFirmwarePollAt >= this.firmwarePollIntervalMs) {
      this.lastFirmwarePollAt = now;
      await this.pollFirmware(deviceMac);
    }
  }

  startSpeedTest(): Promise<void> {
    return this.speedTest.start();
  }

  resetPollSchedule(): void {
    this.lastWirelessPollAt = 0;
    this.lastFirmwarePollAt = 0;
    this.lastRadioPollAt = 0;
    this.speedTest.resetPollSchedule();
  }

  stop(): void {
    this.speedTest.stop();
  }

  private async pollWireless(): Promise<void> {
    try {
      await this.effects.wireless(await this.gateway.readWireless());
    } catch (error) {
      this.effects.failed('wireless feature state', error);
    }
  }

  private async pollRadioFeatures(): Promise<void> {
    for (const feature of ['fastRoaming', 'beamforming'] as const) {
      try {
        const snapshot = await this.gateway.readRadioFeature(feature);
        if (!snapshot.supported) {
          const attempts = (this.unsupportedRadioPolls.get(feature) ?? 0) + 1;
          this.unsupportedRadioPolls.set(feature, attempts);
          if (attempts < UNSUPPORTED_CONFIRMATION_POLLS) continue;
        } else {
          this.unsupportedRadioPolls.delete(feature);
        }
        await this.effects.radio(feature, snapshot);
      } catch (error) {
        this.effects.failed(`${feature} state`, error);
      }
    }
  }

  private async pollFirmware(deviceMac: string): Promise<void> {
    try {
      await this.effects.firmware(await this.gateway.checkFirmwareUpdate(deviceMac));
    } catch (error) {
      this.effects.failed('firmware updates', error);
    }
  }
}
