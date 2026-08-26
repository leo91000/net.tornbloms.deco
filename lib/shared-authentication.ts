export class SharedAuthenticationCoordinator {
  private inFlight = new Map<string, Promise<boolean>>();

  async authenticate(
    key: string,
    isAuthenticated: () => boolean,
    authenticate: () => Promise<boolean>,
    force = false,
  ): Promise<boolean> {
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    if (!force && isAuthenticated()) return true;

    const request = authenticate().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, request);
    return request;
  }
}
