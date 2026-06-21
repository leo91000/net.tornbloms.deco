'use strict';

// Deco routers use self-signed TLS certificates on their HTTPS admin interface.
// This app exclusively connects to local-network devices so certificate
// verification is intentionally disabled for the entire process.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

import Homey from 'homey';
import decoapiwrapper from './lib/client';
const { Log } = require('homey-log');
const HomeyLog = require('homey-betterstack');

// Start debuger
if (process.env.DEBUG === '1') {
  require('inspector').open(9229, '0.0.0.0');
}

class TplinkDecoApp extends HomeyLog {
  private api: decoapiwrapper | null = null;
  homeyLog: any;
  debugEnabled: boolean = this.homey.settings.get('debugenabled') || false;
  async onInit(): Promise<void> {
    // homey-log's underlying Raven client defaults sendTimeout to 1 second
    // (raven-node lib/client.js: `this.sendTimeout = options.sendTimeout || 1`),
    // which is too tight for a home-network device reaching Sentry's ingest
    // endpoint — DNS + TLS handshake + POST routinely exceeds 1s, causing every
    // report to fail with ETIMEDOUT/socket hang up and never reach Sentry.
    this.homeyLog = new Log({ homey: this.homey, options: { sendTimeout: 15 } });
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started...`,
    );
  }

  /**
   * Sends a non-fatal issue to Sentry (via homey-log), for failures that are caught
   * and logged locally but would otherwise never leave the device's own log.
   * `homey-log` dedupes by exact message string, so a stable, templated message
   * (no per-call timestamps/random ids) reports a given failure once per app run
   * instead of flooding Sentry on every poll cycle.
   */
  reportIssue(message: string, extra?: Record<string, any>): void {
    if (!this.homeyLog) return;
    if (extra) {
      this.homeyLog.setExtra(extra);
    }
    this.homeyLog.captureMessage(message).catch((e: any) => this.error('reportIssue: failed to send to Sentry', e));
  }

  async onUninit() {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} has been uninitialised`,
    );
  }
}

module.exports = TplinkDecoApp;
