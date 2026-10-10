# Publish As Private Plugin

Use this flow if you want to run the bridge plugin from the Figma web app on Linux.

## Why this works

- Figma web on Linux can run installed plugins in files.
- Private plugins can access `figma.fileKey` when `enablePrivatePluginApi` is enabled.
- This manifest already allows requests to the local bridge on:
  - `http://127.0.0.1:3847`
  - `http://localhost:3847`

That means the browser and the local bridge can live on the same Linux machine.

## Before publishing

Keep the local bridge running on Linux:

```bash
cd /home/k41c/Projects/c0d3Us/mcp-hub
FIGMA_WRITE_BRIDGE_HOST=127.0.0.1 npm run figma-write:bridge
```

If you want the plugin to be reachable from another machine instead of the same Linux host, change the manifest `allowedDomains` before publishing.

## Publish flow in Figma

1. Create a new plugin draft in Figma developer flow.
2. Replace the generated plugin files with:
   - `manifest.json`
   - `code.js`
   - `ui.html`
3. Publish the plugin with:
   - `Publish to`: your organization
   - visibility: private
4. Save/install the plugin to your own account.

## Runtime flow on Linux

1. Open Figma in the browser.
2. Open the Santomaz file.
3. Run the private plugin.
4. Run `Configure Bridge`.
5. Use:
   - `Bridge URL`: `http://127.0.0.1:3847`
   - `Bridge token`: leave empty unless you enabled one
   - `File key override`: leave empty unless `figma.fileKey` is unavailable
6. Run `Start Bridge Agent`.

## Expected verification

From the Linux host:

```bash
curl -s http://127.0.0.1:3847/health
```

You should see one active session after the plugin connects.

Then the local MCP hub can call:

- `dry_run`
- `batch_apply`

for the Santomaz file.

## Notes

- `localhost` here means the same Linux machine where the browser and bridge are running.
- If the plugin cannot read `figma.fileKey`, keep the plugin private and use `fileKeyOverride` as fallback.
- If Figma rejects local HTTP access in your org policy, you will need a small HTTPS reverse proxy on the same machine and update `allowedDomains` accordingly.
