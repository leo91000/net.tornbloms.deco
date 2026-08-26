# TP-Link Deco

Local TP-Link Deco integration for Homey.

It exposes mesh-node health, WAN state, connected clients, live throughput,
guest/IoT/MLO Wi-Fi controls, firmware status, client blocking, temporary
internet pauses, existing QoS-priority state, and backhaul diagnostics.

Disruptive actions require the explicit `allowDangerousActions` device setting.
TP-Link does not publish a stable local Deco API, so capabilities that only
exist in the mobile-app protocol are detected conservatively and are not
presented as working controls through the web API.
