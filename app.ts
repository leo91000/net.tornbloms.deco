'use strict';

import { redactSensitiveData } from './lib/redaction';
const HomeyLog = require('homey-betterstack');

// Start the inspector only when the Homey runner has not already enabled it.
if (process.env.DEBUG === '1') {
  const inspector = require('inspector');
  if (!inspector.url()) {
    inspector.open(9229, '0.0.0.0');
  }
}

class TplinkDecoApp extends HomeyLog {
  private reportedIssues = new Set<string>();

  async onInit(): Promise<void> {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started on ${process.version}...`,
    );
  }

  /**
   * Sends a non-fatal issue through the configured Better Stack logger. Stable
   * messages are deduplicated per app run to avoid flooding remote diagnostics.
   */
  reportIssue(message: string, extra?: Record<string, any>): void {
    if (this.reportedIssues.has(message)) return;
    this.reportedIssues.add(message);
    this.warn(message, extra ? redactSensitiveData(extra) : undefined);
  }

  async onUninit() {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} has been uninitialised`,
    );
  }
}

module.exports = TplinkDecoApp;
