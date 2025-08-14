
const { Plugin, Notice, PluginSettingTab, Setting, setIcon } = require('obsidian');

// ---------- helpers ----------
function normalizeSpaces(s) { return s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '); }
function stripComment(s) { const hash = s.indexOf('#'); return hash >= 0 ? s.slice(0, hash) : s; }
function hashString(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i); return (h >>> 0).toString(16); }
function joinVaultPath(folder, file) {
  folder = (folder || '').replace(/^[\/\\]+|[\/\\]+$/g, '');
  file = (file || '').replace(/^[\/\\]+/g, '');
  return folder ? `${folder}/${file}` : file;
}
const recentExports = new Map();

function toMM(val, unit) {
  if (!unit || unit === 'mm') return val;
  if (unit === 'in') return val * 25.4;
  return val; // unknown -> pass-through
}
function fromMM(valMM, unit) {
  if (!unit || unit === 'mm') return valMM;
  if (unit === 'in') return valMM / 25.4;
  return valMM; // unknown -> pass-through
}
function convert(val, fromUnit, toUnit) {
  return fromMM(toMM(val, fromUnit), toUnit);
}
function roundTo(val, places) {
  const p = Math.max(0, Math.min(10, Number(places)||0));
  const m = Math.pow(10, p);
  return Math.round(val * m) / m;
}

// ---------- parsing ----------
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

// ---------- file IO ----------
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

