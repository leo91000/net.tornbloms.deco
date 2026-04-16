'use strict';

/**
 * Widget API backend for the Network Throughput widget.
 *
 * GET /stats
 *   Returns aggregate download speed, upload speed, and connected client count
 *   across all paired Deco devices, plus a per-node breakdown.
 */
module.exports = {
  async getStats({ homey }) {
    const driver = homey.drivers.getDriver('tplink_deco');
    const devices = driver.getDevices();

    let totalDown = 0;
    let totalUp = 0;
    let totalClients = 0;
    const nodes = [];

    for (const device of devices) {
      const down = device.getCapabilityValue('measure_down_kilo_bytes_per_second') || 0;
      const up = device.getCapabilityValue('measure_up_kilo_bytes_per_second') || 0;
      const clients = device.getCapabilityValue('connected_clients') || 0;
      const role = device.getCapabilityValue('device_role') || '';

      totalDown += down;
      totalUp += up;
      totalClients += clients;

      nodes.push({
        name: device.getName(),
        role,
        down,
        up,
        clients,
      });
    }

    // Sort master first, then satellites
    nodes.sort((a, b) => {
      if (a.role === 'master' && b.role !== 'master') return -1;
      if (b.role === 'master' && a.role !== 'master') return 1;
      return a.name.localeCompare(b.name);
    });

    return { totalDown, totalUp, totalClients, nodes };
  },
};
