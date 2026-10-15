const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
require('../scripts/register-typescript.cjs');
const { currentSearchRows, rankInstrumentResults, searchKey } = require('../src/features/chart/searchState.ts');
const { pineDependencies, isPineLibrary, dependencyFromError, dependencyFields } = require('../src/features/pine/dependencies.ts');

function dockFixture() {
  let counter = 0, panels = [], activePanel;
  const app = { activeChartId: 'saved', layoutUndoAvailable: false, setActiveChart(id) { this.activeChartId = id; } };
  const original = { id: 'saved', symbol: 'COINBASE:SOL-USD', tf: '5m', style: 'area', group: null, indicators: [{ id: 'ma', kind: 'builtin', type: 'sma', inputs: { length: 42 } }], comparisons: ['COINBASE:ETH-USD'], scale: 'log', replayCursor: 18, backtestId: 'backtest' };
  const chartState = { charts: { saved: structuredClone(original) }, createChart(init) { const id = `new-${++counter}`; this.charts[id] = { id, indicators: [], ...init }; return id; } };
  const workspace = { id: 'work', name: 'My work', layout: null, preset: 'research', updatedAt: 1 };
  const workspaces = { activeId: 'work', workspaces: [workspace], setChartOrder(id, value) { this.workspaces.find(w => w.id === id).chartOrder = value; }, save(id, value, factor) { this.workspaces.find(w => w.id === id)[factor === 'mobile' ? 'mobileLayout' : 'layout'] = value; } };
  workspaces.save = workspaces.save.bind(workspaces);
  const store = { useApp: { getState: () => app, setState: p => Object.assign(app, p) }, useCharts: { getState: () => chartState, setState: p => Object.assign(chartState, p) }, useWorkspaces: { getState: () => workspaces } };
  const api = {
    get panels() { return panels; }, get activePanel() { return activePanel; },
    addPanel(options) { const p = { ...options, api: { setActive() { activePanel = p; }, setTitle(t) { p.title = t; } } }; panels.push(p); activePanel = p; return p; },
    getPanel(id) { return panels.find(p => p.id === id); }, clear() { panels = []; activePanel = undefined; },
    toJSON() { return { panels: panels.map(({ id, component, params, title }) => ({ id, component, params: structuredClone(params), title })), active: activePanel?.id }; },
    fromJSON(layout) { this.clear(); layout.panels.forEach(p => this.addPanel(p)); this.getPanel(layout.active)?.api.setActive(); },
  };
  api.addPanel({ id: 'old-panel', component: 'chart', params: { component: 'chart', chartId: 'saved' }, title: 'SOL' });
  const context = { exports: {}, require: name => name.endsWith('/store') ? store : require('../src/features/workspace/layoutCharts.ts'), window: { innerWidth: 1366 }, structuredClone, setTimeout: () => 0 };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(fs.readFileSync('src/features/workspace/dock.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  context.exports.setDockApi(api);
  return { dock: context.exports, app, chartState, workspaces, workspace, api, original };
}
test('actual grid application preserves chart identity/settings and restores all six hidden charts', () => {
  const h = dockFixture();
  h.dock.applyPreset('charts6');
  const six = h.dock.visibleChartIds();
  assert.equal(six.length, 6);
  assert.equal(six[0], 'saved');
  assert.deepEqual(h.chartState.charts.saved, h.original);
  h.dock.applyPreset('charts1');
  assert.deepEqual([...h.dock.visibleChartIds()], ['saved']);
  assert.equal(Object.keys(h.chartState.charts).length, 6);
  assert.equal(h.workspace.chartOrder.length, 6);
  h.dock.applyPreset('charts6');
  assert.deepEqual([...h.dock.visibleChartIds()], [...six]);
  assert.deepEqual(h.chartState.charts.saved, h.original);
});
test('shrinking retains the active chart, including after a persisted layout is restored', () => {
  const h = dockFixture(); h.dock.applyPreset('charts6');
  const last = h.dock.visibleChartIds().at(-1);
  h.app.activeChartId = last;
  h.dock.applyPreset('charts1');
  assert.equal(h.dock.visibleChartIds()[0], last);
  h.dock.loadWorkspace('work');
  h.dock.applyPreset('charts6');
  assert.equal(h.dock.visibleChartIds()[0], last);
  assert.equal(Object.keys(h.chartState.charts).length, 6);
});
test('template replacement has real undo and separate research charts remain independent', () => {
  const h = dockFixture(); h.dock.applyPreset('charts4');
  const before = [...h.dock.visibleChartIds()];
  h.dock.replaceWorkspaceTemplate('research');
  assert.equal(h.app.layoutUndoAvailable, true);
  const research = h.dock.visibleChartIds();
  assert.equal(new Set(research).size, 4);
  assert.equal(h.chartState.charts[research[0]].tf, '1D');
  assert.equal(h.chartState.charts[research[1]].tf, '1H');
  assert(!research.includes('saved'));
  h.dock.undoWorkspaceTemplate();
  assert.deepEqual([...h.dock.visibleChartIds()], before);
  assert.deepEqual(h.chartState.charts.saved, h.original);
  assert.equal(h.app.layoutUndoAvailable, false);
});
test('a newly created workspace does not borrow the previous workspace chart IDs', () => {
  const h = dockFixture(); h.dock.saveCurrentWorkspace();
  h.workspaces.workspaces.push({ id: 'second', name: 'Second', layout: null, preset: 'charts1', updatedAt: 1 });
  h.workspaces.activeId = 'second'; h.dock.loadWorkspace('second');
  assert(!h.dock.visibleChartIds().includes('saved'));
  assert.deepEqual(h.chartState.charts.saved, h.original);
});
test('debouncing, in-flight and different-provider search results cannot be selected', () => {
  const old = { key: searchKey('AAPL', 'yahoo'), rows: [{ symbol: 'YAHOO:AAPL' }], loading: false };
  assert.deepEqual(currentSearchRows(old, searchKey('SOL', 'coinbase')), []);
  assert.deepEqual(currentSearchRows(old, searchKey('AAPL', 'alpaca')), []);
  assert.deepEqual(currentSearchRows({ ...old, loading: true }, old.key), []);
  assert.equal(currentSearchRows(old, old.key)[0].symbol, 'YAHOO:AAPL');
});
test('exact provider ticker outranks exchange-suffixed and prefix matches without hiding them', () => {
  const rows = [{ symbol: 'YAHOO:VOO.MX', providerSymbol: 'VOO.MX' }, { symbol: 'YAHOO:TVOO', providerSymbol: 'TVOO' }, { symbol: 'YAHOO:VOOG', providerSymbol: 'VOOG' }, { symbol: 'YAHOO:VOO', providerSymbol: 'VOO' }];
  assert.deepEqual(rankInstrumentResults(rows, ' voo ').map(r => r.symbol), ['YAHOO:VOO', 'YAHOO:VOO.MX', 'YAHOO:VOOG', 'YAHOO:TVOO']);
  assert.equal(rankInstrumentResults([{ symbol: 'ALPACA:iex:VOO' }, rows[0]], 'VOO')[0].symbol, 'ALPACA:iex:VOO');
  assert.equal(rows[0].symbol, 'YAHOO:VOO.MX');
});
test('dependency discovery ignores comments/string literals and preserves real source line numbers', () => {
  const source = '// import fake/Comment/1\nindicator("import fake/String/2")\n/*\nimport fake/Block/1\n*/\nimport RealAuthor/Math/12 as math\nlabel.new(0, 0, "library(abc)")';
  assert.deepEqual(pineDependencies(source), [{ reference: 'RealAuthor/Math/12', line: 6 }]);
  assert.equal(isPineLibrary(source), false);
  assert.equal(isPineLibrary('//@version=6\nlibrary("Real")\nexport one() => 1'), true);
  const ref = dependencyFromError('Missing locked local Pine library Other/Transitive/2');
  assert.deepEqual(dependencyFields(ref), { publisher: 'Other', name: 'Transitive', version: 2 });
  assert.equal(dependencyFields('../invalid'), undefined);
});
test('paper selection navigates out of Scripts and targets the created strategy ledger', () => {
  const state = { view: 'library', paperSessionId: null }; const calls = [];
  const context = { exports: {}, require: name => name.endsWith('/store') ? { useApp: { setState: p => Object.assign(state, p) } } : { openPanel: (...args) => calls.push(args) } };
  vm.createContext(context);
  vm.runInContext(ts.transpileModule(fs.readFileSync('src/service/paperSelection.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
  context.exports.showPaperSession('created-session');
  assert.equal(state.view, 'workspace'); assert.equal(state.paperSessionId, 'created-session');
  assert.equal(calls[0][0], 'positions');
});
