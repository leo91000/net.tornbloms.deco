export const CADENCE_SETTING_KEYS = [
  'performancePollMinutes',
  'networkFeaturePollMinutes',
  'speedTestStatusPollMinutes',
  'firmwarePollHours',
] as const;

export interface DecoPollCadence {
  performanceMs: number;
  networkFeaturesMs: number;
  speedTestStatusMs: number;
  firmwareMs: number;
}

const MIN_MINUTES = 1;
const MAX_MINUTES = 24 * 60;
const MIN_FIRMWARE_HOURS = 1;
const MAX_FIRMWARE_HOURS = 7 * 24;

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function resolvePollCadence(settings: Record<string, unknown>): DecoPollCadence {
  const performanceMinutes = clampNumber(
    settings.performancePollMinutes,
    5,
    MIN_MINUTES,
    MAX_MINUTES,
  );
  const networkFeatureMinutes = clampNumber(
    settings.networkFeaturePollMinutes,
    5,
    MIN_MINUTES,
    MAX_MINUTES,
  );
  const speedTestMinutes = clampNumber(
    settings.speedTestStatusPollMinutes,
    15,
    MIN_MINUTES,
    MAX_MINUTES,
  );
  const firmwareHours = clampNumber(
    settings.firmwarePollHours,
    6,
    MIN_FIRMWARE_HOURS,
    MAX_FIRMWARE_HOURS,
  );

  return {
    performanceMs: performanceMinutes * 60_000,
    networkFeaturesMs: networkFeatureMinutes * 60_000,
    speedTestStatusMs: speedTestMinutes * 60_000,
    firmwareMs: firmwareHours * 60 * 60_000,
  };
}
