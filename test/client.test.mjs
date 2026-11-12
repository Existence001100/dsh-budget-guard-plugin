import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Config } from '../lib/index.js';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

// Minimal React surface: the module only creates elements and calls hooks.
const React = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props || {}), children } };
  },
  useState(initial) {
    const record = (next) => {
      if (globalThis.__BUDGET_SET_VALUES__) globalThis.__BUDGET_SET_VALUES__.push(next);
    };
    if (initial === null && globalThis.__BUDGET_STATE__ && globalThis.__BUDGET_FIXTURE_ARMED__) {
      globalThis.__BUDGET_FIXTURE_ARMED__ = false;
      return [globalThis.__BUDGET_STATE__, record];
    }
    // Arm the composer panel's "expanded" flag so the details box renders.
    if (initial === false && globalThis.__BUDGET_OPEN_ARMED__) {
      globalThis.__BUDGET_OPEN_ARMED__ = false;
      return [true, record];
    }
    return [typeof initial === 'function' ? initial() : initial, record];
  },
  useEffect() {},
  useMemo(factory) {
    return factory();
  },
  useRef(value) {
    return { current: value };
  },
};

new Function('window', source)(globalThis.window);
assert.ok(loaded, 'client bundle called __ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-budget-guard-plugin');

const plugin = loaded.factory((specifier) => {
  assert.equal(specifier, 'react');
  return React;
});

const injections = [];
const registrations = [];
const ctx = {
  slots: {
    inject(slot, callback) {
      injections.push(slot);
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  },
};

plugin.apply(ctx);
assert.deepEqual(injections, ['conversation.chat.turnTail', 'conversation.composer.dock', 'settings.section']);
assert.equal(registrations.length, 3);
assert.equal(registrations[0].options.id, 'budget-turn-estimate');
assert.equal(registrations[1].options.id, 'budget-status');
assert.equal(registrations[2].options.id, 'budget-guard');

// All components must be renderable functions; with no fetched state they
// return null rather than throwing.
assert.equal(typeof registrations[0].component, 'function');
assert.equal(typeof registrations[1].component, 'function');
assert.equal(typeof registrations[2].component, 'function');
assert.equal(registrations[0].component({ sessionId: 's', seq: 1 }), null);
assert.equal(registrations[1].component({ sessionId: 's' }), null);

// With a state fixture the same components must build their markup.
globalThis.__BUDGET_STATE__ = {
  sessionId: 's',
  configured: true,
  running: true,
  config: {
    currency: 'CNY',
    interceptMode: 'manual',
    warnRatio: 0.8,
    interceptRatio: 0.95,
    estimateOutput: 'both',
    enableTurnEstimate: true,
  },
  budget: { amount: 2, tokens: 0, currency: 'CNY', label: '¥2.00', amountLabel: '¥2.00', tokenLabel: null },
  used: {
    cost: 1.15,
    costLabel: '¥1.15',
    shadowCost: 0.35,
    shadowCostLabel: '¥0.35',
    effectiveCost: 1.5,
    effectiveCostLabel: '¥1.50',
    tokens: 18000,
    tokenLabel: '18.0k tokens',
    percent: 58,
  },
  pricing: {
    unknownTokens: 3000,
    unknownModels: { mystery: 1 },
    protectionAtRisk: true,
    shadowCost: 0.35,
    sources: ['内置默认'],
    holidaysSource: 'default',
  },
  estimate: {
    source: 'model_plan',
    basis: 'model-plan',
    progressBasis: 'plan',
    endSeq: 10,
    progressPercent: 60,
    remainingSteps: 4,
    remainingTurns: 1,
    remainingCost: 0.85,
    remainingCostLabel: '¥0.85',
    remainingTokens: 18000,
    projectedCost: 2,
    projectedCostLabel: '¥2.00',
    projectedTokens: 36000,
    recentAvgCost: 0.5,
    recentAvgCostLabel: '¥0.50',
    recentAvgTokens: 10000,
    recentSamples: 1,
    recentUnit: 'turn',
    overBudget: false,
    text: '预算进度（模型计划，仅供参考）：已完成约 60%',
    turn: 2,
  },
  warning: { level: 'warn', text: '预算预警' },
  manual: { pending: true, continues: 0, text: '已消耗 ¥1.15 / ¥2.00，是否继续？' },
};

function renderWithFixture(component, props) {
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  return component(props);
}

// Fake React keeps nested function components as element nodes; expand them so
// assertions can see what a real render tree would contain.
function flatten(node) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(flatten);
  if (typeof node.type === 'function') return flatten(node.type(node.props || {}));
  const props = { ...node.props };
  if (Array.isArray(props.children)) props.children = props.children.map(flatten);
  return { type: node.type, props };
}

