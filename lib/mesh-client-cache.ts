interface NodeSnapshot<T> {
  clients: T[];
  updatedAt: number;
}

export interface MeshClientSnapshot<T> {
  clients: T[];
  nodeCount: number;
}

export class MeshClientCache<T extends { mac?: string }> {
  private readonly hosts = new Map<string, Map<string, NodeSnapshot<T>>>();

  setNodeClients(
    hostname: string,
    nodeMac: string,
    clients: T[],
    updatedAt = Date.now(),
  ): void {
    if (!this.hosts.has(hostname)) {
      this.hosts.set(hostname, new Map());
    }
    this.hosts.get(hostname)!.set(nodeMac.toUpperCase(), { clients, updatedAt });
  }

  getSnapshot(
    hostname: string,
    maxAgeMs: number,
    now = Date.now(),
  ): MeshClientSnapshot<T> {
    const nodes = this.hosts.get(hostname);
    if (!nodes) return { clients: [], nodeCount: 0 };

    const clientsByMac = new Map<string, T>();
    let nodeCount = 0;
    for (const [nodeMac, snapshot] of nodes) {
      if (now - snapshot.updatedAt > maxAgeMs) {
        nodes.delete(nodeMac);
        continue;
      }
      nodeCount += 1;
      for (const client of snapshot.clients) {
        if (!client.mac) continue;
        clientsByMac.set(client.mac.toUpperCase(), client);
      }
    }

    if (nodes.size === 0) this.hosts.delete(hostname);
    return { clients: [...clientsByMac.values()], nodeCount };
  }
}
