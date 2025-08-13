import { App, MarkdownPostProcessorContext, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import * as yaml from 'js-yaml';

interface FusionParamsSettings {
  outputFolder: string;   // relative to vault root, e.g., "Params"
  defaultUnit: string;    // e.g., "mm"
}

const DEFAULT_SETTINGS: FusionParamsSettings = {
  outputFolder: "Params",
  defaultUnit: "mm",
};

type ParamItem =
  | { name: string; value: number; unit?: string; comment?: string }
  | { name: string; expression: string; comment?: string };

interface ParsedBlock {
  part: string;
  units?: string;
  params: Array<any>;
}

function normalizeParams(parsed: any, fallbackUnit: string): { design: string; defaultUnit: string; parameters: ParamItem[] } {
  if (!parsed || !parsed.params || !parsed.part) throw new Error("Missing 'part' or 'params' in fusion-params block.");
  const defaultUnit = parsed.units || fallbackUnit || "";
  const parameters: ParamItem[] = [];

  for (const [key, val] of Object.entries(parsed.params)) {
    if (typeof val === 'string') {
      const trimmed = val.trim();
      const numeric = Number(trimmed);
      if (!isNaN(numeric)) {
        parameters.push({ name: key, value: numeric, unit: defaultUnit });
      } else {
        const m = trimmed.match(/^([0-9.+-/* ()]+)\s+([a-zA-Z]+)$/);
        if (m) {
          const value = m[1].trim();
          const unit = m[2].trim();
          const numValue = Number(value);
          if (!isNaN(numValue)) {
            parameters.push({ name: key, value: numValue, unit });
          } else {
            parameters.push({ name: key, expression: trimmed });
          }
        } else {
          parameters.push({ name: key, expression: trimmed });
        }
      }
    } else if (typeof val === 'number') {
      parameters.push({ name: key, value: val, unit: defaultUnit });
    } else if (typeof val === 'object' && val !== null) {
      const name = key;
      if ('expression' in val) {
        parameters.push({ name, expression: String((val as any).expression), comment: (val as any).comment });
      } else if ('value' in val) {
        parameters.push({ name, value: Number((val as any).value), unit: (val as any).unit || defaultUnit, comment: (val as any).comment });
      }
    } else {
      new Notice(`Skipping param '${key}': unsupported value`);
    }
  }

  return {
    design: parsed.part,
    defaultUnit,
    parameters
  };
}

export default class FusionParamsPlugin extends Plugin {
  settings: FusionParamsSettings;

  async onload() {
    await this.loadSettings();

    this.registerMarkdownCodeBlockProcessor('fusion-params', async (src, el, ctx) => {
      try {
        const parsed = yaml.load(src) as ParsedBlock;
        const json = normalizeParams(parsed, this.settings.defaultUnit);
        const outPath = `${this.settings.outputFolder}/${json.design}.json`;
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        await this.app.vault.adapter.write(outPath, JSON.stringify(json, null, 2));
        el.createEl('pre', { text: `Exported Fusion params → ${outPath}` });
        new Notice(`Fusion params exported: ${outPath}`);
      } catch (e:any) {
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

  async exportFromFile(file: TFile) {
    const content = await this.app.vault.read(file);
    const codeBlocks = Array.from(content.matchAll(/```fusion-params([\s\S]*?)```/g));
    if (codeBlocks.length === 0) {
      new Notice("No ```fusion-params code blocks found in this file.");
      return;
    }
    let count = 0;
    for (const m of codeBlocks) {
      const src = m[1];
      try {
        const parsed = yaml.load(src) as ParsedBlock;
        const json = normalizeParams(parsed, this.settings.defaultUnit);
        const outPath = `${this.settings.outputFolder}/${json.design}.json`;
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        await this.app.vault.adapter.write(outPath, JSON.stringify(json, null, 2));
        count++;
      } catch (e:any) {
        new Notice(`Failed to export one block: ${e.message || e}`);
      }
    }
    new Notice(`Exported ${count} Fusion param file(s).`);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class FusionParamsSettingTab extends PluginSettingTab {
  plugin: FusionParamsPlugin;

  constructor(app: App, plugin: FusionParamsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
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