function text(node) {
  return JSON.stringify(flatten(node));
}

/** Find the first element in a (flattened) tree that matches `predicate`. */
function findElement(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (predicate(node)) return node;
  const children = node.props && node.props.children;
  return Array.isArray(children) ? findElement(children, predicate) : findElement(children, predicate);
}

function buttonWithLabel(node, label) {
  return findElement(flatten(node), (element) => {
    if (element.type !== 'button') return false;
    return JSON.stringify(element.props.children || []).includes(label);
  });
}

const card = renderWithFixture(registrations[0].component, { sessionId: 's', seq: 10 });
assert.equal(card.type, 'div');
assert.match(text(card), /判定 ¥1\.50/);
assert.match(text(card), /预计还需 4 步/);
assert.match(text(card), /（模型计划，仅供参考）/);

// No stated plan: the card must show observed burn, never a prediction.
{
  const previous = globalThis.__BUDGET_STATE__.estimate;
  globalThis.__BUDGET_STATE__.estimate = {
    ...previous,
    source: 'recent',
    basis: 'recent',
    progressBasis: 'budget',
    remainingSteps: null,
    remainingTurns: null,
    remainingCost: null,
    remainingCostLabel: null,
    remainingTokens: null,
    projectedCost: null,
    projectedCostLabel: null,
    projectedTokens: null,
    overBudget: false,
    progressPercent: 20,
    recentAvgCost: 0.02,
    recentAvgCostLabel: '¥0.02',
    recentAvgTokens: 5000,
    recentSamples: 1,
    recentUnit: 'turn',
    text: '预算进度（近期）：近期消耗：约 ¥0.02 / 5.0k tokens 每轮。不预测未来消耗。',
  };
  const recent = text(renderWithFixture(registrations[0].component, { sessionId: 's', seq: 10 }));
  assert.match(recent, /近期消耗：约 ¥0\.02 \/ 5,000 tokens 每轮/);
  assert.doesNotMatch(recent, /预计还需/, 'no plan must not render a remaining-steps prediction');
  assert.doesNotMatch(recent, /预计合计/);
  globalThis.__BUDGET_STATE__.estimate = previous;
}

// estimateOutput=sidebar WITHOUT the right-column service keeps the card: the
// estimate must never disappear just because a bundle is missing.
{
  globalThis.__BUDGET_STATE__.config.estimateOutput = 'sidebar';
  const fallback = renderWithFixture(registrations[0].component, { sessionId: 's', seq: 10 });
  assert.equal(fallback.type, 'div', 'sidebar fallback still renders the chat card');
  assert.match(text(fallback), /预计还需 4 步/);
}

// The composer panel with the details box open (armed by __BUDGET_OPEN_ARMED__).
globalThis.__BUDGET_STATE__.config.estimateOutput = 'chat';
globalThis.__BUDGET_STATE__.counters = {
  blockedSettlements: 2,
  settledOverflow: false,
  stepCharges: 3,
  settledCharges: 120,
  lastSeq: 431,
  settledSeqWatermark: 428,
};
globalThis.__BUDGET_FIXTURE_ARMED__ = true;
globalThis.__BUDGET_OPEN_ARMED__ = true;
const opened = registrations[1].component({ sessionId: 's' });
assert.equal(opened.type, 'div');
const openedText = text(opened);
assert.match(openedText, /费用明细/);
assert.match(openedText, /设置本次预算/);
assert.doesNotMatch(openedText, /在右侧栏打开/, 'no right-column entry until the service is present');
// P1-5: settlement health is visible in the panel, not only in the log.
assert.match(openedText, /有 2 次结算因明细过期被拒绝（历史累计）/, 'blocked settlements are surfaced as a lifetime count');
assert.match(openedText, /120 条已结算 · lastSeq 431/, 'the replay watermark is surfaced');
assert.match(openedText, /结算水位/, 'the settlement watermark has a diagnostic row');
assert.match(openedText, /428（日志领先 3 条事件）/, 'the gap to lastSeq is shown');

