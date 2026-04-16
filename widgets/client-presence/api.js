'use strict';

/**
 * Widget API backend for the Client Presence widget.
 *
 * GET /status?mac=AA:BB:CC:DD:EE:FF
 *   Returns presence info for a specific client MAC across all Deco devices.
 *
 * GET /clients
 *   Returns all clients seen in the last 30 days (from trackedClients on every
 *   paired Deco device), sorted online-first then by lastSeen descending.
 *   Used by the widget setup screen so the user can identify the MAC to enter.
 */
module.exports = {
  /**
   * Returns presence data for a single client identified by MAC address.
   * Searches trackedClients across all paired Deco device instances.
   */
  async getStatus({ homey, query }) {
    const rawMac = (query.mac || '').trim();
    if (!rawMac) {
      return { found: false, error: 'No MAC provided' };
    }
    const macUpper = rawMac.toUpperCase();

    const driver = homey.drivers.getDriver('tplink_deco');
    const devices = driver.getDevices();

    // Build a map of Deco-node MAC → friendly device name for resolving access_host.
    const decoNames = {};
    for (const device of devices) {
      const id = (device.getData().id || '').toUpperCase();
      if (id) decoNames[id] = device.getName();
    }

    for (const device of devices) {
      const tracked = device.trackedClients || {};
      // trackedClients is keyed by MAC — try both upper and original case.
      const client =
        tracked[macUpper] ||
        tracked[rawMac] ||
        tracked[rawMac.toLowerCase()] ||
        null;

      if (client) {
        return {
          found: true,
          name: client.name || rawMac,
          mac: client.mac,
          ip: client.ip || '',
          online: client.online === true,
          lastSeen: client.lastSeen || 0,
          firstSeen: client.firstSeen || 0,
          deco_node: decoNames[(client.access_host || '').toUpperCase()] || client.access_host || '',
        };
      }
    }

    return { found: false, mac: rawMac };
  },

  /**
   * Returns a merged, sorted list of all tracked clients across all Deco devices.
   * Online clients first, then sorted by lastSeen descending. Capped at 100.
   */
  async getClients({ homey }) {
    const driver = homey.drivers.getDriver('tplink_deco');
    const devices = driver.getDevices();

    const decoNames = {};
    for (const device of devices) {
      const id = (device.getData().id || '').toUpperCase();
      if (id) decoNames[id] = device.getName();
    }

    // Merge all trackedClients across devices; last-writer wins on collision.
    const merged = {};
    for (const device of devices) {
      const tracked = device.trackedClients || {};
      for (const [mac, client] of Object.entries(tracked)) {
        const existing = merged[mac.toUpperCase()];
        if (!existing || client.lastSeen > existing.lastSeen) {
          merged[mac.toUpperCase()] = {
            mac: client.mac,
            name: client.name || client.mac,
            ip: client.ip || '',
            online: client.online === true,
            lastSeen: client.lastSeen || 0,
            deco_node: decoNames[(client.access_host || '').toUpperCase()] || '',
          };
        }
      }
    }

    return Object.values(merged)
      .sort((a, b) => {
        if (a.online !== b.online) return a.online ? -1 : 1;
        return b.lastSeen - a.lastSeen;
      })
      .slice(0, 100);
  },
};
