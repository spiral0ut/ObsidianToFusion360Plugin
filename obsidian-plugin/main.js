const { Plugin, Notice, PluginSettingTab, Setting } = require('obsidian');

function normalizeSpaces(s) {
  // Replace a wide range of Unicode space separators with normal spaces
  return s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

function stripComment(s) {
  const hash = s.indexOf('#');
  if (hash >= 0) return s.slice(0, hash);
  return s;
}

function parseBlock(src) {
  src = normalizeSpaces(src);
  const lines = src.split(/\r?\n/);
  let part = null;
  let units = null;
  const params = {};
  let inParams = false;

  for (let raw of lines) {
    let line = stripComment(raw).replace(/\t/g, '    ').trimEnd();
    // skip empty (after trimming regular and unicode spaces on both sides for check)
    if (normalizeSpaces(line).trim().length === 0) continue;

    if (!inParams) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = normalizeSpaces(line.slice(0, idx)).trim();
      const val = normalizeSpaces(line.slice(idx + 1)).trim();
      if (key === 'params') {
        inParams = true;
        continue;
      } else if (key === 'part') {
        part = val.replace(/^["']|["']$/g, '');
      } else if (key === 'units') {
        units = val.replace(/^["']|["']$/g, '');
      }
    } else {
      // inside params: split on first colon
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const name = normalizeSpaces(line.slice(0, idx)).trim();
      const val = normalizeSpaces(line.slice(idx + 1)).trim();
      if (!name) continue;
      params[name] = val.replace(/^["']|["']$/g, '');
    }
  }

  if (!part) throw new Error("Missing 'part'");
  return { part, units, params };
}

function toJson(parsed, fallbackUnit) {
  const defaultUnit = parsed.units || fallbackUnit || "";
  const out = { design: parsed.part, defaultUnit, parameters: [] };
  for (const [name, raw0] of Object.entries(parsed.params)) {
    const raw = String(raw0);
    if (raw === '') continue;
    const asNum = Number(raw);
    if (!Number.isNaN(asNum)) {
      out.parameters.push({ name, value: asNum, unit: defaultUnit });
      continue;
    }
    // match "12 mm" or "12mm" or "12.5 in" or "35deg"
    const mUnit = raw.match(/^([0-9.+\-/* ()]+)\s*([a-zA-Z]+)$/);
    if (mUnit) {
      const num = Number(mUnit[1].trim());
      const unit = mUnit[2].trim();
      if (!Number.isNaN(num)) {
        out.parameters.push({ name, value: num, unit });
        continue;
      }
    }
    out.parameters.push({ name, expression: raw });
  }
  return out;
}

class FusionParamsSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Output folder')
      .setDesc('Where to write JSON files (relative to vault root).')
      .addText(t => t
        .setPlaceholder('Params')
        .setValue(this.plugin.settings.outputFolder)
        .onChange(async (value) => {
          this.plugin.settings.outputFolder = value || "Params";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Default unit')
      .setDesc('Used when a numeric value has no explicit unit (e.g., mm).')
      .addText(t => t
        .setPlaceholder('mm')
        .setValue(this.plugin.settings.defaultUnit)
        .onChange(async (value) => {
          this.plugin.settings.defaultUnit = value || "mm";
          await this.plugin.saveSettings();
        }));
  }
}

module.exports = class FusionParamsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, { outputFolder: "Params", defaultUnit: "mm" }, await this.loadData());

    this.registerMarkdownCodeBlockProcessor('fusion-params', async (src, el, ctx) => {
      try {
        const parsed = parseBlock(src);
        const json = toJson(parsed, this.settings.defaultUnit);
        const outPath = `${this.settings.outputFolder}/${json.design}.json`;
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        await this.app.vault.adapter.write(outPath, JSON.stringify(json, null, 2));
        el.createEl('pre', { text: `Exported ${json.parameters.length} Fusion param(s) → ${outPath}` });
        new Notice(`Exported ${json.parameters.length} param(s): ${outPath}`);
      } catch (e) {
        console.error(e);
        new Notice(`Failed to export fusion-params: ${e.message || e}`);
      }
    });

    this.addCommand({
      id: 'export-fusion-params-from-file',
      name: 'Export Fusion Params from Current File',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (!checking) this.exportFromFile(file);
        return true;
      }
    });

    this.addSettingTab(new FusionParamsSettingTab(this.app, this));
  }

  async exportFromFile(file) {
    const content = await this.app.vault.read(file);
    const re = /```fusion-params([\s\S]*?)```/g;
    const blocks = Array.from(content.matchAll(re));
    if (!blocks.length) {
      new Notice("No ```fusion-params code blocks found in this file.");
      return;
    }
    let total = 0;
    for (const m of blocks) {
      const src = m[1];
      try {
        const parsed = parseBlock(src);
        const json = toJson(parsed, this.settings.defaultUnit);
        const outPath = `${this.settings.outputFolder}/${json.design}.json`;
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        await this.app.vault.adapter.write(outPath, JSON.stringify(json, null, 2));
        total += json.parameters.length;
      } catch (e) {
        new Notice(`Failed to export one block: ${e.message || e}`);
      }
    }
    new Notice(`Exported ${total} parameter(s) across fusion-params block(s).`);
  }

  async onunload() {}

  async saveSettings() {
    await this.saveData(this.settings);
  }
};