// After a budget stop the composer must offer a way out, not a dead end.
{
  const previous = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    ...previous,
    manual: { ...previous.manual, pending: false },
    guard: { disabled: false, stopped: true, canResume: true, canUnlock: true, lastStopAt: Date.now(), lastStopKind: 'auto' },
  };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const recovery = text(registrations[1].component({ sessionId: 's' }));
  assert.match(recovery, /本轮已因预算中止/, 'the stop is announced');
  assert.match(recovery, /继续 \(\+10%\)/, 'resume is offered');
  assert.match(recovery, /解除限制/, 'unlock is offered');

  globalThis.__BUDGET_STATE__ = { ...previous, manual: { ...previous.manual, pending: false }, guard: { disabled: true, stopped: false } };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const lifted = text(registrations[1].component({ sessionId: 's' }));
  assert.match(lifted, /已解除限制/, 'the lifted state is visible on the pill');
  assert.doesNotMatch(lifted, /本轮已因预算中止/, 'and the recovery row is gone');
  globalThis.__BUDGET_STATE__ = previous;
}

// A freshly reset session has folded no events yet: show 0, never a negative.
{
  const previousCounters = globalThis.__BUDGET_STATE__.counters;
  globalThis.__BUDGET_STATE__.counters = { ...previousCounters, lastSeq: -1, settledSeqWatermark: 0 };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  globalThis.__BUDGET_OPEN_ARMED__ = true;
  const fresh = text(registrations[1].component({ sessionId: 's' }));
  assert.match(fresh, /lastSeq 0/, 'a reset session shows lastSeq 0');
  assert.doesNotMatch(fresh, /lastSeq -1/, 'never a negative lastSeq');
  assert.doesNotMatch(fresh, /领先 -/, 'never a negative gap');
  globalThis.__BUDGET_STATE__.counters = previousCounters;
}

// P2-5: the client money formatter matches the Host boundaries.
for (const [value, expected] of [
  [0, '¥0.00'],
  [0.00005, '<¥0.0001'],
  [0.0001, '¥0.0001'],
  [0.001, '¥0.0010'],
  [0.01, '¥0.010'],
  [0.1, '¥0.10'],
  [0.3, '¥0.30'],
]) {
  const previousBreakdown = globalThis.__BUDGET_STATE__.used.breakdown;
  globalThis.__BUDGET_STATE__.used = {
    ...globalThis.__BUDGET_STATE__.used,
    breakdown: { inputMiss: value, inputHit: 0, output: 0 },
  };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  globalThis.__BUDGET_OPEN_ARMED__ = true;
  const rendered = text(registrations[1].component({ sessionId: 's' }));
  assert.ok(
    rendered.includes('输入（未命中）') && rendered.includes(expected),
    `client shows ${expected} for ${value}`,
  );
  globalThis.__BUDGET_STATE__.used.breakdown = previousBreakdown;
}

const dock = renderWithFixture(registrations[1].component, { sessionId: 's' });
assert.equal(dock.type, 'div');
assert.match(text(dock), /判定 ¥1\.50/, 'main line must show effective judgement with shadow');
assert.match(text(dock), /含未知估算/);

