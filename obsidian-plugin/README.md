# Fusion 360 Params Sync (No-Build) — v0.4.0

Turn ```fusion-params``` code blocks into an interactive table that keeps a Fusion 360 parameter JSON file in sync with your note. The plugin now preserves per-parameter comments, validates input inline, previews tolerances across common units, and can import Fusion-generated JSON directly into the current note.

## Installation
1. Copy **fusion-params-sync** to `<YourVault>/.obsidian/plugins/fusion-params-sync/`.
2. Restart Obsidian and enable the plugin from *Settings → Community Plugins*.

## Everyday workflow
### Exporting parameters to Fusion
1. Use the **Insert Fusion Params template** command (command palette or editor context menu) to create a starter block.
2. Edit the rendered table: names, numeric values or expressions, optional units, and comments (use `#` in the code block if editing raw Markdown).
3. Watch the status banner above the table for write results. The plugin automatically creates missing folders, detects when multiple notes target the same JSON file, and writes updates only when the payload changes.
4. Click **Copy CSV** for a quick spreadsheet-friendly snapshot.

### Importing parameters from Fusion
1. Export parameters from the Fusion add-in to a JSON file inside your vault.
2. Place your cursor in (or where you want) a `fusion-params` block and run **Import Fusion Params from JSON**.
3. Pick the file in the modal. The plugin normalizes units/expressions, fills in missing defaults, and inserts or replaces the block at the cursor location with the parsed parameters and comments.

## Table features
- **Comment column** keeps notes alongside each parameter and synchronizes them with the exported JSON.
- **Inline validation** highlights invalid parameter names, expressions, units, or empty values before they reach Fusion.
- **Tolerance tools** (optional) convert between mm, cm, m, in, and ft, showing either the final value or an equation with rounding control.
- **CSV export** mirrors the rendered table (including tolerance results) for spreadsheets.

## Settings overview
- **Output folder**: vault-relative destination for generated JSON.
- **Default unit**: applied to numeric values lacking an explicit unit.
- **Always notify**: push status text to a Notice popup.
- **Sort parameters A→Z** and **Show units column**: tailor the table layout.
- **Tolerance options**: enable the toolbar, default tolerance value/unit, display style, and rounding precision.

The plugin stores settings automatically; use Obsidian’s command palette to discover all available actions.
