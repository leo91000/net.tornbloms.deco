export function assertDangerousActionAllowed(settings: Record<string, unknown>): void {
  if (settings.allowDangerousActions === true) return;
  throw new Error(
    'Router reboot is disabled. Enable dangerous actions in the device settings first.',
  );
}