// ---------- settings tab ----------
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

    containerEl.createEl('h3', { text: 'Tolerance (optional)' });

    new Setting(containerEl).setName('Enable tolerance UI')
      .setDesc('Adds a per-row checkbox, global tolerance input, and a computed “With tolerance” column.')
      .addToggle(t=>t.setValue(this.plugin.settings.enableTolerance)
        .onChange(async v=>{ this.plugin.settings.enableTolerance=v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Default tolerance')
      .setDesc('Used if no tolerance is set above the table.')
      .addText(t=>t.setPlaceholder('0.2').setValue(String(this.plugin.settings.defaultToleranceValue))
        .onChange(async v=>{ const n = Number(v); this.plugin.settings.defaultToleranceValue = Number.isFinite(n)?n:0; await this.plugin.saveSettings(); }))
      .addDropdown(dd=>dd.addOption('mm','mm').addOption('in','in')
        .setValue(this.plugin.settings.defaultToleranceUnit)
        .onChange(async v=>{ this.plugin.settings.defaultToleranceUnit=v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Display equation')
      .setDesc('Show “base ± tol = result” instead of just the result.')
      .addToggle(t=>t.setValue(this.plugin.settings.tolShowEquation)
        .onChange(async v=>{ this.plugin.settings.tolShowEquation=v; await this.plugin.saveSettings(); }));

    new Setting(containerEl).setName('Rounding (decimal places)')
      .setDesc('Rounding for computed results (0–10).')
      .addText(t=>t.setPlaceholder('3').setValue(String(this.plugin.settings.tolRounding))
        .onChange(async v=>{ const n = Number(v); this.plugin.settings.tolRounding = Number.isFinite(n)?Math.max(0,Math.min(10,n)):3; await this.plugin.saveSettings(); }));
  }
}

// ---------- styles ----------
function injectStyles() {
  if (document.head.querySelector('style[data-fusion-params-style]')) return;
  const css = `
  .fusion-params-status { margin: .25rem 0; font-size: .95em; opacity: .95; text-align: center; white-space: pre-line; }
  .fusion-params-toolbar { display: flex; align-items: center; gap: .5rem; margin: .25rem 0 .25rem; }
  .fusion-params-toolbar .icon-btn { width: 26px; height: 26px; border: 1px solid var(--background-modifier-border);
    border-radius: 6px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .fusion-params-toolbar .icon-btn:hover { background: var(--background-modifier-hover); }
  .fusion-params-tolbar { display:flex; align-items:center; gap:.5rem; margin:.25rem 0; }
  .fusion-params-tolbar .tol-input { width: 100px; }
  .fusion-params-table-container { margin-top: .25rem; }
  .fusion-params-title { font-weight: 600; margin: .25rem 0 .5rem; text-align: left; }
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
  .fusion-params-muted { opacity:.7; }
  `;
  const style = document.createElement('style');
  style.setAttribute('data-fusion-params-style', 'true');
  style.textContent = css; document.head.appendChild(style);
}

// ---------- table render ----------
function makeSortedParams(json, sortAZ) {
  const arr = json.parameters.slice();
  if (sortAZ) arr.sort((a,b)=>a.name.localeCompare(b.name));
  return arr;
}

function renderTableEditable(el, json, opts, onCommit) {
  const { sortAZ, showUnits, enableTolerance, tolDefaults, tolShowEquation, tolRounding } = opts;
  const params = makeSortedParams(json, sortAZ);

  // toolbar with + on left and CSV on right
  const toolbar = el.createEl('div', { cls: 'fusion-params-toolbar' });
  const addBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label':'Add parameter to end' } });
  setIcon(addBtn, 'plus');
  const spacer = toolbar.createEl('div', { style: 'flex:1' });
  const csvBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label':'Copy CSV' } });
  setIcon(csvBtn, 'clipboard');

  // tolerance bar
  let tolValueInput = null, tolUnitSelect = null, tolCheckAll = null, tolUncheckAll = null;
  if (enableTolerance) {
    const tolbar = el.createEl('div', { cls: 'fusion-params-tolbar' });
    tolbar.createEl('div', { text: 'Tolerance:' });
    tolValueInput = tolbar.createEl('input', { type:'number', value:String(tolDefaults.value) });
    tolValueInput.addClass('tol-input');
    tolUnitSelect = tolbar.createEl('select');
    for (const u of ['mm','in']) {
      const opt = document.createElement('option'); opt.value = u; opt.text = u;
      if (u === tolDefaults.unit) opt.selected = true; tolUnitSelect.appendChild(opt);
    }
    tolCheckAll = tolbar.createEl('div', { cls:'icon-btn', attr:{'aria-label':'Check all'} }); setIcon(tolCheckAll, 'check');
    tolUncheckAll = tolbar.createEl('div', { cls:'icon-btn', attr:{'aria-label':'Uncheck all'} }); setIcon(tolUncheckAll, 'x');
  }

  const container = el.createEl('div', { cls: 'fusion-params-table-container' });
  const title = container.createEl('div', { text: `Parameters for ${json.design}` });
  title.addClass('fusion-params-title');

  const table = container.createEl('table', { cls: 'fusion-params-table' });
  const thead = table.createEl('thead');
  const hdr = thead.createEl('tr');
  hdr.createEl('th', { text: '' }); // left-side insert
  if (enableTolerance) hdr.createEl('th', { text: 'Tol?' });
  hdr.createEl('th', { text: 'Name' });
  hdr.createEl('th', { text: 'Value / Expression' });
  if (showUnits) hdr.createEl('th', { text: 'Unit' });
  if (enableTolerance) hdr.createEl('th', { text: 'With tolerance' });
  hdr.createEl('th', { text: '' }); // right-side actions
  const tbody = table.createEl('tbody');

  // helpers
  const getTolValueAndUnit = () => {
    const v = tolValueInput ? Number(tolValueInput.value) : NaN;
    const u = tolUnitSelect ? tolUnitSelect.value : tolDefaults.unit;
    const value = Number.isFinite(v) ? v : tolDefaults.value;
    const unit  = (u === 'in' || u === 'mm') ? u : tolDefaults.unit;
    return { value, unit };
  };

  const getState = () => {
    const out = [];
    const tolState = {};
    for (const tr of tbody.children) {
      const name = tr.querySelector('input[data-key="name"]').value.trim();
      const val  = tr.querySelector('input[data-key="value"]').value.trim();
      const unitEl = showUnits ? tr.querySelector('input[data-key="unit"]') : null;
      const unit = unitEl ? unitEl.value.trim() : '';
      if (!name || val === '') continue;
      const numOnly = /^[0-9.+\-/* ()]+$/.test(val) && !/[a-zA-Z]/.test(val);
      const asNum = Number(val);
      if (numOnly && !Number.isNaN(asNum)) {
        const explicit = !!unit;
        if (explicit) out.push({ name, value: asNum, unit, _explicitUnit: true });
        else out.push({ name, value: asNum, _explicitUnit: false });
      } else {
        out.push({ name, expression: val });
      }
      if (enableTolerance) {
        const cb = tr.querySelector('input[type="checkbox"][data-key="tol"]');
        if (cb) tolState[name] = cb.checked === true;
      }
    }
    const { value: tolVal, unit: tolUnit } = getTolValueAndUnit();
    return { params: out, tolState, tolVal, tolUnit };
  };

  const recalcRow = (tr) => {
    if (!enableTolerance) return;
    const outCell = tr.querySelector('td[data-key="tolout"]');
    const cb = tr.querySelector('input[type="checkbox"][data-key="tol"]');
    if (!outCell || !cb) return;
    const name = tr.querySelector('input[data-key="name"]').value.trim();
    const valStr = tr.querySelector('input[data-key="value"]').value.trim();
    const unitEl = showUnits ? tr.querySelector('input[data-key="unit"]') : null;
    const unit = unitEl ? unitEl.value.trim() : '';

    // Determine if numeric and length unit
    const numOnly = /^[0-9.+\-/* ()]+$/.test(valStr) && !/[a-zA-Z]/.test(valStr);
    const asNum = Number(valStr);
    const baseUnit = unit || json.defaultUnit || '';
    const lengthUnit = (baseUnit === 'mm' || baseUnit === 'in');
    if (!numOnly || Number.isNaN(asNum) || !lengthUnit) {
      cb.disabled = true;
      cb.checked = false;
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }
    cb.disabled = false;
    outCell.removeClass('fusion-params-muted');

    const { value: tolVal, unit: tolUnit } = getTolValueAndUnit();
    if (!cb.checked || !Number.isFinite(tolVal)) { outCell.setText('—'); outCell.addClass('fusion-params-muted'); return; }

    const tolInRowUnit = convert(tolVal, tolUnit, baseUnit || 'mm');
    const result = asNum + tolInRowUnit;
    const rounded = roundTo(result, tolRounding);

    if (tolShowEquation) {
      const dispTol = roundTo(tolInRowUnit, tolRounding);
      outCell.setText(`${asNum} ${baseUnit} ± ${dispTol} ${baseUnit} = ${rounded} ${baseUnit}`);
    } else {
      outCell.setText(`${rounded} ${baseUnit}`);
    }
  };

  const recalcAll = () => { for (const tr of tbody.children) recalcRow(tr); };

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

    // left insert
    const tdIns = tr.createEl('td');
    const plusLeft = tdIns.createEl('span', { cls: 'row-action-left', attr: { 'aria-label':'Insert row below' } });
    setIcon(plusLeft, 'plus');

    // tolerance checkbox
    let tdTol = null, tolCb = null;
    if (enableTolerance) {
      tdTol = tr.createEl('td');
      tolCb = tdTol.createEl('input', { type:'checkbox' });
      tolCb.setAttr('data-key','tol');
      if (p && ('expression' in p)) { tolCb.disabled = true; }
    }

    // name/value(/unit)
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

    // with tolerance out cell
    let tdTolOut = null;
    if (enableTolerance) {
      tdTolOut = tr.createEl('td', { attr: { 'data-key':'tolout' } });
      tdTolOut.addClass('fusion-params-muted');
      tdTolOut.setText('—');
    }

    // right actions
    const tdActions = tr.createEl('td');
    const okBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label':'Save row' } });
    setIcon(okBtn, 'check');
    const delBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label':'Delete row' } });
    setIcon(delBtn, 'trash');

    // handlers
    okBtn.addEventListener('click', () => onCommit(getState));
    delBtn.addEventListener('click', () => { tr.remove(); onCommit(getState); });

    plusLeft.addEventListener('click', () => {
      const newTr = insertRowAfter(tr, null, true, true);
      newTr.scrollIntoView({ block: 'nearest' });
    });

    if (enableTolerance && tolCb) tolCb.addEventListener('change', () => recalcRow(tr));
    nameInput.addEventListener('input', () => recalcRow(tr));
    valInput.addEventListener('input', () => recalcRow(tr));
    if (showUnits && unitInput) unitInput.addEventListener('input', () => recalcRow(tr));

    const lastInput = (showUnits && unitInput) ? unitInput : valInput;
    for (const input of [nameInput, valInput, unitInput].filter(Boolean)) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          if (isRowComplete(tr)) {
            ev.preventDefault();
            onCommit(getState);
            const newTr = insertRowAfter(tr, null, true, true);
            newTr.scrollIntoView({ block: 'nearest' });
          }
        } else if (ev.key === 'Tab') {
          if (ev.target === lastInput && isRowComplete(tr)) {
            setTimeout(()=>onCommit(getState), 0);
          }
        }
      });
    }

    // ephemeral cleanup
    tr.addEventListener('focusout', () => {
      setTimeout(() => {
        const ep = tr.getAttr('data-ephemeral') === '1';
        if (ep && isRowEmpty(tr) && !tr.contains(document.activeElement)) {
          tr.remove();
        }
      }, 10);
    });

    return { tr };
  }

  function insertRowAfter(refTr, p=null, focusName=true, ephemeral=true) {
    const { tr } = createRowElements(p);
    tr.setAttr('data-ephemeral', ephemeral ? '1' : '0');
    if (refTr && refTr.nextSibling) tbody.insertBefore(tr, refTr.nextSibling);
    else if (refTr && !refTr.nextSibling) tbody.appendChild(tr);
    else tbody.appendChild(tr);
    if (focusName) {
      const nameInput = tr.querySelector('input[data-key="name"]');
      if (nameInput) nameInput.focus();
    }
    recalcRow(tr);
    return tr;
  }

  // seed rows from JSON
  let lastTr = null;
  for (const p of params) lastTr = insertRowAfter(lastTr, p, false, false);

  // toolbar hooks
  addBtn.addEventListener('click', () => insertRowAfter(tbody.lastElementChild, null, true, true));
  csvBtn.addEventListener('click', async () => {
    const rows = [['Tol?','Name','Value','Unit','WithTol']];
    for (const tr of tbody.children) {
      const tol = enableTolerance ? (tr.querySelector('input[data-key="tol"]')?.checked ? 'Y' : '') : '';
      const name = tr.querySelector('input[data-key="name"]').value;
      const val  = tr.querySelector('input[data-key="value"]').value;
      const unit = showUnits ? tr.querySelector('input[data-key="unit"]').value : '';
      const wt   = enableTolerance ? tr.querySelector('td[data-key="tolout"]')?.textContent || '' : '';
      rows.push([tol,name,val,unit,wt]);
    }
    const csv = rows.map(r => r.map(x => /[",\n]/.test(x) ? `"${x.replace(/"/g,'""')}"` : x).join(',')).join('\n');
    try { await navigator.clipboard.writeText(csv); new Notice('CSV copied'); } catch { new Notice('Copy failed'); }
  });
  if (enableTolerance) {
    const refocus = () => { const a = document.activeElement; if (a) a.blur(); };
    tolValueInput.addEventListener('input', recalcAll);
    tolUnitSelect.addEventListener('change', recalcAll);
    tolCheckAll.addEventListener('click', () => { for (const tr of tbody.children) { const cb=tr.querySelector('input[data-key="tol"]'); if (cb && !cb.disabled) cb.checked = true; } recalcAll(); refocus(); });
    tolUncheckAll.addEventListener('click', () => { for (const tr of tbody.children) { const cb=tr.querySelector('input[data-key="tol"]'); if (cb) cb.checked = false; } recalcAll(); refocus(); });
  }

  // initial calc
  recalcAll();

  // expose state reader to onCommit
  // onCommit expects a function getState -> { params, tolState, tolVal, tolUnit }
}

// ---------- plugin ----------
module.exports = class FusionParamsPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, {
      outputFolder: "Params",
      defaultUnit: "mm",
      alwaysNotify: false,
      sortAZ: true,
      showUnits: true,
      // tolerance
      enableTolerance: false,
      defaultToleranceValue: 0.2,
      defaultToleranceUnit: "mm",
      tolShowEquation: false,
      tolRounding: 3
    }, await this.loadData());

    injectStyles();

    // command + context menu
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

        // Status (centered, multiline) shown ABOVE the table
        const status = el.createEl('div'); status.addClass('fusion-params-status');

        // Write base JSON
        const baseJson = {
          design: json.design,
          defaultUnit: json.defaultUnit,
          parameters: json.parameters.map(p => ('expression' in p) ? ({ name: p.name, expression: p.expression }) : ({ name: p.name, value: p.value, unit: p.unit }))
        };
        const outRelPath = joinVaultPath(this.settings.outputFolder, `${json.design}.json`);
        await this.app.vault.adapter.mkdir(this.settings.outputFolder).catch(() => {});
        const pretty = JSON.stringify(baseJson, null, 2);
        const changed = await writeIfChanged(this.app.vault.adapter, outRelPath, pretty);

        const now = Date.now();
        const recent = recentExports.get(outRelPath);
        const setStatus = (label) => status.setText(`${label}\n→ ${outRelPath}`);

        if (changed) {
          recentExports.set(outRelPath, { hash: hashString(pretty), t: now });
          setStatus('Updated');
          setTimeout(() => setStatus('No changes pending'), 3000);
        } else if (recent && (now - recent.t) < 4000) {
          setStatus('Updated just now');
          setTimeout(() => setStatus('No changes pending'), 2500);
        } else {
          setStatus('No changes pending');
        }
        if (this.settings.alwaysNotify) new Notice(status.textContent);

        // Two-way writeback + render UI
        const section = ctx.getSectionInfo(el);
        const file = this.app.workspace.getActiveFile();

        const applyWriteback = async (getState) => {
          if (!file || !section) return;
          const state = getState(); const newParams = state.params;
          const updatedJson = { ...json, parameters: newParams };
          const newBlock = fromJsonToBlock(updatedJson);
          const data = await this.app.vault.read(file);
          const next = safeReplaceSection(data, section.lineStart, section.lineEnd, newBlock);
          if (next.trim() === data.trim()) return;
          await this.app.vault.modify(file, next);
        };

        renderTableEditable(
          el,
          json,
          {
            sortAZ: this.settings.sortAZ,
            showUnits: this.settings.showUnits,
            enableTolerance: this.settings.enableTolerance,
            tolDefaults: { value: this.settings.defaultToleranceValue, unit: this.settings.defaultToleranceUnit },
            tolShowEquation: this.settings.tolShowEquation,
            tolRounding: this.settings.tolRounding
          },
          applyWriteback
        );

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