// All-zero budget behaves as "unset": no warning, no manual controls.
{
  const previous = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    ...previous,
    configured: false,
    warning: null,
    budget: { amount: 0, tokens: 0, currency: 'CNY', label: '未设置预算', amountLabel: null, tokenLabel: null },
    manual: { ...previous.manual, pending: false, suppressed: false, canContinue: false, text: null },
    guard: { disabled: false, stopped: false, canResume: false, canUnlock: false },
    estimate: {
      ...previous.estimate,
      source: 'recent',
      remainingSteps: null,
      remainingTurns: null,
      remainingCost: null,
      remainingCostLabel: null,
      remainingTokens: null,
      projectedCost: null,
      projectedCostLabel: null,
      projectedTokens: null,
      overBudget: false,
      recentAvgCost: 0.02,
      recentAvgCostLabel: '¥0.02',
      recentAvgTokens: 5000,
      recentUnit: 'turn',
    },
  };
  const unset = text(renderWithFixture(registrations[1].component, { sessionId: 's' }));
  assert.match(unset, /未设置预算/);
  assert.doesNotMatch(unset, /继续 \(\+10%\)/, 'no manual continue control without a budget');
  assert.doesNotMatch(unset, /预算预警/, 'no budget warning without a budget');

  // The estimate surfaces must say "no budget" too: a 0% bar labelled
  // "预算已用约 0%" after spending reads as "you used none of your budget".
  const unsetCard = text(renderWithFixture(registrations[0].component, { sessionId: 's', seq: 10 }));
  assert.match(unsetCard, /未设置预算 · 仅记录金额/);
  assert.doesNotMatch(unsetCard, /预算已用约/);
  assert.match(unsetCard, /"width":"0%"/, 'the progress bar is empty when there is no line');
  assert.match(unsetCard, /近期消耗：约 ¥0\.02/);
  globalThis.__BUDGET_STATE__ = previous;
}

// The settings page reads the Config route; feed it a Config-shaped fixture.
{
  const budgetFixture = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    interceptMode: 'manual',
    budgetAmount: 2.5,
    tokenBudget: 20000,
    currency: 'RMB',
    warnRatio: 0.85,
    interceptRatio: 0.9,
    enablePreEstimate: false,
    enableTurnEstimate: true,
    estimateOutput: 'both',
    turnEstimateMinInterval: 3000,
    enforceAtPreStep: true,
    unknownWarnRatio: 0.3,
    maxGrantedPercent: 20,
    manualHardStopRatio: 1.6,
    enableSnapshot: true,
    snapshotMaxSessions: 100,
    snapshotKeepTurns: 4,
    holidaysSource: 'config',
    priceSources: ['内置默认'],
    allowedOrigins: ['http://localhost:3000'],
  };
  const settings = renderWithFixture(registrations[2].component, { close: () => {} });
  assert.equal(settings.type, 'div');
  const settingsText = text(settings);
  assert.match(settingsText, /手动拦截/, 'the mode switch reflects Config');
  assert.match(settingsText, /拦截阈值/);
  assert.match(settingsText, /预估输出位置/);
  assert.match(settingsText, /保存全部设置/);
  assert.match(settingsText, /"value":"85"/, 'warnRatio renders as 85%');
  assert.match(settingsText, /"value":"90"/, 'interceptRatio renders as 90%');
  assert.match(settingsText, /"value":"RMB"/, 'currency select reflects Config');
  assert.match(settingsText, /CNY/);
  assert.match(settingsText, /RMB/);
  assert.doesNotMatch(settingsText, /USD|EUR|JPY|GBP/, 'only CNY/RMB are offered');
  assert.match(settingsText, /节假日：配置/);
  assert.match(settingsText, /仅本机可改设置/);
  assert.match(settingsText, /仅本机可操作本轮/, 'the /action switch is a separate row');
  globalThis.__BUDGET_STATE__ = budgetFixture;
}

// ── saving every setting sends ratios, not 1/100th ratios ─────────────────
{
  const previous = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    interceptMode: 'manual',
    budgetAmount: 2.5,
    tokenBudget: 20000,
    currency: 'RMB',
    warnRatio: 0.8,
    interceptRatio: 0.95,
    unknownWarnRatio: 0.2,
    maxGrantedPercent: 30,
    manualHardStopRatio: 1.5,
    enforceAtPreStep: true,
    enableTurnEstimate: true,
    enablePreEstimate: true,
    estimateOutput: 'both',
    turnEstimateMinInterval: 1500,
    enableSnapshot: true,
    snapshotMaxSessions: 200,
    snapshotMaxAgeDays: 30,
    snapshotKeepTurns: 8,
    perSessionMaxSettled: 2000,
    requireLocalControl: true,
    requireLocalAction: true,
    holidaysSource: 'default',
    priceSources: ['内置默认'],
    allowedOrigins: [],
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, applying: true }) };
  };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const page = registrations[2].component({ close: () => {} });
  const saveButton = buttonWithLabel(page, '保存全部设置');
  assert.ok(saveButton, 'the settings page exposes 保存全部设置');
  saveButton.props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.length, 1, 'one save request');
  const patch = calls[0].body;
  assert.equal(patch.warnRatio, 0.8, 'percent fields stay ratios');
  assert.equal(patch.interceptRatio, 0.95);
  assert.equal(patch.unknownWarnRatio, 0.2);
  assert.equal(patch.budgetAmount, 2.5);
  assert.equal(patch.currency, 'RMB');
  globalThis.fetch = originalFetch;
  globalThis.__BUDGET_STATE__ = previous;
}

