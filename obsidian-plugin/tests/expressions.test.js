const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Load the shipped no-build plugin with a small Obsidian/DOM test double.
// Tests exercise the real helpers and table handlers without adding runtime exports.
class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.classes = new Set();
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.textContent = '';
  }
  createEl(tag, opts = {}) {
    const child = new Element(tag);
    if (opts.type) child.setAttr('type', opts.type);
    if (opts.value !== undefined) child.value = opts.value;
    if (opts.text !== undefined) child.setText(opts.text);
    if (opts.cls) child.addClass(opts.cls);
    for (const [key, value] of Object.entries(opts.attr || {})) child.setAttr(key, value);
    return this.appendChild(child);
  }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  insertBefore(child, next) {
    child.parent = this;
    this.children.splice(this.children.indexOf(next), 0, child);
    return child;
  }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1]; }
  get lastElementChild() { return this.children.at(-1); }
  setAttr(key, value) { this.attrs[key] = String(value); }
  getAttr(key) { return this.attrs[key]; }
  removeAttribute(key) { delete this.attrs[key]; }
  addClass(cls) { this.classes.add(cls); }
  removeClass(cls) { this.classes.delete(cls); }
  setText(text) { this.textContent = text; }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  async fire(type, event = {}) {
    for (const listener of this.listeners[type] || []) {
      await listener({ target: this, preventDefault() {}, ...event });
    }
  }
  querySelector(selector) {
    const tag = selector.match(/^\w+/)?.[0];
    const attrs = [...selector.matchAll(/\[([^=\]]+)="([^"]*)"\]/g)];
    for (const child of this.children) {
      if ((!tag || child.tag === tag) && attrs.every(([, key, value]) => child.attrs[key] === value)) return child;
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  focus() {}
  scrollIntoView() {}
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}

let clipboard = '';
const context = vm.createContext({
  module: { exports: {} },
  require(name) {
    assert.equal(name, 'obsidian');
    return { Plugin: class {}, PluginSettingTab: class {}, Modal: class {}, Notice: class {}, setIcon() {} };
  },
  document: { createElement: tag => new Element(tag), activeElement: null },
  navigator: { clipboard: { async writeText(text) { clipboard = text; } } },
  setTimeout,
  console
});
const source = readFileSync(join(__dirname, '..', 'main.js'), 'utf8');
vm.runInContext(source, context, { filename: 'main.js' });
const { analyzeValue, parseBlock, toJson, fromJsonToBlock, normalizeImportedJsonPayload, renderTableEditable } =
  vm.runInContext('({ analyzeValue, parseBlock, toJson, fromJsonToBlock, normalizeImportedJsonPayload, renderTableEditable })', context);
const plain = value => JSON.parse(JSON.stringify(value));

// Comma forms reported in PR #1 must be preserved. Autodesk documents semicolons
// for Design parameters and one-argument round(); Fusion validates function arity.
const expressions = [
  'max(width, height)', 'round(value, 3)', 'min(max(width, height), depth)',
  'max(width; height)', 'min(max(width; height); depth)', 'pow(width; 2)',
  'round(value)', 'random()', '2*width', '2/width', '2+3', '2-3', '2^3',
  'width ^ 2', 'width % 3', 'sin(30 deg)', 'sin(30°)', '1e-3 * width', '2 mm^2',
  '(width + height) / 2', '-width', '+width',
  'if(width > height; width; height)', 'if(width < height; width; height)',
  'if(width >= height; width; height)', 'if(width <= height; width; height)',
  'if(width == height; width; height)', 'if(width <> height; width; height)',
  'if((width < 400 mm) and (height < 400 mm); 12 mm; 18 mm)',
  'max (width, -height)', 'max(width; +height)'
];
for (const expression of expressions) {
  test(`accept and preserve expression: ${expression}`, () => {
    assert.deepEqual(plain(analyzeValue(expression, '')), {
      ok: true, param: { kind: 'expression', expression }
    });
    const json = toJson(parseBlock(`part: Test\nunits: mm\nparams:\n  result: ${expression} # retained comment`));
    assert.equal(json.parameters[0].expression, expression);
    assert.equal(json.parameters[0].comment, 'retained comment');
  });
}

const invalid = [
  ['', 'Value required'], ['1e309', 'Invalid number'], ['1e309 mm', 'Invalid number'], ['1 2', 'Invalid number'],
  ['max(width, height', 'Unbalanced parentheses'], ['width) + (height', 'Unbalanced parentheses'],
  ['width +', 'Ends with operator'], ['width^', 'Ends with operator'], ['width %', 'Ends with operator'],
  ['width >=', 'Ends with operator'], ['*width', 'Starts with operator'], ['^width', 'Starts with operator'],
  ['%width', 'Starts with operator'], ['>width', 'Starts with operator'],
  ['width # comment', 'Unsupported character'], ['width@height', 'Unsupported character'], ['10@mm', 'Unsupported character'],
  ['width[0]', 'Unsupported character'], ['{width}', 'Unsupported character'],
  ['"width"', 'Unsupported character'], ["'width'", 'Unsupported character'],
  ['width | height', 'Unsupported character'], ['width & height', 'Unsupported character'],
  ['width: height', 'Unsupported character'], ['width ? height', 'Unsupported character'],
  ['width, height', 'Invalid argument separator'], ['width; height', 'Invalid argument separator'],
  ['(width, height)', 'Invalid argument separator'], ['max(,width)', 'Invalid argument separator'],
  ['max(width,)', 'Invalid argument separator'], ['max(width,,height)', 'Invalid argument separator'],
  ['max(width; ;height)', 'Invalid argument separator'], ['max(width+, height)', 'Invalid argument separator']
];
for (const [value, message] of invalid) {
  test(`reject invalid value: ${JSON.stringify(value)}`, () => {
    assert.deepEqual(plain(analyzeValue(value, '')), { ok: false, field: 'value', message });
  });
}

test('numeric and inline-unit parsing stay consistent with Markdown export', () => {
  for (const [input, value, unit] of [
    ['0', 0, null], ['-2.5', -2.5, null], ['+.5', 0.5, null], ['1e-3', 0.001, null],
    ['25mm', 25, 'mm'], ['-2.5 in', -2.5, 'in'], ['30°', 30, '°'], ['1e3 mm', 1000, 'mm']
  ]) {
    const result = analyzeValue(input, '');
    assert.deepEqual(plain(result), { ok: true, param: { kind: 'number', value, unit, explicitUnit: !!unit } });
    const param = toJson(parseBlock(`part: Test\nunits: cm\nparams:\n  result: ${input}`)).parameters[0];
    assert.equal(param.value, value);
    assert.equal(param.unit, unit || 'cm');
  }
  assert.equal(analyzeValue('25', 'mm').param.unit, 'mm');
  assert.deepEqual(plain(analyzeValue('25 mm', 'cm')), { ok: false, field: 'unit', message: 'Move unit to a single column' });
  assert.deepEqual(plain(analyzeValue('max(width, height)', 'mm')), { ok: false, field: 'unit', message: 'Expressions cannot use Unit column' });
  assert.deepEqual(plain(analyzeValue('25', 'm m')), { ok: false, field: 'unit', message: 'Unit may not contain spaces' });
  for (const value of ['Infinity', '-Infinity', '1e309', '1e309 mm']) {
    const param = toJson(parseBlock(`part: Test\nparams:\n  result: ${value}`)).parameters[0];
    assert.equal(param.expression, value, 'non-finite numbers must not serialize as null');
  }
});

function render(json, showUnits = true, enableTolerance = true) {
  const root = new Element('div');
  let state;
  renderTableEditable(root, json, {
    sortAZ: false, showUnits, enableTolerance, tolDefaults: { value: 0.2, unit: 'mm' },
    tolShowEquation: false, tolRounding: 3
  }, getState => { state = getState(); });
  return { root, rows: root.querySelector('tbody').children, state: () => state };
}
const field = (row, key) => row.querySelector(`input[data-key="${key}"]`);
const save = row => row.querySelector('span[aria-label="Save row"]').fire('click');

for (const showUnits of [true, false]) {
  test(`JSON import -> table save -> Markdown -> JSON preserves expressions (units=${showUnits})`, async () => {
    const payload = { design: 'Test', defaultUnit: 'mm', parameters: expressions.map((expression, i) => ({
      name: `result_${i}`, expression, comment: `comment ${i}`
    })) };
    const imported = normalizeImportedJsonPayload(payload, 'mm', 'Fallback');
    const block = fromJsonToBlock(imported);
    const json = toJson(parseBlock(block));
    const view = render(json, showUnits);
    for (const row of view.rows) {
      assert.equal(field(row, 'value').getAttr('aria-invalid'), undefined);
      assert.equal(field(row, 'tol').disabled, true);
    }
    await save(view.rows[0]);
    assert.deepEqual(plain(view.state().errors), []);
    const saved = toJson(parseBlock(fromJsonToBlock({ ...json, parameters: view.state().params })));
    assert.deepEqual(plain(saved.parameters.map(({ name, expression, comment }) => ({ name, expression, comment }))), payload.parameters);
    await view.root.querySelector('div[aria-label="Copy CSV"]').fire('click');
    assert.ok(clipboard.includes('"max(width, height)"'), 'CSV quotes comma-containing expressions');
  });
}

test('table edit clears validation and saves a multiargument expression', async () => {
  const view = render({ design: 'Test', defaultUnit: 'mm', parameters: [{ name: 'result', value: 10 }] });
  const row = view.rows[0];
  const input = field(row, 'value');
  input.value = 'max(width,)';
  await input.fire('input');
  await save(row);
  assert.equal(input.getAttr('aria-invalid'), 'true');
  assert.equal(view.state().errors.length, 1);
  assert.equal(view.state().params.length, 0);
  input.value = 'max(width, height)';
  await input.fire('input');
  field(row, 'comment').value = 'keep this';
  await save(row);
  assert.equal(input.getAttr('aria-invalid'), undefined);
  assert.equal(view.state().errors.length, 0);
  assert.equal(view.state().params[0].expression, input.value);
  assert.equal(view.state().params[0].comment, 'keep this');
});

test('name, required-value, and unit validation still block table saves', async () => {
  const view = render({ design: 'Test', defaultUnit: 'mm', parameters: [{ name: 'result', value: 10 }] });
  const row = view.rows[0];
  for (const [name, value, unit, invalidField] of [
    ['2bad', '10', '', 'name'], ['', '10', '', 'name'], ['result', '', '', 'value'],
    ['result', 'max(width, height)', 'mm', 'unit'], ['result', '10', 'm m', 'unit']
  ]) {
    field(row, 'name').value = name;
    field(row, 'value').value = value;
    field(row, 'unit').value = unit;
    await save(row);
    assert.ok(view.state().errors.length);
    assert.equal(field(row, invalidField).getAttr('aria-invalid'), 'true');
  }
});

test('Enter saves a comma expression and inserts the next row', async () => {
  const view = render({ design: 'Test', defaultUnit: 'mm', parameters: [{ name: 'result', expression: 'width' }] });
  const input = field(view.rows[0], 'value');
  input.value = 'max(width, height)';
  await input.fire('keydown', { key: 'Enter' });
  assert.equal(view.state().errors.length, 0);
  assert.equal(view.state().params[0].expression, input.value);
  assert.equal(view.rows.length, 2);
});
