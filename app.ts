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
    this.homeyLog = new Log({ homey: this.homey });
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} started...`,
    );
  }

  async onUninit() {
    this.log(
      `${this.homey.manifest.id} - ${this.homey.manifest.version} has been uninitialised`,
    );
  }
}

module.exports = TplinkDecoApp;