// ── 0 is a valid default budget, and the UI saves it as 0 (not a fallback) ─
{
  const previous = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    interceptMode: 'auto',
    budgetAmount: 0,
    tokenBudget: 0,
    currency: 'CNY',
    warnRatio: 0.8,
    interceptRatio: 0.95,
    unknownWarnRatio: 0.2,
    maxGrantedPercent: 30,
    manualHardStopRatio: 1.5,
    enforceAtPreStep: true,
    enableTurnEstimate: true,
    enablePreEstimate: true,
    estimateOutput: 'both',
    turnEstimateMinInterval: 1500,
    enableSnapshot: true,
    snapshotMaxSessions: 200,
    snapshotMaxAgeDays: 30,
    snapshotKeepTurns: 8,
    perSessionMaxSettled: 2000,
    requireLocalControl: true,
    requireLocalAction: true,
    holidaysSource: 'default',
    priceSources: ['内置默认'],
    allowedOrigins: [],
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ ok: true, applying: true }) };
  };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const page = registrations[2].component({ close: () => {} });
  const flat = flatten(page);
  const amountInput = findElement(flat, (el) => el.type === 'input' && el.props['aria-label'] === '默认金额');
  const tokenInput = findElement(flat, (el) => el.type === 'input' && el.props['aria-label'] === '默认 Token');
  assert.ok(amountInput, 'the default amount input exists');
  assert.ok(tokenInput, 'the default token input exists');
  assert.equal(amountInput.props.value, '0', '0 renders as 0, not as a placeholder');
  assert.equal(tokenInput.props.value, '0');
  assert.equal(amountInput.props.min, 0, '0 is inside the input range');
  assert.equal(tokenInput.props.min, 0);
  buttonWithLabel(page, '保存全部设置').props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const patch = calls.at(-1).body;
  assert.equal(patch.budgetAmount, 0, 'saving zeros keeps zeros');
  assert.equal(patch.tokenBudget, 0);
  globalThis.fetch = originalFetch;
  globalThis.__BUDGET_STATE__ = previous;
}
{
  const previous = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    ...previous,
    manual: { ...previous.manual, pending: false },
    guard: { disabled: false, stopped: true, canResume: true, canUnlock: true, lastStopAt: Date.now(), lastStopKind: 'auto' },
  };
  globalThis.__BUDGET_SET_VALUES__ = [];
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const dock = registrations[1].component({ sessionId: 's' });
  const details = buttonWithLabel(dock, '查看明细');
  assert.ok(details, 'the recovery row offers 查看明细');
  details.props.onClick();
  assert.ok(globalThis.__BUDGET_SET_VALUES__.includes(true), '查看明细 expands the details panel');
  globalThis.__BUDGET_SET_VALUES__ = null;

  // The manual-mode action buttons are present and labelled.
  globalThis.__BUDGET_STATE__ = {
    ...previous,
    manual: { ...previous.manual, pending: true, canContinue: true, text: '已消耗 ¥1.15 / ¥2.00，是否继续？' },
    guard: { disabled: false, stopped: false },
  };
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  const manual = text(registrations[1].component({ sessionId: 's' }));
  assert.match(manual, /继续 \(\+10%\)/);
  assert.match(manual, /不再提示/);
  assert.match(manual, /中止/);
  globalThis.__BUDGET_STATE__ = previous;
}

