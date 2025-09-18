
const { Plugin, Notice, PluginSettingTab, Setting, setIcon, Modal, MarkdownView } = require('obsidian');

// ---------- helpers ----------
function normalizeSpaces(s) { return s.replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' '); }
function splitLineAndComment(raw) {
  let inSingle = false, inDouble = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if (ch === '#' && !inSingle && !inDouble) {
      return { code: raw.slice(0, i), comment: raw.slice(i + 1) };
    }
  }
  return { code: raw, comment: '' };
}
function hashString(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i); return (h >>> 0).toString(16); }
function joinVaultPath(folder, file) {
  folder = (folder || '').replace(/^[\/\\]+|[\/\\]+$/g, '');
  file = (file || '').replace(/^[\/\\]+/g, '');
  return folder ? `${folder}/${file}` : file;
}
const recentExports = new Map();

const LENGTH_UNITS_MM = {
  mm: 1,
  millimeter: 1,
  millimeters: 1,
  cm: 10,
  centimeter: 10,
  centimeters: 10,
  dm: 100,
  m: 1000,
  meter: 1000,
  meters: 1000,
  in: 25.4,
  inch: 25.4,
  inches: 25.4,
  ft: 304.8,
  foot: 304.8,
  feet: 304.8
};
function normalizeUnit(unit) {
  return (unit || '').toString().trim().toLowerCase();
}
function isLengthUnit(unit) {
  return !!LENGTH_UNITS_MM[normalizeUnit(unit)];
}
function convertLength(val, fromUnit, toUnit) {
  const from = LENGTH_UNITS_MM[normalizeUnit(fromUnit)];
  const to = LENGTH_UNITS_MM[normalizeUnit(toUnit)];
  if (!Number.isFinite(val) || !from || !to) return null;
  return (val * from) / to;
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
  const params = [];
  for (let raw of lines) {
    const { code, comment } = splitLineAndComment(raw);
    let line = code.replace(/\t/g, '    ').trimEnd();
    const trimmedLine = normalizeSpaces(line).trim();
    if (!trimmedLine) continue;
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
      const value = val.replace(/^["']|["']$/g, '');
      const commentText = normalizeSpaces(comment || '').trim();
      params.push({ name, value, comment: commentText });
    }
  }
  if (!part) throw new Error("Missing 'part'");
  return { part, units, params };
}
function toJson(parsed, fallbackUnit) {
  const defaultUnit = parsed.units || fallbackUnit || "";
  const out = { design: parsed.part, defaultUnit, parameters: [] };
  const paramsByName = {};
  for (const entry of parsed.params) {
    if (!entry || !entry.name) continue;
    paramsByName[entry.name] = { raw: entry.value, comment: entry.comment || '' };
  }
  for (const [name, payload] of Object.entries(paramsByName)) {
    const raw = String(payload.raw ?? '');
    const comment = String(payload.comment ?? '');
    if (raw === '') continue;
    const asNum = Number(raw);
    if (!Number.isNaN(asNum)) {
      const base = { name, value: asNum, unit: defaultUnit, _explicitUnit: false, _raw: raw };
      if (comment) base.comment = comment;
      out.parameters.push(base);
      continue;
    }
    const mUnit = raw.match(/^([0-9.+\-/* ()]+)\s*([a-zA-Z°]+)$/);
    if (mUnit) {
      const num = Number(mUnit[1].trim()), unit = mUnit[2].trim();
      if (!Number.isNaN(num)) {
        const base = { name, value: num, unit, _explicitUnit: true, _raw: raw };
        if (comment) base.comment = comment;
        out.parameters.push(base);
        continue;
      }
    }
    const base = { name, expression: raw, _raw: raw };
    if (comment) base.comment = comment;
    out.parameters.push(base);
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
    const comment = (p.comment ?? '').toString();
    const commentSuffix = comment.trim() ? ` # ${comment}` : '';
    const explicitUnit = p._explicitUnit || (p.unit && p.unit !== (json.defaultUnit || ''));
    if ('expression' in p) lines.push(`  ${p.name}: ${p.expression}${commentSuffix}`);
    else if (p.unit && explicitUnit) lines.push(`  ${p.name}: ${p.value} ${p.unit}${commentSuffix}`);
    else lines.push(`  ${p.name}: ${p.value}${commentSuffix}`);
  }
  lines.push("```");
  return lines.join("\n");
}

// ---------- file IO ----------
async function readSafe(adapter, path) { try { return await adapter.read(path); } catch { return null; } }
async function ensureFolderExists(adapter, folder) {
  if (!folder) return;
  const parts = folder.split('/').filter(Boolean);
  let current = '';
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    try { await adapter.mkdir(current); } catch (e) { /* ignore */ }
  }
}
async function writeIfChanged(adapter, path, content) {
  const folder = path.split('/').slice(0, -1).join('/');
  await ensureFolderExists(adapter, folder);
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
function findFusionBlockRange(lines, cursorLine) {
  let start = cursorLine;
  while (start >= 0) {
    const trimmed = lines[start].trim();
    if (trimmed.startsWith('```fusion-params')) break;
    if (trimmed.startsWith('```')) return null;
    start--;
  }
  if (start < 0 || !lines[start].trim().startsWith('```fusion-params')) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('```')) end++;
  if (end >= lines.length) return null;
  return { start, end };
}
function normalizeImportedJsonPayload(payload, fallbackUnit, fallbackDesign) {
  const designRaw = payload?.design ?? payload?.part;
  const design = (designRaw != null && String(designRaw).trim())
    ? String(designRaw).trim()
    : (fallbackDesign || 'Imported');
  const defaultUnitRaw = payload?.defaultUnit ?? payload?.units;
  const defaultUnit = (defaultUnitRaw != null && String(defaultUnitRaw).trim())
    ? String(defaultUnitRaw).trim()
    : (fallbackUnit || '');
  const params = Array.isArray(payload?.parameters) ? payload.parameters : [];
  const normalized = [];
  for (const raw of params) {
    if (!raw || raw.name == null) continue;
    const name = String(raw.name).trim();
    if (!name) continue;
    const comment = raw.comment != null ? String(raw.comment).trim() : '';
    const expr = raw.expression != null ? String(raw.expression).trim() : '';
    if (expr) { normalized.push({ name, expression: expr, comment }); continue; }
    let numeric = raw.value;
    if (!Number.isFinite(numeric)) numeric = Number(raw.value);
    const rawUnit = raw.unit != null ? String(raw.unit).trim() : '';
    if (Number.isFinite(numeric)) {
      const explicit = rawUnit && rawUnit !== defaultUnit;
      const param = { name, value: numeric, comment, _explicitUnit: explicit };
      if (rawUnit) param.unit = rawUnit;
      else if (defaultUnit) param.unit = defaultUnit;
      normalized.push(param);
      continue;
    }
    const fallbackExpr = raw.value != null ? String(raw.value).trim() : '';
    if (fallbackExpr) normalized.push({ name, expression: fallbackExpr, comment });
  }
  return { design, defaultUnit, parameters: normalized };
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

class ImportJsonModal extends Modal {
  constructor(app, plugin, onSelect) {
    super(app);
    this.plugin = plugin;
    this.onSelect = onSelect;
    this.files = [];
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Import Fusion parameters' });

    this.files = this.app.vault.getFiles().filter(f => (f.extension || '').toLowerCase() === 'json');
    this.files.sort((a, b) => a.path.localeCompare(b.path));

    if (!this.files.length) {
      contentEl.createEl('p', { text: 'No JSON files were found in this vault.' });
      const closeBtn = contentEl.createEl('button', { text: 'Close' });
      closeBtn.addEventListener('click', () => this.close());
      return;
    }

    contentEl.createEl('p', {
      text: 'Select a Fusion parameter JSON file to insert or replace the fusion-params code block at your cursor.'
    });

    const datalistId = `fusion-json-files-${Date.now()}`;
    const datalist = contentEl.createEl('datalist', { attr: { id: datalistId } });
    for (const file of this.files) datalist.createEl('option', { attr: { value: file.path } });

    const input = contentEl.createEl('input', { type: 'text' });
    input.setAttr('list', datalistId);
    input.setAttr('placeholder', 'Params/example.json');

    const preferredFolder = (this.plugin.settings.outputFolder || '').replace(/^[\/\\]+|[\/\\]+$/g, '');
    const defaultIdx = preferredFolder
      ? this.files.findIndex(f => f.path.startsWith(preferredFolder + '/'))
      : -1;
    input.value = (this.files[defaultIdx >= 0 ? defaultIdx : 0]?.path) || '';

    const actionRow = contentEl.createEl('div', { attr: { style: 'display:flex; gap:.5rem; margin-top:1rem; justify-content:flex-end;' } });
    const importBtn = actionRow.createEl('button', { text: 'Import' });
    const cancelBtn = actionRow.createEl('button', { text: 'Cancel' });

    const submit = () => {
      const typed = (input.value || '').trim();
      if (!typed) { new Notice('Choose a JSON file to import.'); return; }
      const exact = this.files.find(f => f.path === typed);
      const match = exact || this.files.find(f => f.path.endsWith(typed));
      if (!match) { new Notice(`Could not find “${typed}”.`); return; }
      this.close();
      this.onSelect(match);
    };

    importBtn.addEventListener('click', submit);
    cancelBtn.addEventListener('click', () => this.close());
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        submit();
      }
    });
  }

  onClose() { this.contentEl.empty(); }
}

// ---------- styles ----------
function injectStyles() {
  if (document.head.querySelector('style[data-fusion-params-style]')) return;
  const css = `
  .fusion-params-status { margin: .25rem 0; font-size: .95em; opacity: .95; text-align: center; white-space: pre-line; }
  .fusion-params-status-error { color: var(--text-error); }
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
  table.fusion-params-table td input.fusion-params-invalid {
    border-color: var(--text-error);
    box-shadow: 0 0 0 1px var(--text-error);
  }
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
  const params = makeSortedParams(json, sortAZ).map(p => ({ ...p, comment: (p.comment ?? '') }));

  const toolbar = el.createEl('div', { cls: 'fusion-params-toolbar' });
  const addBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label': 'Add parameter to end' } });
  setIcon(addBtn, 'plus');
  toolbar.createEl('div', { style: 'flex:1' });
  const csvBtn = toolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label': 'Copy CSV' } });
  setIcon(csvBtn, 'clipboard');

  const allowedTolUnits = ['mm', 'cm', 'm', 'in', 'ft'];
  let tolUnitDefault = (tolDefaults.unit && allowedTolUnits.includes(tolDefaults.unit)) ? tolDefaults.unit : 'mm';
  let tolValueInput = null, tolUnitSelect = null, tolCheckAll = null, tolUncheckAll = null;
  if (enableTolerance) {
    const tolbar = el.createEl('div', { cls: 'fusion-params-tolbar' });
    tolbar.createEl('div', { text: 'Tolerance:' });
    tolValueInput = tolbar.createEl('input', { type: 'number', value: String(tolDefaults.value) });
    tolValueInput.addClass('tol-input');
    tolUnitSelect = tolbar.createEl('select');
    for (const unit of allowedTolUnits) {
      const opt = document.createElement('option');
      opt.value = unit;
      opt.text = unit;
      if (unit === tolUnitDefault) opt.selected = true;
      tolUnitSelect.appendChild(opt);
    }
    tolCheckAll = tolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label': 'Check all' } });
    setIcon(tolCheckAll, 'check');
    tolUncheckAll = tolbar.createEl('div', { cls: 'icon-btn', attr: { 'aria-label': 'Uncheck all' } });
    setIcon(tolUncheckAll, 'x');
  }

  const container = el.createEl('div', { cls: 'fusion-params-table-container' });
  const title = container.createEl('div', { text: `Parameters for ${json.design}` });
  title.addClass('fusion-params-title');

  const table = container.createEl('table', { cls: 'fusion-params-table' });
  const thead = table.createEl('thead');
  const hdr = thead.createEl('tr');
  hdr.createEl('th', { text: '' });
  if (enableTolerance) hdr.createEl('th', { text: 'Tol?' });
  hdr.createEl('th', { text: 'Name' });
  hdr.createEl('th', { text: 'Value / Expression' });
  if (showUnits) hdr.createEl('th', { text: 'Unit' });
  hdr.createEl('th', { text: 'Comment' });
  if (enableTolerance) hdr.createEl('th', { text: 'With tolerance' });
  hdr.createEl('th', { text: '' });
  const tbody = table.createEl('tbody');

  const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const PURE_NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
  const INLINE_UNIT = /^([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*([^\s]+)$/;
  const ALLOWED_VALUE = /^[0-9a-zA-Z_+\-*/().\s]+$/;

  function hasBalancedParens(str) {
    let depth = 0;
    for (const ch of str) {
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth < 0) return false;
      }
    }
    return depth === 0;
  }

  function setValidity(input, ok, message = '') {
    if (!input) return;
    if (ok) {
      input.removeClass('fusion-params-invalid');
      input.removeAttribute('aria-invalid');
      input.removeAttribute('title');
    } else {
      input.addClass('fusion-params-invalid');
      input.setAttr('aria-invalid', 'true');
      if (message) input.setAttr('title', message);
      else input.removeAttribute('title');
    }
  }

  function analyzeValue(value, unit) {
    const trimmedVal = value.trim();
    const trimmedUnit = unit.trim();
    if (!trimmedVal) return { ok: false, field: 'value', message: 'Value required' };
    if (trimmedUnit && /\s/.test(trimmedUnit)) return { ok: false, field: 'unit', message: 'Unit may not contain spaces' };

    const normalized = trimmedVal.replace(/\s+/g, '');
    if (PURE_NUMBER.test(normalized)) {
      const num = Number(trimmedVal);
      if (!Number.isFinite(num)) return { ok: false, field: 'value', message: 'Invalid number' };
      return { ok: true, param: { kind: 'number', value: num, unit: trimmedUnit || null, explicitUnit: !!trimmedUnit } };
    }

    const inline = trimmedVal.match(INLINE_UNIT);
    if (inline && !trimmedUnit) {
      const num = Number(inline[1]);
      if (!Number.isFinite(num)) return { ok: false, field: 'value', message: 'Invalid number' };
      return { ok: true, param: { kind: 'number', value: num, unit: inline[2], explicitUnit: true } };
    }
    if (inline && trimmedUnit) {
      return { ok: false, field: 'unit', message: 'Move unit to a single column' };
    }

    if (!ALLOWED_VALUE.test(trimmedVal)) {
      return { ok: false, field: 'value', message: 'Unsupported character' };
    }
    if (!hasBalancedParens(trimmedVal)) {
      return { ok: false, field: 'value', message: 'Unbalanced parentheses' };
    }
    if (/[+\-*/]$/.test(trimmedVal)) {
      return { ok: false, field: 'value', message: 'Ends with operator' };
    }
    if (/^[*/]/.test(trimmedVal)) {
      return { ok: false, field: 'value', message: 'Starts with operator' };
    }
    if (trimmedUnit) {
      return { ok: false, field: 'unit', message: 'Expressions cannot use Unit column' };
    }

    return { ok: true, param: { kind: 'expression', expression: trimmedVal } };
  }

  function getTolValueAndUnit() {
    const v = tolValueInput ? Number(tolValueInput.value) : NaN;
    const selected = tolUnitSelect ? tolUnitSelect.value : tolUnitDefault;
    const unit = allowedTolUnits.includes(selected) ? selected : tolUnitDefault;
    const value = Number.isFinite(v) ? v : tolDefaults.value;
    return { value, unit };
  }

  function parseRow(tr) {
    const nameInput = tr.querySelector('input[data-key="name"]');
    const valueInput = tr.querySelector('input[data-key="value"]');
    const unitInput = showUnits ? tr.querySelector('input[data-key="unit"]') : null;
    const commentInput = tr.querySelector('input[data-key="comment"]');
    const tolInput = enableTolerance ? tr.querySelector('input[type="checkbox"][data-key="tol"]') : null;

    const raw = {
      name: nameInput ? (nameInput.value || '') : '',
      value: valueInput ? (valueInput.value || '') : '',
      unit: unitInput ? (unitInput.value || '') : '',
      comment: commentInput ? (commentInput.value || '') : ''
    };
    const trimmed = {
      name: raw.name.trim(),
      value: raw.value.trim(),
      unit: raw.unit.trim(),
      comment: raw.comment.trim()
    };

    if (!trimmed.name && trimmed.value === '' && (!showUnits || trimmed.unit === '') && trimmed.comment === '') {
      setValidity(nameInput, true);
      setValidity(valueInput, true);
      if (unitInput) setValidity(unitInput, true);
      return {
        inputs: { name: nameInput, value: valueInput, unit: unitInput, comment: commentInput, tol: tolInput },
        raw,
        trimmed,
        empty: true,
        errors: [],
        valid: true,
        param: null,
        tolChecked: tolInput ? tolInput.checked === true : false
      };
    }

    const errors = [];
    const errorMap = {};

    if (!trimmed.name) {
      const msg = 'Name required';
      errors.push({ field: 'name', message: msg });
      errorMap.name = msg;
    } else if (!NAME_PATTERN.test(trimmed.name)) {
      const msg = 'Use letters, numbers, and underscores (start with letter or _)';
      errors.push({ field: 'name', message: msg });
      errorMap.name = msg;
    }

    const valueCheck = analyzeValue(trimmed.value, trimmed.unit);
    if (!valueCheck.ok) {
      errors.push({ field: valueCheck.field, message: valueCheck.message });
      errorMap[valueCheck.field] = valueCheck.message;
    }

    setValidity(nameInput, !errorMap.name, errorMap.name);
    setValidity(valueInput, !errorMap.value, errorMap.value);
    if (unitInput) setValidity(unitInput, !errorMap.unit, errorMap.unit);

    if (errors.length > 0) {
      return {
        inputs: { name: nameInput, value: valueInput, unit: unitInput, comment: commentInput, tol: tolInput },
        raw,
        trimmed,
        empty: false,
        errors,
        valid: false,
        param: null,
        tolChecked: tolInput ? tolInput.checked === true : false
      };
    }

    const param = { name: trimmed.name, _raw: raw.value };
    if (valueCheck.param.kind === 'expression') {
      param.expression = valueCheck.param.expression;
    } else {
      param.value = valueCheck.param.value;
      const explicit = valueCheck.param.explicitUnit;
      param._explicitUnit = explicit;
      const rowUnit = explicit ? valueCheck.param.unit : (json.defaultUnit || '');
      if (rowUnit) param.unit = rowUnit;
    }
    param.comment = trimmed.comment;

    return {
      inputs: { name: nameInput, value: valueInput, unit: unitInput, comment: commentInput, tol: tolInput },
      raw,
      trimmed,
      empty: false,
      errors: [],
      valid: true,
      param,
      tolChecked: tolInput ? tolInput.checked === true : false
    };
  }

  const recalcRow = (tr, cachedRow) => {
    if (!enableTolerance) return;
    const outCell = tr.querySelector('td[data-key="tolout"]');
    const cb = tr.querySelector('input[type="checkbox"][data-key="tol"]');
    if (!outCell || !cb) return;

    const row = cachedRow || parseRow(tr);
    if (!row.valid || !row.param || typeof row.param.value !== 'number') {
      cb.disabled = true;
      cb.checked = false;
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }

    const baseUnit = row.param._explicitUnit ? (row.param.unit || '') : (json.defaultUnit || '');
    if (!baseUnit || !isLengthUnit(baseUnit)) {
      cb.disabled = true;
      cb.checked = false;
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }

    const { value: tolVal, unit: tolUnit } = getTolValueAndUnit();
    if (!Number.isFinite(tolVal) || !isLengthUnit(tolUnit)) {
      cb.disabled = true;
      cb.checked = false;
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }

    const converted = convertLength(tolVal, tolUnit, baseUnit);
    if (converted == null) {
      cb.disabled = true;
      cb.checked = false;
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }

    cb.disabled = false;
    if (!cb.checked) {
      outCell.setText('—');
      outCell.addClass('fusion-params-muted');
      return;
    }

    outCell.removeClass('fusion-params-muted');
    const result = row.param.value + converted;
    const rounded = roundTo(result, tolRounding);
    if (tolShowEquation) {
      const dispTol = roundTo(converted, tolRounding);
      outCell.setText(`${row.param.value} ${baseUnit} ± ${dispTol} ${baseUnit} = ${rounded} ${baseUnit}`);
    } else {
      outCell.setText(`${rounded} ${baseUnit}`);
    }
  };

  const recalcAll = () => { for (const tr of tbody.children) recalcRow(tr); };

  function collectState() {
    const paramsOut = [];
    const tolState = {};
    const errors = [];
    for (const tr of tbody.children) {
      const row = parseRow(tr);
      if (row.empty) continue;
      if (!row.valid || !row.param) {
        errors.push({ name: row.trimmed.name || '(unnamed)', issues: row.errors });
        continue;
      }
      const param = { name: row.param.name, _raw: row.param._raw };
      if ('expression' in row.param) {
        param.expression = row.param.expression;
      } else {
        param.value = row.param.value;
        if (row.param.unit !== undefined) param.unit = row.param.unit;
        param._explicitUnit = row.param._explicitUnit;
      }
      if (row.param.comment !== undefined) param.comment = row.param.comment;
      paramsOut.push(param);
      if (enableTolerance) tolState[row.param.name] = row.tolChecked === true;
    }
    const { value: tolVal, unit: tolUnit } = getTolValueAndUnit();
    return { params: paramsOut, tolState, tolVal, tolUnit, errors };
  }

  const commitState = () => {
    const state = collectState();
    onCommit(() => state);
    return state;
  };

  const isRowComplete = (tr) => {
    const row = parseRow(tr);
    return !row.empty && row.valid && row.trimmed.name !== '' && row.trimmed.value !== '';
  };

  const isRowEmpty = (tr) => parseRow(tr).empty;

  function createRowElements(p) {
    const tr = document.createElement('tr');

    const tdIns = tr.createEl('td');
    const plusLeft = tdIns.createEl('span', { cls: 'row-action-left', attr: { 'aria-label': 'Insert row below' } });
    setIcon(plusLeft, 'plus');

    let tolCb = null;
    if (enableTolerance) {
      const tdTol = tr.createEl('td');
      tolCb = tdTol.createEl('input', { type: 'checkbox' });
      tolCb.setAttr('data-key', 'tol');
      if (p && ('expression' in p)) tolCb.disabled = true;
    }

    const tdName = tr.createEl('td');
    const tdVal = tr.createEl('td');
    const nameInput = tdName.createEl('input', { type: 'text', value: p?.name || '' });
    nameInput.setAttr('data-key', 'name');

    const valStr = (p && ('expression' in p)) ? p.expression : (p ? (p.value ?? '') : '');
    const valInput = tdVal.createEl('input', { type: 'text', value: String(valStr) });
    valInput.setAttr('data-key', 'value');

    let unitInput = null;
    if (showUnits) {
      const tdUnit = tr.createEl('td');
      const showUnitText = (p && ('expression' in p)) ? '' : (p && p._explicitUnit ? (p.unit || '') : '');
      unitInput = tdUnit.createEl('input', { type: 'text', value: showUnitText });
      unitInput.setAttr('data-key', 'unit');
      if (!(p && p._explicitUnit) && !(p && ('expression' in p))) {
        unitInput.setAttr('placeholder', `default (${json.defaultUnit || ''})`);
        unitInput.addClass('fusion-params-unit-placeholder');
      }
    }

    const tdComment = tr.createEl('td');
    const commentInput = tdComment.createEl('input', { type: 'text', value: p?.comment || '' });
    commentInput.setAttr('data-key', 'comment');

    let tdTolOut = null;
    if (enableTolerance) {
      tdTolOut = tr.createEl('td', { attr: { 'data-key': 'tolout' } });
      tdTolOut.addClass('fusion-params-muted');
      tdTolOut.setText('—');
    }

    const tdActions = tr.createEl('td');
    const okBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label': 'Save row' } });
    setIcon(okBtn, 'check');
    const delBtn = tdActions.createEl('span', { cls: 'row-action', attr: { 'aria-label': 'Delete row' } });
    setIcon(delBtn, 'trash');

    const readRow = () => parseRow(tr);
    const handleValueChange = () => {
      const row = readRow();
      recalcRow(tr, row);
    };

    if (enableTolerance && tolCb) tolCb.addEventListener('change', () => recalcRow(tr, readRow()));
    nameInput.addEventListener('input', handleValueChange);
    valInput.addEventListener('input', handleValueChange);
    if (showUnits && unitInput) {
      unitInput.addEventListener('input', () => {
        unitInput.removeClass('fusion-params-unit-placeholder');
        handleValueChange();
      });
    }
    commentInput.addEventListener('input', () => { readRow(); });

    okBtn.addEventListener('click', () => commitState());
    delBtn.addEventListener('click', () => { tr.remove(); commitState(); });
    plusLeft.addEventListener('click', () => {
      const newTr = insertRowAfter(tr, null, true, true);
      newTr.scrollIntoView({ block: 'nearest' });
    });

    const inputSequence = [nameInput, valInput];
    if (showUnits && unitInput) inputSequence.push(unitInput);
    inputSequence.push(commentInput);
    const lastInput = inputSequence[inputSequence.length - 1];
    for (const input of inputSequence) {
      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          const row = readRow();
          if (!row.empty && row.valid && row.trimmed.name !== '' && row.trimmed.value !== '') {
            ev.preventDefault();
            const state = commitState();
            if (!state.errors.length) {
              const newTr = insertRowAfter(tr, null, true, true);
              newTr.scrollIntoView({ block: 'nearest' });
            }
          }
        } else if (ev.key === 'Tab' && ev.target === lastInput) {
          const row = readRow();
          if (!row.empty && row.valid) {
            setTimeout(() => commitState(), 0);
          }
        }
      });
    }

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

  function insertRowAfter(refTr, p = null, focusName = true, ephemeral = true) {
    const { tr } = createRowElements(p);
    tr.setAttr('data-ephemeral', ephemeral ? '1' : '0');
    if (refTr && refTr.nextSibling) tbody.insertBefore(tr, refTr.nextSibling);
    else if (refTr && !refTr.nextSibling) tbody.appendChild(tr);
    else tbody.appendChild(tr);
    if (focusName) {
      const nameInput = tr.querySelector('input[data-key="name"]');
      if (nameInput) nameInput.focus();
    }
    const row = parseRow(tr);
    recalcRow(tr, row);
    return tr;
  }

  let lastTr = null;
  for (const p of params) lastTr = insertRowAfter(lastTr, p, false, false);

  addBtn.addEventListener('click', () => insertRowAfter(tbody.lastElementChild, null, true, true));
  csvBtn.addEventListener('click', async () => {
    const header = [];
    if (enableTolerance) header.push('Tol?');
    header.push('Name', 'Value');
    if (showUnits) header.push('Unit');
    header.push('Comment');
    if (enableTolerance) header.push('WithTol');
    const rows = [header];
    for (const tr of tbody.children) {
      const row = parseRow(tr);
      const csvRow = [];
      if (enableTolerance) csvRow.push(row.inputs.tol && row.inputs.tol.checked ? 'Y' : '');
      csvRow.push(row.raw.name);
      csvRow.push(row.raw.value);
      if (showUnits) csvRow.push(row.raw.unit);
      csvRow.push(row.raw.comment);
      if (enableTolerance) csvRow.push(tr.querySelector('td[data-key="tolout"]')?.textContent || '');
      rows.push(csvRow);
    }
    const csv = rows.map(r => r.map(x => {
      const str = x ?? '';
      return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    }).join(',')).join('\n');
    try {
      await navigator.clipboard.writeText(csv);
      new Notice('CSV copied');
    } catch {
      new Notice('Copy failed');
    }
  });

  if (enableTolerance) {
    const refocus = () => { const a = document.activeElement; if (a) a.blur(); };
    tolValueInput.addEventListener('input', () => recalcAll());
    tolUnitSelect.addEventListener('change', () => recalcAll());
    tolCheckAll.addEventListener('click', () => {
      for (const tr of tbody.children) {
        const cb = tr.querySelector('input[data-key="tol"]');
        if (cb && !cb.disabled) cb.checked = true;
      }
      recalcAll();
      refocus();
    });
    tolUncheckAll.addEventListener('click', () => {
      for (const tr of tbody.children) {
        const cb = tr.querySelector('input[data-key="tol"]');
        if (cb) cb.checked = false;
      }
      recalcAll();
      refocus();
    });
  }

  recalcAll();
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
    const importJsonIntoNote = async (jsonFile) => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || !view.editor) { new Notice('Open a Markdown note to import parameters.'); return; }
      const noteFile = view.file;
      if (!noteFile) { new Notice('Active view has no file to update.'); return; }

      let raw;
      try {
        raw = await this.app.vault.read(jsonFile);
      } catch (err) {
        console.error(err);
        new Notice(`Failed to read ${jsonFile.path}`);
        return;
      }

      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (err) {
        console.error(err);
        new Notice(`Invalid JSON in ${jsonFile.path}`);
        return;
      }

      const normalized = normalizeImportedJsonPayload(payload, this.settings.defaultUnit, jsonFile?.basename);
      const blockText = fromJsonToBlock(normalized);
      const editor = view.editor;
      const doc = editor.getValue();
      const lines = doc.split(/\r?\n/);
      const cursor = editor.getCursor();
      const range = findFusionBlockRange(lines, cursor.line);

      let nextDoc;
      if (range) nextDoc = safeReplaceSection(doc, range.start, range.end, blockText);
      else {
        const before = lines.slice(0, cursor.line).join('\n');
        const after = lines.slice(cursor.line).join('\n');
        const glue1 = (before && !before.endsWith('\n')) ? '\n' : '';
        const glue2 = (!blockText.endsWith('\n')) ? '\n' : '';
        const glue3 = (after && !after.startsWith('\n')) ? '\n' : '';
        nextDoc = `${before}${glue1}${blockText}${glue2}${glue3}${after}`;
      }

      if (nextDoc === doc) {
        new Notice('No changes to import.');
        return;
      }

      try {
        await this.app.vault.modify(noteFile, nextDoc);
        new Notice(`Imported parameters from ${jsonFile.path}`);
      } catch (err) {
        console.error(err);
        new Notice(`Failed to update note: ${err.message || err}`);
      }
    };

    const openImportModal = () => {
      const modal = new ImportJsonModal(this.app, this, (file) => { importJsonIntoNote(file); });
      modal.open();
    };

    this.addCommand({ id: 'insert-fusion-params-template', name: 'Insert Fusion Params template', editorCallback: insertTemplate });
    this.addCommand({
      id: 'import-fusion-params-json',
      name: 'Import Fusion Params from JSON',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (checking) return true;
        openImportModal();
        return true;
      }
    });
    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor, view) => {
      menu.addItem((item) => item.setTitle('Insert Fusion Params template').setIcon('plus').onClick(()=>insertTemplate(editor, view)));
      menu.addItem((item) => item.setTitle('Import Fusion Params from JSON').setIcon('upload').onClick(() => openImportModal()));
    }));

    // Processor
    this.registerMarkdownCodeBlockProcessor('fusion-params', async (src, el, ctx) => {
      try {
        while (el.firstChild) el.removeChild(el.firstChild);

        const parsed = parseBlock(src);
        const json = toJson(parsed, this.settings.defaultUnit);

        // Status (centered, multiline) shown ABOVE the table
        const status = el.createEl('div'); status.addClass('fusion-params-status');
        const section = ctx.getSectionInfo(el);
        const file = this.app.workspace.getActiveFile();

        // Write base JSON
        const baseJson = {
          design: json.design,
          defaultUnit: json.defaultUnit,
          parameters: json.parameters.map(p => {
            const entry = { name: p.name };
            if ('expression' in p) entry.expression = p.expression;
            else {
              entry.value = p.value;
              if (p.unit !== undefined) entry.unit = p.unit;
            }
            if (p.comment !== undefined) entry.comment = p.comment;
            return entry;
          })
        };
        const outRelPath = joinVaultPath(this.settings.outputFolder, `${json.design}.json`);
        const pretty = JSON.stringify(baseJson, null, 2);
        const prettyHash = hashString(pretty);
        const changed = await writeIfChanged(this.app.vault.adapter, outRelPath, pretty);

        const now = Date.now();
        const recent = recentExports.get(outRelPath);
        const existingSources = recent?.sources instanceof Set
          ? new Set(recent.sources)
          : new Set(recent?.source ? [recent.source] : []);
        const blockKey = `${ctx.sourcePath || file?.path || ''}#${section?.lineStart ?? ''}`;
        const hadOtherSources = existingSources.size > 0 && !existingSources.has(blockKey);
        existingSources.add(blockKey);
        const sharedOutput = existingSources.size > 1;

        const setStatus = (label, opts = {}) => {
          status.setText(`${label}\n→ ${outRelPath}`);
          if (opts.error) status.addClass('fusion-params-status-error');
          else status.removeClass('fusion-params-status-error');
        };
        const sharedLabel = (label) => sharedOutput ? `${label} (shared output path)` : label;
        const sharedOpts = sharedOutput ? { error: true } : {};

        if (changed) {
          setStatus(sharedLabel('Updated'), sharedOpts);
          setTimeout(() => setStatus(sharedLabel('No changes pending'), sharedOpts), 3000);
        } else if (recent && (now - recent.t) < 4000) {
          setStatus(sharedLabel('Updated just now'), sharedOpts);
          setTimeout(() => setStatus(sharedLabel('No changes pending'), sharedOpts), 2500);
        } else {
          const label = hadOtherSources ? 'Awaiting other block' : 'No changes pending';
          setStatus(sharedLabel(label), sharedOpts);
        }
        recentExports.set(outRelPath, { hash: prettyHash, t: now, source: blockKey, sources: existingSources });
        if (this.settings.alwaysNotify) new Notice(status.textContent);

        // Two-way writeback + render UI
        const applyWriteback = async (getState) => {
          if (!file || !section) return;
          const state = getState();
          if (state?.errors && state.errors.length) {
            const first = state.errors[0];
            const issue = (first.issues && first.issues[0] && first.issues[0].message) ? first.issues[0].message : 'Invalid value';
            const label = first.name && first.name !== '(unnamed)' ? `${first.name}: ${issue}` : issue;
            setStatus(`Validation errors: ${label}`, { error: true });
            if (this.settings.alwaysNotify) new Notice(`Validation errors: ${label}`);
            return;
          }

          const newParams = state.params;
          const updatedJson = { ...json, parameters: newParams };
          const newBlock = fromJsonToBlock(updatedJson);
          const data = await this.app.vault.read(file);
          const next = safeReplaceSection(data, section.lineStart, section.lineEnd, newBlock);
          if (next.trim() === data.trim()) {
            setStatus('No changes pending');
            return;
          }
          await this.app.vault.modify(file, next);
          setStatus('Note updated');
          setTimeout(() => setStatus('No changes pending'), 2000);
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
