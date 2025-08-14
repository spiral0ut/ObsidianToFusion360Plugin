
const { Plugin, Notice, PluginSettingTab, Setting, setIcon } = require('obsidian');

function normalizeSpaces(s) { return s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '); }
function stripComment(s) { const hash = s.indexOf('#'); return hash >= 0 ? s.slice(0, hash) : s; }
function hashString(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i); return (h >>> 0).toString(16); }
function joinVaultPath(folder, file) {
  folder = (folder || '').replace(/^[\/\\]+|[\/\\]+$/g, '');
  file = (file || '').replace(/^[\/\\]+/g, '');
  return folder ? `${folder}/${file}` : file;
}
const RECENT_WINDOW_MS = 4000;
const recentExports = new Map();

// --- parsing ---
function parseBlock(src) {
  src = normalizeSpaces(src);
  const lines = src.split(/\r?\n/);
  let part = null, units = null, inParams = false;
  const params = {};
  for (let raw of lines) {
    let line = stripComment(raw).replace(/\t/g, '    ').trimEnd();
    if (normalizeSpaces(line).trim().length === 0) continue;
    if (!inParams) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const key = normalizeSpaces(line.slice(0, idx)).trim();
      const val = normalizeSpaces(line.slice(idx + 1)).trim();
      if (key === 'params') { inParams = true; continue; }
      if (key === 'part') part = val.replace(/^["']|["']$/g, '');
      else if (key === 'units') units = val.replace(/^["']|["']$/g, '');
    } else {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      const name = normalizeSpaces(line.slice(0, idx)).trim();
      const val  = normalizeSpaces(line.slice(idx + 1)).trim();
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
    if (!Number.isNaN(asNum)) { out.parameters.push({ name, value: asNum, unit: defaultUnit, _explicitUnit: false, _raw: raw }); continue; }
    const mUnit = raw.match(/^([0-9.+\-/* ()]+)\s*([a-zA-Z]+)$/);
    if (mUnit) {
      const num = Number(mUnit[1].trim()), unit = mUnit[2].trim();
      if (!Number.isNaN(num)) { out.parameters.push({ name, value: num, unit, _explicitUnit: true, _raw: raw }); continue; }
    }
    out.parameters.push({ name, expression: raw, _raw: raw });
  }
  return out;
}
function fromJsonToBlock(json) {
  const lines = [];
  lines.push("```fusion-params");
  lines.push(`part: ${json.design}`);
  if (json.defaultUnit && json.defaultUnit.trim()) lines.push(`units: ${json.defaultUnit}`);
  lines.push("params:");
  for (const p of json.parameters) {
    if ('expression' in p) lines.push(`  ${p.name}: ${p.expression}`);
    else if (p.unit && p._explicitUnit) lines.push(`  ${p.name}: ${p.value} ${p.unit}`);
    else lines.push(`  ${p.name}: ${p.value}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// --- file IO ---
async function readSafe(adapter, path) { try { return await adapter.read(path); } catch { return null; } }
async function writeIfChanged(adapter, path, content) {
  const existing = await readSafe(adapter, path);
  if (existing && existing.trim() === content.trim()) return false;
  await adapter.write(path, content);
  return true;
}
function safeReplaceSection(fullText, lineStart, lineEnd, replacement) {
  const lines = fullText.split(/\r?\n/);
  const before = lines.slice(0, lineStart).join('\n');
  const after  = lines.slice(lineEnd + 1).join('\n');
  let glue1 = (before && !before.endsWith('\n')) ? '\n' : '';
  let glue2 = (!replacement.endsWith('\n')) ? '\n' : '';
  let glue3 = (after && !after.startsWith('\n')) ? '\n' : '';
  return `${before}${glue1}${replacement}${glue2}${glue3}${after}`;
}

// --- settings ---
class FusionParamsSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    new Setting(containerEl).setName('Output folder')
      .setDesc('Folder (relative to vault root) where JSON files are written, regardless of note location.')
      .addText(t=>t.setPlaceholder('Params').setValue(this.plugin.settings.outputFolder)
        .onChange(async v=>{ this.plugin.settings.outputFolder = (v||"Params"); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Default unit')
      .setDesc('Used when numeric value has no explicit unit (e.g., mm).')
      .addText(t=>t.setPlaceholder('mm').setValue(this.plugin.settings.defaultUnit)
        .onChange(async v=>{ this.plugin.settings.defaultUnit = v || "mm"; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Always notify')
      .setDesc('Show a popup for status messages. Default: off.')
      .addToggle(t=>t.setValue(this.plugin.settings.alwaysNotify)
        .onChange(async v=>{ this.plugin.settings.alwaysNotify=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Sort parameters A→Z')
      .setDesc('Order table by name.')
      .addToggle(t=>t.setValue(this.plugin.settings.sortAZ)
        .onChange(async v=>{ this.plugin.settings.sortAZ=v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Show units column')
      .setDesc('Include a separate Unit column in the table.')
      .addToggle(t=>t.setValue(this.plugin.settings.showUnits)
        .onChange(async v=>{ this.plugin.settings.showUnits=v; await this.plugin.saveSettings(); }));
  }
}

// --- styles ---
function injectStyles() {
  if (document.head.querySelector('style[data-fusion-params-style]')) return;
  const css = `
  .fusion-params-toolbar { display: flex; align-items: center; gap: .5rem; margin: .25rem 0 .25rem; }
  .fusion-params-toolbar .icon-btn { width: 26px; height: 26px; border: 1px solid var(--background-modifier-border);
    border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .fusion-params-toolbar .icon-btn:hover { background: var(--background-modifier-hover); }
  .fusion-params-status { margin-top: .25rem; font-size: .9em; opacity: .9; }
  .fusion-params-table-container { margin-top: .25rem; }
  .fusion-params-title { font-weight: 600; margin: .25rem 0 .5rem; }
  table.fusion-params-table { width: 100%; border-collapse: collapse; }
  table.fusion-params-table th, table.fusion-params-table td {
    border: 1px solid var(--background-modifier-border); padding: 6px 8px; vertical-align: middle;
  }
  table.fusion-params-table th { text-align: left; }
  table.fusion-params-table td input { width: 100%; box-sizing: border-box; }
  table.fusion-params-table td .row-action, 
  table.fusion-params-table td .row-action-left { opacity: 0; transition: opacity .15s ease; cursor: pointer; margin-left: .25rem; }
  table.fusion-params-table tr:hover td .row-action,
  table.fusion-params-table tr:hover td .row-action-left { opacity: .9; }
  .fusion-params-unit-placeholder { color: var(--text-muted); }
  `;
  const style = document.createElement('style');
  style.setAttribute('data-fusion-params-style', 'true');
  style.textContent = css; document.head.appendChild(style);
}

// --- table render ---
function makeSortedParams(json, sortAZ) {
  const arr = json.parameters.slice();
  if (sortAZ) arr.sort((a,b)=>a.name.localeCompare(b.name));
  return arr;
}
function renderTableEditable(el, json, { sortAZ, showUnits }, onCommit) {
  const params = makeSortedParams(json, sortAZ);

  // toolbar with + on left and CSV on right
  const toolbar = el.createEl('div', { cls: 'fusion-params-toolbar' });
  const addBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label':'Add parameter to end' } });
  setIcon(addBtn, 'plus');
  const spacer = toolbar.createEl('div', { style: 'flex:1' });
  const csvBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label':'Copy CSV' } });
  setIcon(csvBtn, 'clipboard');

  const container = el.createEl('div', { cls: 'fusion-params-table-container' });
  const title = container.createEl('div', { text: `Parameters for ${json.design} (${params.length})` });
  title.addClass('fusion-params-title');
  const table = container.createEl('table', { cls: 'fusion-params-table' });
  const thead = table.createEl('thead');
  const hdr = thead.createEl('tr');
  hdr.createEl('th', { text: '' }); // left-side insert
  hdr.createEl('th', { text: 'Name' });
  hdr.createEl('th', { text: 'Value / Expression' });
  if (showUnits) hdr.createEl('th', { text: 'Unit' });
  hdr.createEl('th', { text: '' }); // right-side actions
  const tbody = table.createEl('tbody');

  const commit = () => onCommit(readFromTable());

  function readFromTable() {
    const out = [];
    for (const tr of tbody.children) {
      const name = tr.querySelector('input[data-key="name"]').value.trim();
      const val  = tr.querySelector('input[data-key="value"]').value.trim();
      const unitEl = showUnits ? tr.querySelector('input[data-key="unit"]') : null;
      const unit = unitEl ? unitEl.value.trim() : '';
      if (!name || val === '') continue;
      const numOnly = /^[0-9.+\-/* ()]+$/.test(val) && !/[a-zA-Z]/.test(val);
      const asNum = Number(val);
      if (numOnly && !Number.isNaN(asNum)) {
        if (unit) out.push({ name, value: asNum, unit, _explicitUnit: true });
        else out.push({ name, value: asNum, _explicitUnit: false });
      } else {
        out.push({ name, expression: val });
      }
    }
    return out;
  }

  function isRowComplete(tr) {
    const name = tr.querySelector('input[data-key="name"]').value.trim();
    const val  = tr.querySelector('input[data-key="value"]').value.trim();
    return name !== '' && val !== ''; // unit optional
  }
  function isRowEmpty(tr) {
    const name = tr.querySelector('input[data-key="name"]').value.trim();
    const val  = tr.querySelector('input[data-key="value"]').value.trim();
    const unit = showUnits ? tr.querySelector('input[data-key="unit"]').value.trim() : '';
    return name === '' && val === '' && (!showUnits || unit === '');
  }

  function createRowElements(p) {
    const tr = document.createElement('tr');

    // left insert cell
    const tdIns = tr.createEl('td');
    const plusLeft = tdIns.createEl('span', { cls: 'row-action-left', attr: { 'aria-label':'Insert row below' } });
    setIcon(plusLeft, 'plus');

    // name / value / unit
    const tdName = tr.createEl('td'); const tdVal = tr.createEl('td');
    const nameInput = tdName.createEl('input', { type:'text', value: p?.name || '' });
    nameInput.setAttr('data-key','name');

    const valStr = (p && ('expression' in p)) ? p.expression : (p ? (p.value ?? '') : '');
    const valInput = tdVal.createEl('input', { type:'text', value: String(valStr) });
    valInput.setAttr('data-key','value');

    let unitInput = null;
    if (showUnits) {
      const tdUnit = tr.createEl('td');
      const showUnitText = (p && ('expression' in p)) ? '' : (p && p._explicitUnit ? (p.unit||'') : '');
      unitInput = tdUnit.createEl('input', { type:'text', value: showUnitText });
      unitInput.setAttr('data-key','unit');
      if (!(p && p._explicitUnit) && !(p && ('expression' in p))) {
        unitInput.setAttr('placeholder', `default (${json.defaultUnit||''})`);
        unitInput.addClass('fusion-params-unit-placeholder');
      }
    }

    // right actions
    const tdActions = tr.createEl('td');
    const okBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label':'Save row' } });
    setIcon(okBtn, 'check');
    const delBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label':'Delete row' } });
    setIcon(delBtn, 'trash');

    return { tr, nameInput, valInput, unitInput, okBtn, delBtn, plusLeft };
  }

  function insertRowAfter(refTr, p=null, focusName=true, ephemeral=true) {
    const { tr, nameInput, valInput, unitInput, okBtn, delBtn, plusLeft } = createRowElements(p);
    tr.setAttr('data-ephemeral', ephemeral ? '1' : '0');

    // handlers
    okBtn.addEventListener('click', () => { commit(); });
    delBtn.addEventListener('click', () => { tr.remove(); commit(); });
    plusLeft.addEventListener('click', () => {
      const newTr = insertRowAfter(tr, null, true, true);
      newTr.scrollIntoView({ block: 'nearest' });
    });

    const lastInput = (showUnits && unitInput) ? unitInput : valInput;
    for (const input of [nameInput, valInput, unitInput].filter(Boolean)) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          if (isRowComplete(tr)) {
            ev.preventDefault();
            commit(); // finalize this row
            const newTr = insertRowAfter(tr, null, true, true); // add a blank row *below*
            newTr.scrollIntoView({ block: 'nearest' });
          }
        } else if (ev.key === 'Tab') {
          if (ev.target === lastInput && isRowComplete(tr)) {
            setTimeout(()=>commit(), 0); // save only
          }
        }
      });
    }

    // remove ephemeral if left empty
    tr.addEventListener('focusout', () => {
      setTimeout(() => {
        if (tr.getAttr('data-ephemeral') === '1' && isRowEmpty(tr) && !tr.contains(document.activeElement)) {
          tr.remove();
        }
      }, 10);
    });

    // insert into DOM
    if (refTr && refTr.nextSibling) tbody.insertBefore(tr, refTr.nextSibling);
    else if (refTr && !refTr.nextSibling) tbody.appendChild(tr);
    else tbody.appendChild(tr);

    if (focusName) nameInput.focus();
    return tr;
  }

  // seed rows from JSON
  let lastTr = null;
  for (const p of params) lastTr = insertRowAfter(lastTr, p, false, false);

  // toolbar hooks
  addBtn.addEventListener('click', () => insertRowAfter(tbody.lastElementChild, null, true, true));
  csvBtn.addEventListener('click', async () => {
    const rows = [['Name','Value','Unit']];
    for (const tr of tbody.children) {
      const name = tr.querySelector('input[data-key="name"]').value;
      const val  = tr.querySelector('input[data-key="value"]').value;
      const unit = showUnits ? tr.querySelector('input[data-key="unit"]').value : '';
      rows.push([name,val,unit]);
    }
    const csv = rows.map(r => r.map(x => /[",\n]/.test(x) ? `"${x.replace(/"/g,'""')}"` : x).join(',')).join('\n');
    try { await navigator.clipboard.writeText(csv); new Notice('CSV copied'); } catch { new Notice('Copy failed'); }
  });
}

// --- plugin ---
module.exports = class FusionParamsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, {
      outputFolder: "Params",
      defaultUnit: "mm",
      alwaysNotify: false,
      sortAZ: true,
      showUnits: true
    }, await this.loadData());

    injectStyles();

    const insertTemplate = async (editor, view) => {
      const file = this.app.workspace.getActiveFile();
      const base = file ? (file.basename || 'Part') : 'Part';
      const tpl = [
        '```fusion-params',
        `part: ${base}`,
        `units: ${this.settings.defaultUnit}`,
        'params:',
        '  length: 100',
        '  width:  50',
        '  height: 25',
        '  hole_dia: 8 mm',
        '  angle_deg: 30deg',
        '```'
      ].join('\n');
      const pos = editor.getCursor();
      editor.replaceRange(tpl + '\n', pos);
    };
    this.addCommand({ id: 'insert-fusion-params-template', name: 'Insert Fusion Params template', editorCallback: insertTemplate });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      menu.addItem((item) => item.setTitle('Insert Fusion Params template').setIcon('plus').onClick(()=>insertTemplate(editor, view)));
    }));

    // Processor
    this.registerMarkdownCodeBlockProcessor('fusion-params', async (src, el, ctx) => {
      try {
        while (el.firstChild) el.removeChild(el.firstChild);

        const parsed = parseBlock(src);
        const json = toJson(parsed, this.settings.defaultUnit);

        // Write JSON (strip UI flags)
        const fileJson = {
          design: json.design,
          defaultUnit: json.defaultUnit,
          parameters: json.parameters.map(p => ('expression' in p) ? ({ name: p.name, expression: p.expression }) : ({ name: p.name, value: p.value, unit: p.unit }))
        };
        const outRelPath = joinVaultPath(this.settings.outputFolder, `${json.design}.json`);
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        const pretty = JSON.stringify(fileJson, null, 2);
        const changed = await writeIfChanged(this.app.vault.adapter, outRelPath, pretty);

        const status = el.createEl('div'); status.addClass('fusion-params-status');
        const now = Date.now();
        const recent = recentExports.get(outRelPath);
        let text = '';
        if (changed) {
          recentExports.set(outRelPath, { hash: hashString(pretty), t: now });
          text = `Updated → ${outRelPath}`;
          setTimeout(() => { status.setText(`No changes pending → ${outRelPath}`); }, 3000);
        } else if (recent && (now - recent.t) < 4000) {
          text = `Updated just now → ${outRelPath}`;
          setTimeout(() => { status.setText(`No changes pending → ${outRelPath}`); }, 2500);
        } else {
          text = `No changes pending → ${outRelPath}`;
        }
        status.setText(text);
        if (this.settings.alwaysNotify) new Notice(text);

        // Two-way writeback
        const section = ctx.getSectionInfo(el);
        const file = this.app.workspace.getActiveFile();
        const applyWriteback = async (newParams) => {
          if (!file || !section) return;
          const updatedJson = { ...json, parameters: newParams };
          const newBlock = fromJsonToBlock(updatedJson);
          const data = await this.app.vault.read(file);
          const next = safeReplaceSection(data, section.lineStart, section.lineEnd, newBlock);
          if (next.trim() === data.trim()) return;
          await this.app.vault.modify(file, next);
        };

        renderTableEditable(el, json, { sortAZ: this.settings.sortAZ, showUnits: this.settings.showUnits }, applyWriteback);

      } catch (e) {
        console.error(e);
        new Notice(`Failed to process fusion-params: ${e.message || e}`);
      }
    });

    this.addSettingTab(new FusionParamsSettingTab(this.app, this));
  }

  async onunload() {}
  async saveSettings() { await this.saveData(this.settings); }
};