// ── the right-column page is installed through dsh-better-sidebar ─────────
{
  globalThis.__BUDGET_STATE__.config.estimateOutput = 'both';
  const tabs = [];
  const effects = [];
  const before = registrations.length;
  const ctx2 = {
    slots: ctx.slots,
    inject(names, callback) {
      assert.deepEqual(names, ['betterSidebar']);
      callback({
        betterSidebar: {
          registerTab(descriptor) {
            tabs.push(descriptor);
            return () => {
              tabs.length = 0;
            };
          },
          openTab() {},
        },
        effect(factory) {
          effects.push(factory());
        },
      });
      return () => {};
    },
  };
  plugin.apply(ctx2);
  assert.equal(registrations.length, before + 3, 'slots are registered once more');
  assert.equal(tabs.length, 1);
  const tab = tabs[0];
  assert.equal(tab.id, 'budget-guard:estimate');
  assert.equal(tab.single, true);
  assert.equal(typeof tab.component, 'function');
  assert.equal(tab.title(), '预算与进度');
  assert.ok(tab.description().includes('剩余步数'));
  assert.equal(effects.length, 1, 'the tab registration is owned by an effect disposer');

  const panel = renderWithFixture(tab.component, { scope: { sessionId: 's' } });
  assert.equal(panel.type, 'div');
  const panelText = text(panel);
  assert.match(panelText, /预算进度/);
  assert.match(panelText, /预计还需 4 步/);
  assert.match(panelText, /（模型计划，仅供参考）/);
  assert.match(panelText, /费用明细/, 'the page carries the full breakdown');

  // The right-column page follows the same no-plan rule.
  const previousEstimate = globalThis.__BUDGET_STATE__.estimate;
  globalThis.__BUDGET_STATE__.estimate = {
    ...previousEstimate,
    source: 'recent',
    basis: 'recent',
    progressBasis: 'budget',
    remainingSteps: null,
    remainingTurns: null,
    remainingCost: null,
    remainingCostLabel: null,
    remainingTokens: null,
    projectedCost: null,
    projectedCostLabel: null,
    projectedTokens: null,
    overBudget: false,
    recentAvgCost: 0.02,
    recentAvgCostLabel: '¥0.02',
    recentAvgTokens: 5000,
    recentSamples: 1,
    recentUnit: 'turn',
  };
  const recentPanel = text(renderWithFixture(tab.component, { scope: { sessionId: 's' } }));
  assert.match(recentPanel, /近期消耗：约 ¥0\.02 \/ 5,000 tokens 每轮/);
  assert.doesNotMatch(recentPanel, /预计还需/);
  assert.doesNotMatch(recentPanel, /预计合计/);
  globalThis.__BUDGET_STATE__.estimate = previousEstimate;

  // With the service present the composer panel offers the right-column entry.
  globalThis.__BUDGET_FIXTURE_ARMED__ = true;
  globalThis.__BUDGET_OPEN_ARMED__ = true;
  const withSidebar = registrations[before + 1].component({ sessionId: 's' });
  assert.match(text(withSidebar), /在右侧栏打开/);
}

// ── the settings page shows the price section (its fetch is a hook) ───────
{
  const fixture = globalThis.__BUDGET_STATE__;
  globalThis.__BUDGET_STATE__ = {
    interceptMode: 'auto',
    budgetAmount: 0,
    tokenBudget: 0,
    currency: 'CNY',
    warnRatio: 0.8,
    interceptRatio: 0.95,
    unknownWarnRatio: 0.2,
    maxGrantedPercent: 30,
    manualHardStopRatio: 1.5,
    enforceAtPreStep: true,
    enableTurnEstimate: true,
    enablePreEstimate: true,
    estimateOutput: 'both',
    turnEstimateMinInterval: 1500,
    enableSnapshot: true,
    snapshotMaxSessions: 200,
    snapshotMaxAgeDays: 30,
    snapshotKeepTurns: 8,
    perSessionMaxSettled: 2000,
    requireLocalControl: true,
    requireLocalAction: true,
    holidaysSource: 'default',
    priceSources: ['内置默认', 'official-prices.json'],
    allowedOrigins: [],
  };
  const page = text(renderWithFixture(registrations[2].component, { close: () => {} }));
  assert.match(page, /模型价格/, 'the settings page carries a price section');
  assert.match(page, /正在读取模型价格…/, 'the price section loads independently of Config');
  globalThis.__BUDGET_STATE__ = fixture;
}

