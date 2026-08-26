export function assertDangerousActionAllowed(settings: Record<string, unknown>): void {
  if (settings.allowDangerousActions === true) return;
  throw new Error(
    'Disruptive router actions are disabled. Enable them in the device settings first.',
  );
}
