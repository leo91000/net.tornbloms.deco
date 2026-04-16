# Add a new Homey dashboard widget

Use this skill when the user asks to add a new widget to the TP-Link Deco app.

## Widget file structure

Every widget lives in `widgets/<widget-id>/`:

```
widgets/<widget-id>/
├── widget.compose.json   ← name, height, api endpoints, settings
├── api.js                ← backend handlers (CommonJS, accesses homey instance)
└── public/
    └── index.html        ← widget UI (HTML/CSS/JS, uses Homey.api() and Homey.getSettings())
```

## Checklist

1. **Plan the widget**: what data does it show, what settings does the user configure, what height?
2. **Create `widget.compose.json`**: define `name` (multilingual), `height` (px), `api` endpoints, `settings` array.
3. **Create `api.js`**: export one function per API endpoint. Access devices via:
   ```js
   const driver = homey.drivers.getDriver('tplink_deco');
   const devices = driver.getDevices();
   // device.trackedClients — Record<MAC, TrackedClient> (30-day history)
   // device.getCapabilityValue('capability_name')
   // device.getData().id — device MAC
   // device.getName() — display name
   ```
4. **Create `public/index.html`**: call `Homey.ready()` after first render. Use `Homey.setHeight(px)` to set height. Poll with `setInterval`. Call `Homey.getSettings()` for per-instance config.
5. **Bump version** in `.homeycompose/app.json` and `app.json`.
6. **Add changelog entry** in `.homeychangelog.json`.
7. **Update memory** at `~/.claude/projects/.../memory/project_widgets.md` to mark widget as built.

## Homey.api() call pattern (in index.html)
```js
const data = await Homey.api('GET', '/myEndpoint', { param: 'value' });
```

## CSS design tokens
Use `var(--homey-text-color)` for text. Provide `@media (prefers-color-scheme: dark/light)` fallbacks.
Font sizes: 32px (big numbers), 20px (names), 17px (body), 13–14px (secondary).
Standard padding: 16px body padding.

## Backlog (from architecture session, 2026-04-16)
- `mesh-status`: all nodes table, WAN IP, group state, signal, ~180px
- `node-health`: CPU/RAM gauges + WAN state for master, device picker setting, ~120px

See full plan: `~/.claude/projects/.../memory/project_widgets.md`