// ── the price table renders the merged rates and real edit boxes ──────────
{
  assert.equal(typeof plugin.priceTable, 'function', 'the price table is exposed for tests');
  const priceData = {
    currency: 'CNY',
    unit: 'CNY / 1M tokens',
    offpeakFactor: 0.5,
    localPath: 'C:\\Users\\me\\.dsh\\budget-guard\\local-prices.json',
    sources: ['内置默认', 'official-prices.json'],
    warnings: [],
    models: [
      {
        model: 'deepseek-flash',
        origin: 'official',
        custom: false,
        peak: { input_miss: 2, input_hit: 0.04, output: 8 },
        offpeak: { input_miss: 1, input_hit: 0.02, output: 4 },
      },
      {
        model: 'gpt-4o-local',
        origin: 'local',
        custom: true,
        peak: { input_miss: 3, input_hit: 0.3, output: 12 },
        offpeak: { input_miss: 1.5, input_hit: 0.15, output: 6 },
      },
    ],
  };
  const noop = () => {};
  const baseProps = {
    data: priceData,
    draft: {},
    editing: null,
    removing: [],
    adding: false,
    newName: '',
    busy: null,
    message: null,
    onEdit: noop,
    onCancelEdit: noop,
    onChange: noop,
    onToggleRemove: noop,
    onStartAdd: noop,
    onCancelAdd: noop,
    onNewName: noop,
    onSave: noop,
  };

  function collect(node, predicate, found = []) {
    if (!node || typeof node !== 'object') return found;
    if (Array.isArray(node)) {
      for (const child of node) collect(child, predicate, found);
      return found;
    }
    if (predicate(node)) found.push(node);
    const children = node.props && node.props.children;
    if (Array.isArray(children)) {
      for (const child of children) collect(child, predicate, found);
    } else if (children) {
      collect(children, predicate, found);
    }
    return found;
  }

  const view = text(plugin.priceTable(baseProps));
  assert.match(view, /deepseek-flash/);
  assert.match(view, /gpt-4o-local/);
  assert.match(view, /official/, 'an official row is labelled');
  assert.match(view, /用户自定义/, 'a local row is labelled');
  assert.match(view, /元 \/ 1M tokens/, 'the unit is stated');
  assert.match(view, /local-prices\.json/, 'the save target is named');
  assert.match(view, /保存价格/);
  assert.match(view, /添加新模型/);
  assert.match(view, /高峰/);
  assert.match(view, /空闲/);
  // Reading mode is figures, not inputs.
  assert.equal(collect(flatten(plugin.priceTable(baseProps)), (el) => el.type === 'input').length, 0);
  // Only the custom row offers 删除.
  assert.equal(buttonWithLabel(plugin.priceTable(baseProps), '删除') !== null, true);
  const nonCustomOnly = plugin.priceTable({
    ...baseProps,
    data: { ...priceData, models: [priceData.models[0]] },
  });
  assert.equal(buttonWithLabel(nonCustomOnly, '删除'), null, 'a built-in/official row cannot be deleted');

  // Editing one row turns exactly its six unit prices into inputs.
  const editing = flatten(
    plugin.priceTable({
      ...baseProps,
      editing: 'deepseek-flash',
      draft: {
        'deepseek-flash': {
          peak: { input_miss: '2', input_hit: '0.04', output: '9' },
          offpeak: { input_miss: '1', input_hit: '0.02', output: '4' },
        },
      },
    }),
  );
  const inputs = collect(editing, (el) => el.type === 'input');
  assert.equal(inputs.length, 6, 'three prices × two tiers');
  const labels = inputs.map((el) => el.props['aria-label']).join('|');
  assert.match(labels, /deepseek-flash 高峰 未命中/);
  assert.match(labels, /deepseek-flash 高峰 命中/);
  assert.match(labels, /deepseek-flash 高峰 输出/);
  assert.match(labels, /deepseek-flash 空闲 输出/);
  const outputInput = inputs.find((el) => el.props['aria-label'] === 'deepseek-flash 高峰 输出');
  assert.equal(outputInput.props.value, '9', 'the draft value is shown');
  // onEdit is wired to the row it belongs to, and editing swaps 编辑 for 取消.
  const seen = [];
  const viewEdit = buttonWithLabel(plugin.priceTable({ ...baseProps, onEdit: (model) => seen.push(model) }), '编辑');
  assert.ok(viewEdit, 'every row has 编辑');
  viewEdit.props.onClick();
  assert.deepEqual(seen, ['deepseek-flash'], '编辑 targets its own row');
  const cancelButton = buttonWithLabel(plugin.priceTable({ ...baseProps, editing: 'deepseek-flash' }), '取消');
  assert.ok(cancelButton, 'editing shows 取消');

  // The add form carries a name field plus the same six price inputs.
  const adding = flatten(plugin.priceTable({ ...baseProps, adding: true }));
  const nameInput = collect(adding, (el) => el.type === 'input' && el.props['aria-label'] === '新模型名称')[0];
  assert.ok(nameInput, 'a new model needs a name');
  assert.equal(nameInput.props.value, '');
  assert.equal(collect(adding, (el) => el.type === 'input' && el.props.type === 'number').length, 6);

  // A row marked for deletion is visibly pending and can be undone.
  const removing = text(plugin.priceTable({ ...baseProps, removing: ['gpt-4o-local'] }));
  assert.match(removing, /待删除/);
  assert.match(removing, /撤销/);

  // The success message is exactly the promised wording.
  const savedMessage =
    '价格已更新并生效。注意：历史账目不会自动重算，如需按新价重算本会话，请执行 /budget reset-snapshot';
  assert.match(text(plugin.priceTable({ ...baseProps, message: savedMessage })), /\/budget reset-snapshot/);
  const warningData = { ...priceData, warnings: ['deepseek-flash: offpeak.output 缺失'] };
  assert.match(text(plugin.priceTable({ ...baseProps, data: warningData })), /价格表提示 1 条/);
}

// ── the posted price payload is numbers only, blanks keep inheriting ──────
{
  assert.equal(typeof plugin.pricePayload, 'function');
  const payload = plugin.pricePayload(
    {
      'deepseek-flash': {
        peak: { input_miss: '2', input_hit: '0.04', output: '9' },
        offpeak: { input_miss: '', input_hit: '', output: '' },
      },
      __new__: { peak: { input_miss: '1', input_hit: '0.1', output: '2' }, offpeak: {} },
    },
    ['gpt-4o-old'],
    {
      name: ' gpt-4o-new ',
      entry: {
        peak: { input_miss: '1', input_hit: '0.1', output: '-1' },
        offpeak: { input_miss: '0.5', input_hit: '0.05', output: '1' },
      },
    },
  );
  assert.deepEqual(payload.models['deepseek-flash'], {
    peak: { input_miss: 2, input_hit: 0.04, output: 9 },
  }, 'blank fields are omitted so the lower layer keeps applying');
  assert.ok(!('__new__' in payload.models), 'the add-form placeholder key is never sent');
  assert.deepEqual(payload.models['gpt-4o-new'], {
    peak: { input_miss: 1, input_hit: 0.1 },
    offpeak: { input_miss: 0.5, input_hit: 0.05, output: 1 },
  }, 'negative values are dropped by the client (the Host rejects them too)');
  assert.deepEqual(payload.remove, ['gpt-4o-old']);
  assert.deepEqual(plugin.pricePayload({}, [], null), { models: {}, remove: [] });
}

// ── P1-1/P1-2 (r6): the form covers a stated subset, nothing silently missing ─
{
  const defaults = Object.keys(Config['~standard'].validate({}).value).sort();
  const covered = [...plugin.settingsKeys].sort();
  const excluded = [...plugin.excludedKeys].sort();
  assert.equal(covered.length + excluded.length, defaults.length, 'covered + excluded == every Config key');
  assert.deepEqual([...covered, ...excluded].sort(), defaults, 'no key is missing and none is invented');
  assert.ok(covered.every((key) => defaults.includes(key)), 'every form key is a real Config key');
  assert.ok(!covered.includes('holidays') && !covered.includes('allowedOrigins'), 'array/path keys stay in YAML');
  assert.ok(covered.includes('requireLocalControl') && covered.includes('requireLocalAction'));
}

console.log('client tests passed');