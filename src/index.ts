/**
 * dsh-budget-guard-plugin — Host half.
 *
 * Everything here is derived from the durable Session log:
 *
 *  - `assistant/message.usage` is the authoritative token meter;
 *  - `turn/start` · `step/start` · `tool/call` · `turn/end` give the shape of
 *    the work (how many steps a turn really needed);
 *  - `command/run` carries `/budget ...` declarations so a per-Session budget
 *    survives a Host restart.
 *
 * The plugin never calls a model. The per-turn estimate is a local heuristic
 * over the numbers already recorded in the log, so it adds exactly zero LLM
 * cost.
 *
 * Enforcement uses the two extension points the agent loop exposes:
 *
 *  - `agent/turn-stopping`: at the threshold an `auto` budget cancels the
 *    closing turn through the concrete `agent.cancel()` handle (the loop
 *    documents this as the turn-budget seam);
 *  - `agent/pre-step`: an optional hard guard rejects the next step when the
 *    budget is already exhausted, so a runaway turn cannot keep buying calls.
 *
 * A Client half renders the state served by the two HTTP routes below.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_OFFPEAK_FACTOR,
  DEFAULT_PRICE_BOOK,
  finalizePriceBook,
  isPeak,
  mergePriceBooks,
  normalizeHolidays,
  priceMessage,
  toEpochMs,
} from './pricing.js';

export const name = 'budget-guard';

export const inject = [];

const PLUGIN_ID = 'dsh-budget-guard-plugin';
const DEFAULT_CURRENCY = 'CNY';
const SURFACE_PATH = '/dsh-budget/state';
const ACTION_PATH = '/dsh-budget/action';
const CONFIG_PATH = '/dsh-budget/config';
const CONFIG_SAVE_PATH = '/dsh-budget/config/save';
const PRICES_PATH = '/dsh-budget/prices';
const PRICES_SAVE_PATH = '/dsh-budget/prices/save';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SESSIONS = 512;

const DEFAULTS = {
  budgetAmount: 0,
  tokenBudget: 0,
  currency: DEFAULT_CURRENCY,
  warnRatio: 0.8,
  interceptRatio: 0.95,
  interceptMode: 'auto',
  enablePreEstimate: true,
  enableTurnEstimate: true,
  estimateOutput: 'both',
  turnEstimateMinInterval: 1500,
  enforceAtPreStep: true,
  holidays: [],
  useBuiltinHolidays: true,
  allowedOrigins: [],
  enableSnapshot: true,
  snapshotPath: '',
  snapshotMaxSessions: 200,
  snapshotMaxAgeDays: 30,
  snapshotKeepTurns: 8,
  unknownWarnRatio: 0.2,
  maxGrantedPercent: 30,
  manualHardStopRatio: 1.5,
  perSessionMaxSettled: 2000,
  requireLocalControl: true,
  requireLocalAction: true,
};

const INTERCEPT_MODES = ['auto', 'manual'];
const OUTPUT_MODES = ['chat', 'sidebar', 'both'];
const CURRENCY_SYMBOLS = { CNY: '¥', RMB: '¥' };

/**
 * Everything the settings page may patch over HTTP. Derived from DEFAULTS so a
 * new Config key is savable the moment it exists; the values themselves are
 * still checked by `validateConfig`, which is the single authority.
 */
const SAVE_KEYS = Object.keys(DEFAULTS);

/** Where the per-turn estimate is allowed to show up for the current Config. */
function estimateOutputOf(config) {
  const enabled = config.enableTurnEstimate !== false;
  const mode = OUTPUT_MODES.includes(config.estimateOutput) ? config.estimateOutput : 'both';
  return {
    mode,
    chat: enabled && mode !== 'sidebar',
    sidebar: enabled && mode !== 'chat',
  };
}

/** The tiny amount of state one Session needs. Derived cache, never truth. */
function blankState(sessionId) {
  return {
    sessionId: String(sessionId),
    parentSessionId: null,
    createdAt: Date.now(),
    stale: false,
    snapshotAt: 0,
    snapshotLastSeq: 0,
    lastSeq: -1,
    turns: 0,
    turnsCompleted: 0,
    steps: 0,
    toolCalls: 0,
    inputTokens: 0,
    inputMissTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    cost: 0,
    shadowCost: 0,
    costBreakdown: { inputMiss: 0, inputHit: 0, output: 0 },
    byModel: {},
    byTier: {
      peak: { cost: 0, tokens: 0 },
      offpeak: { cost: 0, tokens: 0 },
    },
    unknownTokens: 0,
    unknownModels: {},
    lastModel: null,
    lastTier: null,
    invalidTimeMessages: 0,
    timezoneWarned: false,
    priceWarnings: [],
    stepCharges: new Map(),
    settledCharges: new Map(),
    settledTrimmed: false,
    settledOverflow: false,
    settledOverflowWarned: false,
    settledEvicted: 0,
    /** Highest event seq of any settled charge; eviction never lowers it. */
    settledSeqWatermark: 0,
    /** How many entries of `settledCharges` currently carry a rollback summary. */
    settledSummaries: 0,
    blockedSettlements: 0,
    chargeTrimWarned: false,
    currentTurn: 0,
    turnStartCost: 0,
    turnStartTokens: 0,
    turnSteps: 0,
    turnToolCalls: 0,
    currentTurnText: '',
    lastAssistantText: '',
    planSteps: null,
    /** Turn in which the model stated its plan; a plan never leaks into the next turn. */
    planTurn: null,
    lastTurn: null,
    estimate: null,
    lastEstimateAt: 0,
    preEstimate: null,
    override: null,
    warnAnnounced: false,
    manualPending: false,
    manualSuppressed: false,
    manualDecidedAt: 0,
    manualContinues: 0,
    grantCost: 0,
    grantTokens: 0,
    cancelRequested: false,
    stopReason: null,
    /** Set by a budget stop (auto cancel or pre-step reject); drives the recovery row. */
    lastStopAt: 0,
    lastStopKind: null,
    /** `/budget unlock`: this session is no longer stopped for budget reasons. */
    guardDisabled: false,
    guardDisabledAt: 0,
    replacedSettlements: 0,
    lastReplacementAt: 0,
    turnSummaries: [],
  };
}

function normalizeConfig(raw) {
  return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round6(value) {
  return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The recovery banner is driven by `lastStopAt`. A stop is answered by
 * 继续 / 解除限制 / 重新设置预算, so every one of those paths must clear it;
 * otherwise `/budget lock` (or setting a new budget after an unlock) resurrects
 * a banner for a stop that is no longer pending.
 */
function clearStop(state) {
  state.lastStopAt = 0;
  state.lastStopKind = null;
}

/**
 * Grants are tied to the limit they were granted against. Re-arming the guard
 * or replacing the budget must drop them, or `overThreshold` keeps comparing
 * against the old grant line and the new (smaller) budget never intercepts.
 */
function resetManualGrants(state) {
  state.manualContinues = 0;
  state.grantCost = 0;
  state.grantTokens = 0;
}

/**
 * `unknownWarnRatio` accepts 0 (warn on any unpriced token). `||` would turn
 * that valid boundary into the 0.2 default, so resolve it explicitly.
 */
function unknownWarnRatioOf(config) {
  const value = config ? config.unknownWarnRatio : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.unknownWarnRatio;
  return clamp(value, 0, 1);
}

/** Exported so tests can pin the exact boundary formatting the UI shows. */
export function money(value, currency) {
  const symbol = CURRENCY_SYMBOLS[currency] || '';
  const amount = Math.abs(value);
  if (amount === 0) return `${symbol}0.00`;
  if (amount < 0.0001) return `<${symbol}0.0001`;
  if (amount < 0.01) return `${symbol}${amount.toFixed(4)}`;
  if (amount < 0.1) return `${symbol}${amount.toFixed(3)}`;
  return `${symbol}${amount.toFixed(2)}`;
}

function tokens(value) {
  const n = Math.max(0, Math.round(value));
  if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return String(n);
}

function currencyOf(config) {
  const currency = String(config.currency || DEFAULT_CURRENCY).toUpperCase();
  return CURRENCY_SYMBOLS[currency] ? currency : DEFAULT_CURRENCY;
}

/**
 * The effective limit: a Session command beats the profile Config.
 * Zero means "this dimension is not budgeted".
 */
function limitOf(state, config) {
  const override = state.override || {};
  return {
    amount: Math.max(0, num(override.amount ?? config.budgetAmount)),
    tokens: Math.max(0, num(override.tokens ?? config.tokenBudget)),
    currency: currencyOf(config),
  };
}

function configured(limit) {
  return limit.amount > 0 || limit.tokens > 0;
}

/**
 * Whether this session may be *stopped* for budget reasons at all.
 *
 * Two independent gates: a budget must actually be configured (0 / unset means
 * "no limit" — nobody should be interrupted before they ever set one), and the
 * user must not have lifted the guard for this session (`/budget unlock`).
 * Enforcement points check this, so a lifted guard also disables the pre-step
 * rejection and the manual prompt, not just the warning.
 */
function enforcementActive(state, limit) {
  return configured(limit) && !state.guardDisabled;
}

function budgetLabel(limit) {
  const parts = [];
  if (limit.amount > 0) parts.push(money(limit.amount, limit.currency));
  if (limit.tokens > 0) parts.push(tokens(limit.tokens) + ' tokens');
  return parts.length ? parts.join(' / ') : '未设置预算';
}

/**
 * Ratios are reported honestly; the threshold check below is what a manual
 * "继续" can temporarily lift.
 */
function ratiosOf(state, limit) {
  const cost = round6(state.cost + num(state.shadowCost));
  const costRatio = limit.amount > 0 ? cost / limit.amount : null;
  const tokenRatio = limit.tokens > 0 ? state.totalTokens / limit.tokens : null;
  const ratio = Math.max(costRatio ?? 0, tokenRatio ?? 0);
  return {
    cost,
    costRatio,
    tokenRatio,
    ratio: configured(limit) ? ratio : 0,
    percent: configured(limit) ? clamp(Math.round(ratio * 100), 0, 999) : 0,
  };
}

function overThreshold(state, limit, config) {
  if (!enforcementActive(state, limit)) return false;
  const threshold = clamp(num(config.interceptRatio) || DEFAULTS.interceptRatio, 0.01, 2);
  const cost = round6(state.cost + num(state.shadowCost));
  const costHit =
    limit.amount > 0 &&
    cost >= Math.max(limit.amount * threshold, num(state.grantCost));
  const tokenHit =
    limit.tokens > 0 &&
    state.totalTokens >= Math.max(limit.tokens * threshold, num(state.grantTokens));
  return costHit || tokenHit;
}

function warningRatioReached(state, limit, config) {
  if (!configured(limit)) return false;
  const ratio = ratiosOf(state, limit).ratio;
  return ratio >= clamp(num(config.warnRatio) || DEFAULTS.warnRatio, 0, 1);
}

function overManualHardStop(state, limit, config) {
  if (!enforcementActive(state, limit)) return false;
  if (config.interceptMode !== 'manual') return false;
  const threshold =
    clamp(num(config.interceptRatio) || DEFAULTS.interceptRatio, 0.01, 2) *
    Math.max(1, num(config.manualHardStopRatio) || DEFAULTS.manualHardStopRatio);
  return ratiosOf(state, limit).ratio >= threshold;
}

function messageText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  const parts = [];
  for (const block of message.content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/**
 * Prefer a plan the model itself stated ("共 6 步", "Step 3 of 8", "6 steps").
 * It is free context already paid for, not a new call.
 */
function detectPlanSteps(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const tail = text.slice(-6000);
  const patterns = [
    /(?:step|步骤)\s*(\d{1,2})\s*(?:of|\/|／)\s*(\d{1,2})/i,
    /(?:共|一共|总共|合计)\s*(\d{1,2})\s*(?:步|个步骤)/,
    /(?:计划|plan)\s*[:：]?\s*(\d{1,2})\s*(?:步|steps?)/i,
    /(?:需要|预计|还需|还要)\s*(\d{1,2})\s*(?:步|个步骤|steps?)/,
    /(\d{1,2})\s*steps?\s*(?:total|in total|remaining)?/i,
  ];
  for (const pattern of patterns) {
    const match = tail.match(pattern);
    if (!match) continue;
    const raw = pattern === patterns[0] ? match[2] : match[1];
    const value = Number.parseInt(raw, 10);
    if (Number.isInteger(value) && value > 0 && value <= 60) return value;
  }
  return null;
}

function stateTag(state, config) {
  return {
    sessionId: state.sessionId,
    turns: state.turnsCompleted,
    steps: state.steps,
    toolCalls: state.toolCalls,
    tokens: state.totalTokens,
    cost: state.cost,
    currency: currencyOf(config),
  };
}

/**
 * Recent burn rate, not a prediction.
 *
 * Prefer the last three completed turns; mid-turn (no completed turn yet) fall
 * back to the last three settled steps. Both are observed history, never an
 * extrapolation of future work.
 */
function recentBurn(state) {
  const turns = Array.isArray(state.turnSummaries) ? state.turnSummaries.slice(-3) : [];
  if (turns.length > 0) {
    const cost = turns.reduce((sum, turn) => sum + num(turn.cost), 0) / turns.length;
    const tokens = turns.reduce((sum, turn) => sum + num(turn.tokens), 0) / turns.length;
    return {
      recentAvgCost: round6(cost),
      recentAvgTokens: Math.round(tokens),
      recentSamples: turns.length,
      recentUnit: 'turn',
    };
  }
  const charges = [...state.stepCharges.values()].slice(-3);
  if (charges.length > 0) {
    // No completed turn summaries are available (mid-first-turn, or an old
    // version-2 snapshot written before turnSummaries were persisted). With
    // completed turns, convert the per-step average to a per-turn figure so the
    // UI always speaks in "每轮"; mid-first-turn honestly reports "每步".
    const avg = (pick) => charges.reduce((sum, charge) => sum + pick(charge), 0) / charges.length;
    const stepCost = avg((charge) => num(charge.cost) + num(charge.shadow));
    const stepTokens = avg((charge) => num(charge.tokens));
    if (state.turnsCompleted > 0) {
      const stepsPerTurn = Math.max(1, state.steps / state.turnsCompleted);
      return {
        recentAvgCost: round6(stepCost * stepsPerTurn),
        recentAvgTokens: Math.round(stepTokens * stepsPerTurn),
        recentSamples: charges.length,
        recentUnit: 'turn',
      };
    }
    return {
      recentAvgCost: round6(stepCost),
      recentAvgTokens: Math.round(stepTokens),
      recentSamples: charges.length,
      recentUnit: 'step',
    };
  }
  return { recentAvgCost: null, recentAvgTokens: null, recentSamples: 0, recentUnit: null };
}

/**
 * Display-only accounting summary.
 *
 * The old version guessed remaining steps from tool activity and extrapolated
 * tokens/cost from the historical average. That is a prediction of a highly
 * volatile process, so it is gone. Remaining values are `null` unless the model
 * itself stated a plan ("共 6 步", "Step 3 of 8"); in that case the plan supplies
 * the step count and the recent burn rate only prices those steps.
 */
function computeEstimate(state, config) {
  const limit = limitOf(state, config);
  const ratios = ratiosOf(state, limit);
  const effectiveCost = round6(state.cost + num(state.shadowCost));
  const spentLabel = money(effectiveCost, limit.currency) +
    (state.shadowCost > 0 ? `（含未知估算 ${money(state.shadowCost, limit.currency)}）` : '');
  const budgetText = budgetLabel(limit);
  const noBudget = !configured(limit);
  const recent = recentBurn(state);
  const hasPlan = Number.isInteger(state.planSteps) &&
    state.planSteps > 0 &&
    state.planTurn === state.currentTurn;
  const progressPercent = hasPlan
    ? profilePercent((state.steps / Math.max(1, state.planSteps)) * 100)
    : profilePercent(ratios.percent);
  const avgStepsPerTurn = state.turnsCompleted > 0
    ? Math.max(1, state.steps / state.turnsCompleted)
    : 1;

  let remainingSteps = null;
  let remainingTurns = null;
  let remainingTokens = null;
  let remainingCost = null;
  let projectedCost = null;
  let projectedTokens = null;
  let overBudget = false;

  if (hasPlan) {
    remainingSteps = clamp(state.planSteps - state.steps, 0, 40);
    if (remainingSteps === 0) {
      remainingTurns = 0;
      remainingTokens = 0;
      remainingCost = 0;
    } else if (recent.recentAvgCost !== null && recent.recentAvgTokens !== null) {
      if (recent.recentUnit === 'turn') {
        remainingTurns = Math.max(1, Math.ceil(remainingSteps / avgStepsPerTurn));
        remainingCost = recent.recentAvgCost * remainingTurns;
        remainingTokens = Math.round(recent.recentAvgTokens * remainingTurns);
      } else {
        remainingTurns = 1;
        remainingCost = recent.recentAvgCost * remainingSteps;
        remainingTokens = Math.round(recent.recentAvgTokens * remainingSteps);
      }
    }
    if (remainingCost !== null) {
      projectedCost = round6(effectiveCost + remainingCost);
      projectedTokens = state.totalTokens + remainingTokens;
      overBudget =
        (limit.amount > 0 && projectedCost > limit.amount * 1.02) ||
        (limit.tokens > 0 && projectedTokens > limit.tokens * 1.02);
    }
  }

  const parts = [];
  let text;
  if (hasPlan) {
    parts.push(`已完成约 ${progressPercent}%`);
    if (remainingSteps === 0) {
      parts.push('模型计划已完成');
    } else {
      const tail = remainingCost === null
        ? ''
        : `、${money(remainingCost, limit.currency)} / ${tokens(remainingTokens)} tokens`;
      const turnsText = remainingTurns === null ? '' : `（约 ${remainingTurns} 轮）`;
      parts.push(`预计还需 ${remainingSteps} 步${turnsText}${tail}`);
    }
    parts.push(`当前已用 ${spentLabel}${noBudget ? '' : ` / ${budgetText}`}`);
    text = `预算进度（模型计划，仅供参考）：${parts.join('；')}。`;
    if (overBudget) {
      text += ` ⚠ 按近期速度，可能会超出预算：预计合计 ${money(projectedCost, limit.currency)}` +
        (limit.tokens > 0 ? ` / ${tokens(projectedTokens)} tokens` : '') + '。';
    }
  } else {
    const burnText = recent.recentAvgCost === null
      ? '近期暂无完整轮次数据'
      : `近期消耗：约 ${money(recent.recentAvgCost, limit.currency)} / ${tokens(recent.recentAvgTokens)} tokens 每${recent.recentUnit === 'step' ? '步' : '轮'}`;
    // With no configured line there is no percentage to report: "预算已用约
    // 0%" would read as "you have used none of your budget" after 1M tokens,
    // which is a worse lie than simply saying no budget is set.
    parts.push(
      noBudget ? '未设置预算（仅记录金额）' : `预算已用约 ${progressPercent}%`,
      burnText,
      `当前已用 ${spentLabel}${noBudget ? '' : ` / ${budgetText}`}`,
    );
    text = `预算进度（近期）：${parts.join('；')}。不预测未来消耗。`;
  }

  return {
    isEstimate: true,
    source: hasPlan ? 'model_plan' : 'recent',
    basis: hasPlan ? 'model-plan' : 'recent',
    turn: state.currentTurn,
    endSeq: state.lastTurn ? state.lastTurn.endSeq : null,
    at: Date.now(),
    progressPercent,
    progressBasis: hasPlan ? 'plan' : 'budget',
    completedSteps: state.steps,
    remainingSteps,
    remainingTurns,
    remainingTokens,
    remainingCost,
    remainingCostLabel: remainingCost === null ? null : money(remainingCost, limit.currency),
    recentAvgCost: recent.recentAvgCost,
    recentAvgCostLabel: recent.recentAvgCost === null ? null : money(recent.recentAvgCost, limit.currency),
    recentAvgTokens: recent.recentAvgTokens,
    recentSamples: recent.recentSamples,
    recentUnit: recent.recentUnit,
    effectiveCost,
    shadowCost: state.shadowCost,
    projectedCost,
    projectedCostLabel: projectedCost === null ? null : money(projectedCost, limit.currency),
    projectedTokens,
    avgTokensPerStep: Math.round(state.totalTokens / Math.max(1, state.steps)),
    avgCostPerStep: effectiveCost / Math.max(1, state.steps),
    overBudget,
    text,
    tag: stateTag(state, config),
  };
}

function profilePercent(value) {
  if (!Number.isFinite(value)) return 0;
  return clamp(Math.round(value), 0, 100);
}

function preEstimate(state, config) {
  if (!config.enablePreEstimate) return null;
  const limit = limitOf(state, config);
  const lowSteps = 3;
  const highSteps = 12;
  // The only pre-turn evidence is the first prompt's size. Use a token-based
  // floor so a huge prompt gets a correspondingly less cheerful range.
  const fallbackPrice = DEFAULT_PRICE_BOOK.models['deepseek-flash'].peak;
  const blendedPrice = (fallbackPrice.input_miss + fallbackPrice.output) * 0.6;
  const promptTokens = Math.round((state.lastAssistantText.length + 800) / 4);
  const perStep = Math.max(1500, promptTokens + 1200);
  const lowTokens = perStep * lowSteps;
  const highTokens = perStep * highSteps;
  const lowCost = (lowTokens / 1000000) * blendedPrice;
  const highCost = (highTokens / 1000000) * blendedPrice;
  const share = limit.amount > 0 ? Math.round((highCost / limit.amount) * 100) : null;
  return {
    isEstimate: true,
    steps: [lowSteps, highSteps],
    tokens: [lowTokens, highTokens],
    cost: [lowCost, highCost],
    text:
      `任务前粗估（估算）：约 ${lowSteps}–${highSteps} 步、` +
      `${money(lowCost, limit.currency)}–${money(highCost, limit.currency)} / ` +
      `${tokens(lowTokens)}–${tokens(highTokens)} tokens` +
      (share === null ? '。' : `，约占预算 ${share}%。`),
    at: Date.now(),
    tag: stateTag(state, config),
  };
}

function unknownProtectionReached(state, config) {
  if (state.unknownTokens <= 0 || state.totalTokens <= 0) return false;
  return state.unknownTokens / state.totalTokens >= unknownWarnRatioOf(config);
}

function warningOf(state, config) {
  const limit = limitOf(state, config);
  // No configured line means no budget warning of any kind. Unknown-model
  // details remain in `pricing.warnings`/`unknownTokens`; the budget `warning`
  // banner is silent because there is no line to approach or cross.
  if (!configured(limit)) return null;
  if (state.manualPending) {
    const grantedPercent = Math.min(100, state.manualContinues * 10);
    return {
      level: 'manual',
      text: `已消耗 ${money(ratiosOf(state, limit).cost, limit.currency)} / ${budgetLabel(limit)}（${ratiosOf(state, limit).percent}%），是否继续？（本次 +10%，累计已放行 ${grantedPercent}%）`,
    };
  }
  // The real threshold warning stays red. A projection from a model plan is
  // only a hint and must never use the same red treatment.
  if (warningRatioReached(state, limit, config)) {
    return {
      level: 'over',
      text: `⚠ 预算预警：已使用 ${ratiosOf(state, limit).percent}%，接近 ${budgetLabel(limit)} 上限。`,
    };
  }
  if (state.estimate && state.estimate.source === 'model_plan' && state.estimate.overBudget) {
    return {
      level: 'warn',
      text: '按近期速度，可能会超出预算',
    };
  }
  if (unknownProtectionReached(state, config)) {
    return {
      level: 'warn',
      text: `⚠ 未定价模型占 ${Math.round((state.unknownTokens / state.totalTokens) * 100)}% token；金额已按已加载价格表中的最高单价估算用于拦截，实际可能偏低。`,
    };
  }
  if (state.unknownTokens > 0) {
    return {
      level: 'warn',
      text: `⚠ 未知模型 ${tokens(state.unknownTokens)} tokens 未计价（展示费用按真实已知计；拦截按已加载价格表中的最高单价估算）。`,
    };
  }
  return null;
}

function buildView(state, config, running, pricing, aggregate) {
  const limit = limitOf(state, config);
  const ratios = ratiosOf(state, limit);
  const estimate = state.estimate ? { ...state.estimate, tag: stateTag(state, config) } : null;
  const currentPeak = isPeak(Date.now(), pricing.holidays);
  const configuredLimit = configured(limit);
  const grantedPercent = state.manualSuppressed ? 100 : Math.min(100, state.manualContinues * 10);
  const canContinue = configuredLimit && state.manualContinues * 10 < num(config.maxGrantedPercent);
  const manualPending = configuredLimit && state.manualPending;
  const overBudget = configuredLimit &&
    ((limit.amount > 0 && ratios.cost > limit.amount) ||
      (limit.tokens > 0 && state.totalTokens > limit.tokens));
  const hardStopPercent = Math.round(
    num(config.interceptRatio) * num(config.manualHardStopRatio) * 1000,
  ) / 10;
  // Unit prices for the model/tier that last billed, so the panel can state the
  // formula instead of only the total ("why is my number different?").
  const rateModel = String(state.lastModel || '');
  const rateTier = state.lastTier === 'peak' ? 'peak' : 'offpeak';
  const rateEntry = (pricing.book.models[rateModel] || {})[rateTier] || null;
  return {
    sessionId: state.sessionId,
    parentSessionId: state.parentSessionId || null,
    stale: !!state.stale,
    snapshotAt: state.snapshotAt || 0,
    loading: false,
    configured: configured(limit),
    running: !!running,
    config: {
      currency: limit.currency,
      interceptMode: config.interceptMode,
      warnRatio: config.warnRatio,
      interceptRatio: config.interceptRatio,
      estimateOutput: config.estimateOutput,
      output: estimateOutputOf(config),
      enableTurnEstimate: config.enableTurnEstimate,
      enablePreEstimate: config.enablePreEstimate,
      turnEstimateMinInterval: config.turnEstimateMinInterval,
      unknownWarnRatio: config.unknownWarnRatio,
      maxGrantedPercent: config.maxGrantedPercent,
      manualHardStopRatio: config.manualHardStopRatio,
    },
    budget: {
      amount: limit.amount,
      tokens: limit.tokens,
      currency: limit.currency,
      label: budgetLabel(limit),
      amountLabel: limit.amount > 0 ? money(limit.amount, limit.currency) : null,
      tokenLabel: limit.tokens > 0 ? `${tokens(limit.tokens)} tokens` : null,
    },
    used: {
      cost: state.cost,
      costLabel: money(state.cost, limit.currency),
      shadowCost: state.shadowCost,
      shadowCostLabel: money(state.shadowCost, limit.currency),
      effectiveCost: ratios.cost,
      effectiveCostLabel: money(ratios.cost, limit.currency),
      tokens: state.totalTokens,
      tokenLabel: `${tokens(state.totalTokens)} tokens`,
      inputTokens: state.inputTokens,
      inputMissTokens: state.inputMissTokens,
      outputTokens: state.outputTokens,
      cacheReadTokens: state.cacheReadTokens,
      breakdown: state.costBreakdown,
      ratio: Math.round(ratios.ratio * 10000) / 10000,
      percent: ratios.percent,
      costPercent: ratios.costRatio === null ? null : clamp(Math.round(ratios.costRatio * 100), 0, 999),
      tokenPercent: ratios.tokenRatio === null ? null : clamp(Math.round(ratios.tokenRatio * 100), 0, 999),
    },
    pricing: {
      currentTier: currentPeak === true ? 'peak' : 'offpeak',
      currentPeak: currentPeak === true,
      lastModel: state.lastModel,
      lastTier: state.lastTier,
      /** Unit prices (CNY / 1M) that produced the total; null when unknown. */
      rates: rateEntry
        ? {
            model: rateModel,
            tier: rateTier,
            inputMiss: num(rateEntry.input_miss),
            inputHit: num(rateEntry.input_hit),
            output: num(rateEntry.output),
          }
        : null,
      byTier: state.byTier,
      byModel: state.byModel,
      unknownTokens: state.unknownTokens,
      unknownModels: state.unknownModels,
      unknownRatio: state.totalTokens > 0 ? state.unknownTokens / state.totalTokens : 0,
      protectionAtRisk:
        state.unknownTokens > 0 &&
        state.totalTokens > 0 &&
        state.unknownTokens / state.totalTokens >= unknownWarnRatioOf(config),
      shadowCost: state.shadowCost,
      invalidTimeMessages: state.invalidTimeMessages,
      warnings: [
        ...new Set([
          ...(pricing.warnings || []),
          ...state.priceWarnings.filter(
            (warning) => state.unknownTokens > 0 || !warning.includes('未知模型'),
          ),
        ]),
      ],
      sources: pricing.sources,
      holidaysSource: pricing.holidaysSource,
    },
    estimate,
    preEstimate: state.turnsCompleted === 0 ? state.preEstimate : null,
    /** Actual spend above the configured line; always false when both limits are 0. */
    overBudget,
    warning: warningOf(state, config),
    manual: {
      pending: manualPending,
      suppressed: state.manualSuppressed,
      continues: state.manualContinues,
      grantedPercent,
      maxGrantedPercent: config.maxGrantedPercent,
      canContinue,
      hardStopPercent,
      text: manualPending
        ? `已消耗 ${money(ratios.cost, limit.currency)} / ${budgetLabel(limit)}，是否继续？（本次 +10%，累计已放行 ${grantedPercent}%）`
        : null,
    },
    counters: {
      turns: state.turnsCompleted,
      steps: state.steps,
      toolCalls: state.toolCalls,
      planSteps: state.planSteps,
      planTurn: state.planTurn || null,
      replacedSettlements: state.replacedSettlements,
      blockedSettlements: state.blockedSettlements,
      lastSeq: state.lastSeq,
      snapshotLastSeq: state.snapshotLastSeq,
      stepCharges: state.stepCharges.size,
      settledCharges: state.settledCharges.size,
      settledTrimmed: !!state.settledTrimmed,
      settledOverflow: !!state.settledOverflow,
      settledEvicted: num(state.settledEvicted),
      settledSeqWatermark: num(state.settledSeqWatermark),
      timezoneWarned: !!state.timezoneWarned,
      invalidTimeMessages: state.invalidTimeMessages,
    },
    aggregate: aggregate || null,
    stopReason: state.stopReason,
    /**
     * Recovery affordances. `stopped` is true while the last budget stop still
     * wants an answer ("继续 / 解除限制"); `lifted` means the user already
     * unlocked this session, so nothing will stop it again.
     */
    guard: {
      disabled: configuredLimit && !!state.guardDisabled,
      disabledAt: num(state.guardDisabledAt),
      lastStopAt: num(state.lastStopAt),
      lastStopKind: state.lastStopKind || null,
      canUnlock: configuredLimit && !state.guardDisabled,
      canResume: configuredLimit && !state.guardDisabled && state.manualContinues * 10 < num(config.maxGrantedPercent),
      stopped: configuredLimit && !state.guardDisabled && num(state.lastStopAt) > 0 && !manualPending,
    },
  };
}

/**
 * Conservative upper bound for an unpriced model.
 *
 * Rule (fixed by test): take the *complete* per-model price of every loaded
 * model in BOTH tiers and keep the single largest total — i.e. the most
 * expensive model at its most expensive tier (normally peak). It is not a
 * per-field max (that can invent a price no model has) and it does not switch
 * to the off-peak tariff, because the point is the worst case the unknown
 * model could bill at, not a best-effort estimate of today's rate.
 */
function shadowCostFor(receipt, book) {
  let maxCost = 0;
  for (const model of Object.values(book.models || {})) {
    for (const tier of [model.peak, model.offpeak]) {
      const cost =
        (receipt.inputMissTokens / 1000000) * num(tier.input_miss) +
        (receipt.inputHitTokens / 1000000) * num(tier.input_hit) +
        (receipt.outputTokens / 1000000) * num(tier.output);
      if (cost > maxCost) maxCost = cost;
    }
  }
  return maxCost;
}

/**
 * Add one settlement's worth of money/token movement to the two bucket maps.
 *
 * CONTRACT: every bucket field is **derived** from `(model, tier, cost,
 * tokens)` — nothing here reads `charge.peakCost`/`peakTokens` or any other
 * precomputed split. That is what lets a trimmed settlement be rolled back from
 * the `settledCharges` summary, which only carries those four inputs. If you
 * ever need a new bucket dimension, derive it from an input the summary also
 * carries (or extend the summary and its field list in `summarizeCharge`).
 */
function addBucket(state, model, tier, cost, tokens, sign) {
  const entry = (state.byModel[model] ||= {
    cost: 0,
    tokens: 0,
    peakCost: 0,
    offpeakCost: 0,
    peakTokens: 0,
    offpeakTokens: 0,
    calls: 0,
  });
  entry.cost = round6(entry.cost + sign * cost);
  entry.tokens += sign * tokens;
  entry.calls += sign;
  if (tier === 'peak') {
    entry.peakCost = round6(entry.peakCost + sign * cost);
    entry.peakTokens += sign * tokens;
  } else {
    entry.offpeakCost = round6(entry.offpeakCost + sign * cost);
    entry.offpeakTokens += sign * tokens;
  }
  const bucket = state.byTier[tier];
  bucket.cost = round6(bucket.cost + sign * cost);
  bucket.tokens += sign * tokens;
  if (entry.calls <= 0 && entry.tokens === 0 && entry.cost === 0) delete state.byModel[model];
}

/**
 * Apply one settlement as a single Charge: every aggregate and every detail
 * bucket is added or removed together. Rollback never hand-maintains a subset
 * of fields, so adding a new dimension later cannot silently escape it.
 */
function applyCharge(state, charge, sign) {
  const breakdown = charge.breakdown || {};
  state.cost = round6(state.cost + sign * num(charge.cost));
  state.shadowCost = round6(state.shadowCost + sign * num(charge.shadow));
  state.totalTokens += sign * num(charge.tokens);
  state.inputTokens += sign * num(charge.input);
  state.inputMissTokens += sign * num(charge.inputMiss);
  state.outputTokens += sign * num(charge.output);
  state.cacheReadTokens += sign * num(charge.cacheRead);
  for (const part of ['inputMiss', 'inputHit', 'output']) {
    state.costBreakdown[part] = round6(state.costBreakdown[part] + sign * num(breakdown[part]));
  }
  addBucket(state, charge.model, charge.tier, num(charge.cost), num(charge.tokens), sign);
  if (charge.unknown) {
    state.unknownTokens += sign * num(charge.tokens);
    const count = num(state.unknownModels[charge.model]) + sign;
    if (count > 0) state.unknownModels[charge.model] = count;
    else delete state.unknownModels[charge.model];
  }
}

function rememberWarning(state, warning) {
  if (typeof warning !== 'string' || warning.length === 0) return;
  if (state.priceWarnings.includes(warning)) return;
  state.priceWarnings.push(warning);
  if (state.priceWarnings.length > 20) state.priceWarnings.shift();
}

/**
 * A settled step whose full Charge may already have been trimmed out of
 * `stepCharges`. It keeps every input `applyCharge` reads, packed as a short
 * array, so a late retry can still subtract the old settlement and add the new
 * one instead of being refused.
 *
 * Layout (`SUMMARY_FIELDS` entries, order fixed — pinned by a test):
 *   0 tier (1 = peak)          8 cacheRead
 *   1 unknown (1 = yes)        9 breakdown.inputMiss
 *   2 cost                    10 breakdown.inputHit
 *   3 shadow                  11 breakdown.output
 *   4 tokens                  12 model
 *   5 input                   13 seq (audit only, never applied)
 *   6 inputMiss
 *   7 output
 *
 * `applyCharge` also updates `byModel[model].calls` plus its `peakCost`,
 * `offpeakCost`, `peakTokens`, `offpeakTokens`, and `byTier[tier].tokens`, but
 * those are pure functions of `(model, tier, cost, tokens)` — see
 * `addBucket`'s contract — so they are restored exactly from these four and
 * need no field of their own.
 *
 * `true` instead of an array means "this step was settled but its detail is
 * gone": retries are then refused rather than double-billed.
 */
const SUMMARY_FIELDS = 14;
/** How many summaries are demoted per pass once the cap is full. */
const DEMOTE_BATCH = 64;

function summarizeCharge(charge) {
  const breakdown = charge.breakdown || {};
  return [
    charge.tier === 'peak' ? 1 : 0,
    charge.unknown ? 1 : 0,
    round6(num(charge.cost)),
    round6(num(charge.shadow)),
    num(charge.tokens),
    num(charge.input),
    num(charge.inputMiss),
    num(charge.output),
    num(charge.cacheRead),
    round6(num(breakdown.inputMiss)),
    round6(num(breakdown.inputHit)),
    round6(num(breakdown.output)),
    String(charge.model || 'unknown'),
    num(charge.seq),
  ];
}

/**
 * Rebuild a Charge from its summary. TOTAL on JSON-derived input: it never
 * throws, it returns `null` for anything it does not fully recognise.
 *
 * That matters more than the accounting: a throw inside `applyUsage` would abort
 * the event fold, and since the fold runs on every `session/event`, the whole
 * session would silently stop being billed — the guard would look installed
 * while doing nothing. Refusing (null → caller blocks the settlement) keeps the
 * ledger at the last known value and is visible in `blockedSettlements`.
 *
 * Accepted shape is exact: 14 entries, numbers in 0..11 and 13, a string in 12
 * (`model`), and `tier`/`unknown` limited to 0/1. Anything else — an old
 * summarize layout, a longer one, a null hole, a wrong type — is refused
 * rather than coerced, because coercing a damaged record would roll back a
 * wrong amount.
 */
function chargeFromSummary(summary) {
  if (!Array.isArray(summary) || summary.length !== SUMMARY_FIELDS) return null;
  if (summary[0] !== 0 && summary[0] !== 1) return null;
  if (summary[1] !== 0 && summary[1] !== 1) return null;
  for (let index = 2; index < SUMMARY_FIELDS; index += 1) {
    if (index === 12) continue;
    const value = summary[index];
    // Finite and non-negative: a negative token count or a NaN would roll the
    // ledger *up* (subtracting a negative), which is a silent over-count.
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  }
  if (typeof summary[12] !== 'string') return null;
  return {
    tier: summary[0] === 1 ? 'peak' : 'offpeak',
    unknown: summary[1] === 1,
    cost: num(summary[2]),
    shadow: num(summary[3]),
    tokens: num(summary[4]),
    input: num(summary[5]),
    inputMiss: num(summary[6]),
    output: num(summary[7]),
    cacheRead: num(summary[8]),
    breakdown: {
      inputMiss: num(summary[9]),
      inputHit: num(summary[10]),
      output: num(summary[11]),
    },
    model: summary[12],
    seq: num(summary[13]),
  };
}

/**
 * Remember one settlement for replay.
 *
 * Invariants (see the round-5 audit):
 *  - the newest `perSessionMaxSettled` records keep a rollback summary, because
 *    a retry always happens on a step of the turn that is still running;
 *  - older records degrade to a `true` marker (≈30 bytes) so their retries are
 *    refused instead of billed twice;
 *  - the map is hard-capped at `2 × cap` by forgetting the oldest records, and
 *    only that eviction can ever cause a double bill (warned + counted).
 */
function rememberSettled(state, key, charge, maxSettled) {
  const cap = clamp(Math.round(num(maxSettled)) || DEFAULTS.perSessionMaxSettled, 1, 50000);
  const hard = cap * 2;
  // The watermark records the highest settled event seq and never moves back:
  // a merge against another process must be able to say "the log had already
  // reached this point", even for records eviction later removes.
  state.settledSeqWatermark = Math.max(num(state.settledSeqWatermark), num(charge.seq));
  if (!state.settledCharges.has(key) && state.settledCharges.size >= hard) {
    let drop = state.settledCharges.size - hard + 1;
    for (const oldest of [...state.settledCharges.keys()]) {
      if (drop <= 0) break;
      const value = state.settledCharges.get(oldest);
      if (Array.isArray(value)) state.settledSummaries = Math.max(0, num(state.settledSummaries) - 1);
      state.settledCharges.delete(oldest);
      drop -= 1;
      state.settledEvicted += 1;
    }
    state.settledOverflow = true;
    if (!state.settledOverflowWarned) {
      state.settledOverflowWarned = true;
      rememberWarning(
        state,
        `已结算记录超过 ${hard} 条，开始丢弃最早的记录；新步骤仍会被记录，被丢弃的旧步骤重试可能重复计费`,
      );
    }
  }
  if (state.settledCharges.has(key)) {
    state.settledCharges.set(key, summarizeCharge(charge));
    return;
  }
  if (num(state.settledSummaries) < cap) {
    state.settledCharges.set(key, summarizeCharge(charge));
    state.settledSummaries = num(state.settledSummaries) + 1;
    return;
  }
  // Summary budget is full: demote a batch of the oldest summaries in one pass
  // instead of scanning for a single victim on every settlement, so the steady
  // state stays O(1) amortised (one pass per DEMOTE_BATCH settlements).
  let budget = Math.min(DEMOTE_BATCH, num(state.settledSummaries));
  for (const [oldKey, value] of state.settledCharges) {
    if (budget <= 0) break;
    if (!Array.isArray(value)) continue;
    state.settledCharges.set(oldKey, true);
    state.settledSummaries = Math.max(0, num(state.settledSummaries) - 1);
    budget -= 1;
  }
  state.settledCharges.set(key, summarizeCharge(charge));
  state.settledSummaries = num(state.settledSummaries) + 1;
  if (!state.settledTrimmed) {
    state.settledTrimmed = true;
    rememberWarning(
      state,
      `已结算摘要达到 ${cap} 条上限，最早的一批只记“已计费”标记：这些步骤重试会被拒绝而不是替换`,
    );
  }
}

/**
 * Charge one assistant settlement. The step key makes a retry/repeated
 * settlement *replace* the previous charge instead of adding a second one,
 * even when the original detail was trimmed away by `snapshotKeepTurns`.
 */
function applyUsage(state, usage, source, turn, step, eventTime, pricing, maxSettled, seq) {
  const model = source && typeof source.model === 'string' && source.model ? source.model : 'unknown';
  const timestamp = toEpochMs(eventTime, (message) => {
    if (!state.timezoneWarned) {
      state.timezoneWarned = true;
      rememberWarning(state, message);
    }
  });
  const receipt = priceMessage({
    usage,
    model,
    timestamp: timestamp === null ? Number.NaN : timestamp,
    holidays: pricing.holidays,
    book: pricing.book,
  });
  if (receipt.skipped) {
    state.invalidTimeMessages += 1;
    rememberWarning(state, `消息时间戳无效，已跳过计费：${model}`);
    return;
  }

  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  // Cache writes have no separate price and no separate bucket. Their tokens
  // are part of the miss input (and of `usage.totalTokens` when the Host
  // reports it), so this fallback intentionally has no third input term.
  const total = num(usage.totalTokens) || receipt.inputMissTokens + receipt.inputHitTokens + output;
  // A retry must replace its step's settlement, never add a second one. The
  // key is session-scoped even though `stepCharges` is already per-session, so
  // a future flat snapshot store cannot let equal turn:step keys collide.
  const key = `${state.sessionId}:${turn}:${step}`;
  let previous = state.stepCharges.get(key);
  if (!previous) {
    const settled = state.settledCharges.get(key);
    if (settled === true) {
      // The detail is gone AND the step is known to be billed: replacing is
      // impossible, adding would double-bill. Refuse and make it visible.
      state.blockedSettlements += 1;
      rememberWarning(state, `结算 ${key} 的明细已超过保留上限；为避免重复计费，本次不累加`);
      pricing.logger?.warn?.(
        `[${PLUGIN_ID}] blocked duplicate settlement ${key}: settled detail unavailable (cap reached)`,
      );
      return;
    }
    if (Array.isArray(settled)) {
      previous = chargeFromSummary(settled);
      if (!previous) {
        // A short/unknown summary layout (e.g. a 15-field record written before
        // `seq` existed, or a hand-edited snapshot): the step is known to be
        // billed but cannot be rolled back. Refusing keeps the ledger at the
        // old value; adding would bill the same step twice.
        state.blockedSettlements += 1;
        rememberWarning(state, `结算 ${key} 的摘要格式无法回滚；为避免重复计费，本次不累加`);
        pricing.logger?.warn?.(
          `[${PLUGIN_ID}] blocked duplicate settlement ${key}: settled summary has ${settled.length} fields, expected ${SUMMARY_FIELDS}`,
        );
        return;
      }
    }
  }
  if (previous) {
    state.replacedSettlements += 1;
    state.lastReplacementAt = Date.now();
    pricing.logger?.info?.(
      `[${PLUGIN_ID}] replaced settlement ${key} (${previous.model}); total replacements=${state.replacedSettlements}`,
    );
    applyCharge(state, previous, -1);
    state.stepCharges.delete(key);
  }

  const breakdown = {
    inputMiss: (receipt.inputMissTokens / 1000000) * num(receipt.price.input_miss),
    inputHit: (receipt.inputHitTokens / 1000000) * num(receipt.price.input_hit),
    output: (receipt.outputTokens / 1000000) * num(receipt.price.output),
  };
  const shadow = receipt.unknownModel ? shadowCostFor(receipt, pricing.book) : 0;
  const charge = {
    cost: receipt.cost,
    shadow,
    tokens: total,
    input,
    inputMiss: receipt.inputMissTokens,
    output,
    cacheRead,
    model,
    tier: receipt.tier,
    eventTime: timestamp,
    seq: num(seq),
    unknown: receipt.unknownModel,
    breakdown,
    // Audit trail for `/budget debug`: the exact unit prices that produced this
    // charge and the four usage numbers the Host delivered. Prices can change
    // after settlement (local-prices.json), so recomputing the formula from the
    // current book would otherwise disagree with the recorded amount.
    price: { ...receipt.price },
    usage: usage && typeof usage === 'object'
      ? {
          inputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadTokens: num(usage.cacheReadTokens),
          totalTokens: num(usage.totalTokens),
        }
      : null,
  };
  applyCharge(state, charge, 1);
  if (receipt.unknownModel) {
    rememberWarning(state, `未知模型 ${model}：token 已计入，展示费用按真实已知计；拦截按已加载价格表中的最高单价估算，实际可能偏低`);
  }
  for (const warning of receipt.warnings) rememberWarning(state, warning);
  state.lastModel = model;
  state.lastTier = receipt.tier;
  state.stepCharges.set(key, charge);
  rememberSettled(state, key, charge, maxSettled);
}

/** Build the per-turn record after `turn/end`. */
function closeTurn(state, event) {
  const last = {
    turn: state.currentTurn,
    steps: state.turnSteps,
    toolCalls: state.turnToolCalls,
    tokens: Math.max(0, state.totalTokens - state.turnStartTokens),
    cost: round6(Math.max(0, state.cost - state.turnStartCost)),
    endSeq: typeof event.seq === 'number' ? event.seq : null,
    endTime: event.time || Date.now(),
    reason: event.data && event.data.reason ? event.data.reason.kind : 'unknown',
  };
  state.lastTurn = last;
  state.turnSummaries.push(last);
  if (state.turnSummaries.length > 30) state.turnSummaries.shift();
  state.turnsCompleted = Math.max(state.turnsCompleted, state.currentTurn);
}

function maybeEstimate(state, config, force) {
  if (!config.enableTurnEstimate) return;
  const now = Date.now();
  const min = Math.max(0, num(config.turnEstimateMinInterval));
  if (!force && state.estimate && min > 0 && now - state.lastEstimateAt < min) return;
  state.estimate = computeEstimate(state, config);
  state.lastEstimateAt = now;
}

/**
 * Parse one `/budget` argument. Idempotent: replaying `command/run` after a
 * restart produces the same limit.
 */
function applyBudgetInput(state, raw, config, options) {
  const limit = limitOf(state, config);
  const input = String(raw || '').trim().replace(/^\/?budget\b/i, '').trim();
  const lower = input.toLowerCase();
  const quietActions = !!(options && options.skipManualActions);
  if (!input || lower === 'status' || lower === 'show') {
    return { text: statusText(state, config), action: null };
  }
  if (lower === 'reset-snapshot' || input === '重建') {
    // Deliberately inert during replay: the real work happens in the command
    // handler (live only), because a logged command that wiped the cache would
    // make every restart wipe it again.
    return {
      text: '/budget reset-snapshot 只对当前进程生效，不写可重放的效果（日志里的这条命令在重放时不会有任何作用）。',
      action: null,
    };
  }
  if (lower === 'unlock' || lower === 'disable' || lower === '解除' || lower === '解除限制') {
    state.guardDisabled = true;
    state.guardDisabledAt = Date.now();
    state.manualPending = false;
    state.manualSuppressed = false;
    clearStop(state);
    const limitAgain = limitOf(state, config);
    return {
      text: configured(limitAgain)
        ? `已解除本会话的预算拦截（预算 ${budgetLabel(limitAgain)} 仍会统计费用，但不再中止）。恢复用 /budget lock，重设预算也会自动恢复。`
        : '本会话本来就没有预算，无需解除；费用仍会统计。',
      action: 'unlock',
    };
  }
  if (lower === 'lock' || lower === 'enable' || lower === '恢复' || lower === '恢复限制') {
    state.guardDisabled = false;
    state.guardDisabledAt = 0;
    state.manualPending = false;
    state.manualSuppressed = false;
    resetManualGrants(state);
    clearStop(state);
    state.estimate = computeEstimate(state, config);
    return {
      text: '已恢复本会话的预算拦截。',
      action: 'lock',
    };
  }
  if (lower === 'off' || lower === 'clear' || lower === 'reset' || lower === 'none') {
    state.override = null;
    state.warnAnnounced = false;
    state.manualPending = false;
    state.manualSuppressed = false;
    resetManualGrants(state);
    state.guardDisabled = false;
    state.guardDisabledAt = 0;
    clearStop(state);
    state.estimate = computeEstimate(state, config);
    const defaults = {
      amount: Math.max(0, num(config.budgetAmount)),
      tokens: Math.max(0, num(config.tokenBudget)),
      currency: limit.currency,
    };
    const defaultText = configured(defaults)
      ? [
          defaults.amount > 0 ? `默认金额 ${money(defaults.amount, defaults.currency)}` : null,
          defaults.tokens > 0 ? `默认 Token ${tokens(defaults.tokens)} tokens` : null,
        ].filter(Boolean).join(' / ')
      : null;
    return {
      text: configured(defaults)
        ? `已清除会话覆盖，恢复默认预算：${defaultText}（仍会按默认预算拦截）。`
        : '已清除会话覆盖；当前没有默认预算，本会话不再拦截。',
      action: null,
    };
  }
  if (lower === 'suppress' || lower === 'dismiss' || lower === '不再提示') {
    if (!configured(limit)) {
      // With no line there is nothing to silence; recording "suppressed" here
      // would make a later real budget look pre-suppressed.
      return { text: '本会话未设置预算，没有需要关闭的预算提示。', action: null };
    }
    if (quietActions) {
      return { text: '本次任务内不再提示预算拦截；费用仍会记录。', action: 'suppress' };
    }
    state.manualPending = false;
    state.manualSuppressed = true;
    state.manualDecidedAt = Date.now();
    clearStop(state);
    return {
      text: '本次任务内不再提示预算拦截（仍记录费用）；如需恢复，请 /budget off 或重设预算。',
      action: 'suppress',
    };
  }
  if (lower === 'continue' || lower === 'go' || lower === '继续') {
    if (!configured(limit)) {
      // Ballooning the 10% grant for a budget that does not exist would make a
      // later real budget inherit a grant the user never asked for.
      return { text: '本会话未设置预算，无需放行；可用 /budget <金额> 设置预算。', action: null };
    }
    const maxGranted = Math.max(0, num(config.maxGrantedPercent));
    if (state.manualContinues * 10 >= maxGranted) {
      return {
        text: `已达放行上限（累计 ${Math.min(100, state.manualContinues * 10)}%，上限 ${maxGranted}%）；请「中止」或 /budget off 恢复默认预算。`,
        action: 'grant-limit',
      };
    }
    if (quietActions) {
      return { text: '已允许继续；本次放行 10%。', action: 'continue' };
    }
    state.manualPending = false;
    state.manualDecidedAt = Date.now();
    state.manualContinues += 1;
    clearStop(state);
    if (limit.amount > 0) state.grantCost = round6(state.cost + state.shadowCost + limit.amount * 0.1);
    if (limit.tokens > 0) state.grantTokens = state.totalTokens + limit.tokens * 0.1;
    return {
      text: `已允许继续；本次放行 10%，累计已放行 ${Math.min(100, state.manualContinues * 10)}%。`,
      action: 'continue',
    };
  }
  if (lower === 'abort' || lower === 'stop' || lower === '中止') {
    if (quietActions) {
      return { text: '已请求中止当前任务。', action: 'abort' };
    }
    state.manualPending = false;
    state.manualDecidedAt = Date.now();
    state.stopReason = 'user';
    return { text: '已请求中止当前任务。', action: 'abort' };
  }
  const both = lower.match(/^both\s+([\d.]+)\s+([\d.]+)\s*(k|m)?$/);
  if (both) {
    const amount = Number.parseFloat(both[1]);
    const tokenValue = scaleTokens(Number.parseFloat(both[2]), both[3]);
    if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(tokenValue) || tokenValue < 0) {
      return { text: '预算格式无效：/budget both 2 20000', action: null };
    }
    if (amount === 0 && tokenValue === 0) {
      // `/budget both 0 0` is an explicit "no budget": clear the override and
      // fall back to the Config default, exactly like `/budget off`.
      return applyBudgetInput(state, 'off', config, options);
    }
    state.override = { ...(state.override || {}), amount, tokens: tokenValue };
    state.manualSuppressed = false;
    state.manualPending = false;
    state.guardDisabled = false;
    state.guardDisabledAt = 0;
    resetManualGrants(state);
    clearStop(state);
    state.estimate = computeEstimate(state, config);
    return { text: `已设置本次任务预算：${money(amount, limit.currency)} / ${tokens(tokenValue)} tokens。`, action: null };
  }
  const tokenMatch =
    input.match(/^(?:tokens?|token)\s*[:=]?\s*([\d.]+)\s*(k|m)?$/i) ||
    input.match(/^([\d.]+)\s*(k|m)?\s*(?:tokens?|token)$/i) ||
    input.match(/^([\d.]+)\s*(k|m)$/i);
  if (tokenMatch) {
    const value = scaleTokens(Number.parseFloat(tokenMatch[1]), tokenMatch[2]);
    if (!Number.isFinite(value) || value < 0) {
      return { text: 'Token 预算格式无效：/budget 20000 tokens', action: null };
    }
    if (value === 0) return applyBudgetInput(state, 'off', config, options);
    state.override = { ...(state.override || {}), tokens: Math.round(value) };
    state.manualSuppressed = false;
    state.manualPending = false;
    state.guardDisabled = false;
    state.guardDisabledAt = 0;
    resetManualGrants(state);
    clearStop(state);
    state.estimate = computeEstimate(state, config);
    return { text: `已设置本次任务 Token 预算：${tokens(value)} tokens。`, action: null };
  }
  const amountMatch =
    input.match(/^(?:amount|cny|rmb|usd|\$|¥|￥)\s*[:=]?\s*([\d.]+)$/i) ||
    input.match(/^([\d.]+)\s*(?:cny|rmb|yuan|元)$/i) ||
    input.match(/^([\d.]+)$/);
  if (amountMatch) {
    const amount = Number.parseFloat(amountMatch[1]);
    if (!Number.isFinite(amount) || amount < 0) {
      return { text: '金额预算无效：/budget 2.5', action: null };
    }
    if (amount === 0) return applyBudgetInput(state, 'off', config, options);
    state.override = { ...(state.override || {}), amount };
    state.manualSuppressed = false;
    state.manualPending = false;
    state.guardDisabled = false;
    state.guardDisabledAt = 0;
    resetManualGrants(state);
    clearStop(state);
    state.estimate = computeEstimate(state, config);
    return { text: `已设置本次任务金额预算：${money(amount, limit.currency)}。`, action: null };
  }
  return {
    text: '用法：/budget 2.5（金额）｜/budget 20000 tokens｜/budget both 2 20000｜/budget off｜/budget continue｜/budget suppress（本次不再提示）｜/budget abort｜/budget prices',
    action: null,
  };
}

function scaleTokens(value, suffix) {
  if (!Number.isFinite(value)) return NaN;
  const unit = String(suffix || '').toLowerCase();
  if (unit === 'k') return value * 1000;
  if (unit === 'm') return value * 1000000;
  return value;
}

function statusText(state, config) {
  const limit = limitOf(state, config);
  const ratios = ratiosOf(state, limit);
  const lines = [
    `预算：${budgetLabel(limit)}`,
    `已用：${money(ratios.cost, limit.currency)}${state.shadowCost > 0 ? `（含未知估算 ${money(state.shadowCost, limit.currency)}）` : ''} / ${tokens(state.totalTokens)} tokens（${ratios.percent}%）`,
    `进度：${state.steps} 步 · ${state.toolCalls} 次工具调用 · ${state.turnsCompleted} 轮`,
  ];
  if (state.estimate) lines.push(state.estimate.text);
  if (state.manualPending) {
    const warning = warningOf(state, config);
    if (warning) lines.push(warning.text);
  }
  if (configured(limit) && state.manualSuppressed) lines.push('本次任务已关闭预算提示；/budget off 可恢复。');
  if (state.unknownTokens > 0) {
    lines.push(
      `⚠ 未定价模型 ${Object.keys(state.unknownModels).join(', ') || 'unknown'}：` +
        `${tokens(state.unknownTokens)} tokens 未计价（展示费用按真实已知计，拦截按已加载价格表中的最高单价估算；请补齐价格表）。`,
    );
  }
  if (state.blockedSettlements > 0) {
    lines.push(
      `⚠ 有 ${state.blockedSettlements} 次结算因明细过期被拒绝，账目可能偏高（重试的 step 无法替换旧值）。`,
    );
  }
  if (state.settledOverflow) {
    lines.push(
      `⚠ 已结算记录达到上限，最早的 ${state.settledEvicted} 条已被丢弃；新步骤仍会记录，被丢弃的旧步骤重试可能重复计费。`,
    );
  } else if (state.settledTrimmed) {
    lines.push('⚠ 已结算摘要达到上限，较早的步骤只记“已计费”标记：这些步骤重试会被拒绝而不是替换。');
  }
  lines.push(
    `结算：${state.stepCharges.size} 条明细 / ${state.settledCharges.size} 条已结算记录 · 日志水位 lastSeq ${state.lastSeq}` +
      (state.stale ? `（快照 ${state.snapshotLastSeq}，待校正）` : ''),
  );
  return lines.join('\n');
}

function priceReport(pricing, state) {
  const models = Object.keys(pricing.book.models).sort();
  const unknown = Object.keys(state.unknownModels);
  const rates = (model, tier) => {
    const entry = pricing.book.models[model];
    const price = entry && entry[tier];
    if (!price) return null;
    return (
      `未命中 ¥${num(price.input_miss)}/1M · 命中 ¥${num(price.input_hit)}/1M · ` +
      `输出 ¥${num(price.output)}/1M`
    );
  };
  const lines = [
    `已加载价格模型（${models.length}）：${models.join(', ') || '无'}`,
    `价格来源：${(pricing.sources || []).join(' → ')}`,
    '',
    '计费口径（每 1M token，人民币）：',
    '  · inputTokens 不含缓存命中的部分，cacheReadTokens 单独按“命中价”计费',
    '  · 缓存写入没有单独单价，其 token 已包含在未命中输入中',
    '  · 金额 = 未命中×未命中价 + 命中×命中价 + 输出×输出价',
    '  · 时段按 assistant/message 的 event.time：工作日 09–12 / 14–18 为高峰，其余为空闲',
  ];
  for (const model of models) {
    const peak = rates(model, 'peak');
    const offpeak = rates(model, 'offpeak');
    if (peak) lines.push(`  ${model}（高峰）${peak}`);
    if (offpeak) lines.push(`  ${model}（空闲）${offpeak}`);
  }
  lines.push('');
  lines.push(`未定价模型（${unknown.length}）：${unknown.join(', ') || '无'}`);
  if (state.unknownTokens > 0) {
    lines.push(`当前已有 ${tokens(state.unknownTokens)} tokens 因未定价而展示费用为 0（拦截仍按最高单价估算）。`);
  }
  lines.push(`当前模型：${state.lastModel || '—'}（${state.lastTier === 'peak' ? '高峰' : '空闲'}）`);
  lines.push(
    `补齐方式：在设置页「预算护栏 → 模型价格」中添加该 model（写入 ${pricing.localPath || localPricePath()}，保存即生效），` +
      '或直接编辑该文件里的 models。',
  );
  return lines.join('\n');
}

/**
 * `/budget debug [n]`: the last N settlements with the exact inputs and unit
 * prices. This is the answer to "why is my number different from the console" —
 * it shows what was counted, not just the total.
 */
function debugReport(state, pricing, limit) {
  const entries = [...state.stepCharges.entries()].slice(-limit);
  if (!entries.length) return '本会话还没有结算记录。';
  const lines = [`最近 ${entries.length} 笔结算（先减旧、再加新，重试以最后一笔为准）：`];
  for (const [key, charge] of entries) {
    const when = num(charge.eventTime) > 0 ? new Date(charge.eventTime).toISOString() : '时间未知';
    const price = charge.price || (pricing.book.models[charge.model] || {})[charge.tier] || {};
    const miss = num(charge.inputMiss) / 1e6 * num(price.input_miss);
    const hit = num(charge.cacheRead) / 1e6 * num(price.input_hit);
    const out = num(charge.output) / 1e6 * num(price.output);
    const rawUsage = charge.usage
      ? JSON.stringify(charge.usage)
      : JSON.stringify({
          inputTokens: num(charge.input),
          outputTokens: num(charge.output),
          cacheReadTokens: num(charge.cacheRead),
        });
    lines.push(
      `${key} · ${when} · ${charge.tier === 'peak' ? '高峰' : '空闲'} · ${charge.model}\n` +
        `  未命中 ${num(charge.inputMiss)}×¥${num(price.input_miss)}/1M = ¥${round6(miss)} · ` +
        `命中 ${num(charge.cacheRead)}×¥${num(price.input_hit)}/1M = ¥${round6(hit)} · ` +
        `输出 ${num(charge.output)}×¥${num(price.output)}/1M = ¥${round6(out)}\n` +
        `  原始 usage：${rawUsage}\n` +
        `  合计 ¥${round6(miss + hit + out)}（记录值 ¥${round6(num(charge.cost))}，` +
        `未知单价估算 ¥${round6(num(charge.shadow))}）`,
    );
  }
  lines.push(`当前合计：${money(state.cost, limit.currency)}（含未知估算 ${money(state.shadowCost, limit.currency)}）`);
  return lines.join('\n');
}

const PRICE_FIELDS = ['input_miss', 'input_hit', 'output'];
const PRICE_TIERS = ['peak', 'offpeak'];
/** Names that must never become a write target on a plain object. */
const PRICE_UNSAFE_NAMES = new Set(['__proto__', 'prototype', 'constructor']);
/** Sanity ceiling for one unit price (元 / 1M tokens). */
const PRICE_MAX_VALUE = 1000000;

function dshHomePath() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/**
 * Where the settings page writes user prices.
 *
 * This is deliberately *outside* the installed package: `prices/` belongs to
 * the npm bundle and is replaced on upgrade, so writing there would silently
 * lose user data (and "污染 npm 包目录" is exactly what the UI must not do).
 */
function localPricePath() {
  return join(dshHomePath(), 'budget-guard', 'local-prices.json');
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function readPriceSource(name) {
  try {
    return JSON.parse(readFileSync(new URL(`../prices/${name}`, import.meta.url), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Keep only `{models: {...}}` and drop names that would mutate an object's
 * prototype. A price file is external input even when a human wrote it, so
 * `models.__proto__` must never be copied into the shared book.
 */
function safePriceOverlay(raw) {
  if (!isObject(raw) || !isObject(raw.models)) return undefined;
  const models = Object.create(null);
  for (const [model, value] of Object.entries(raw.models)) {
    if (!model || PRICE_UNSAFE_NAMES.has(model)) continue;
    models[model] = value;
  }
  // An empty table is "no overrides", not a source: deleting every custom
  // model must leave the UI showing the same source list as before the edit.
  return Object.keys(models).length ? { models } : undefined;
}

/**
 * Price priority: built-in defaults → `prices/official-prices.json` (packaged)
 * → `prices/local-prices.json` (legacy, packaged) → `$DSH_HOME/budget-guard/
 * local-prices.json` (written by the settings page, wins).
 *
 * Missing or malformed files are warnings, never a reason to stop billing.
 * `origins` records which source introduced a model so the UI can label a row
 * "官方/内置" vs "用户自定义"; `localPath` is echoed to the UI so the user
 * knows *which* file a save will touch.
 */
function loadPriceBook() {
  const sources = ['内置默认'];
  const warnings = [];
  const origins = Object.create(null);
  for (const model of Object.keys(DEFAULT_PRICE_BOOK.models)) origins[model] = 'builtin';
  let book = mergePriceBooks(DEFAULT_PRICE_BOOK, undefined);
  const official = safePriceOverlay(readPriceSource('official-prices.json'));
  if (official) {
    book = mergePriceBooks(book, official);
    sources.push('official-prices.json');
    for (const model of Object.keys(official.models)) origins[model] = 'official';
  } else {
    warnings.push('prices/official-prices.json 缺失或无效，使用内置价格');
  }
  // Legacy hand-maintained file inside the package. Still read so an existing
  // installation keeps billing the same way, but the UI-written file wins.
  const packaged = safePriceOverlay(readPriceSource('local-prices.json'));
  if (packaged) {
    book = mergePriceBooks(book, packaged);
    sources.push('prices/local-prices.json（插件目录，旧位置）');
    for (const model of Object.keys(packaged.models)) origins[model] = 'local';
  }
  const localPath = localPricePath();
  const local = safePriceOverlay(readJsonFile(localPath));
  if (local) {
    book = mergePriceBooks(book, local);
    sources.push(localPath);
    for (const model of Object.keys(local.models)) origins[model] = 'local';
  } else if (existsSync(localPath)) {
    warnings.push(`${localPath} 无法解析为价格表，已忽略（请在设置页修正或删除该文件）`);
  }
  const finalized = finalizePriceBook(book);
  warnings.push(...finalized.warnings);
  return { book: finalized.book, sources, warnings, origins, localPath };
}

/** The merged book as the settings page renders it (CNY per 1M tokens). */
function priceModelList(pricing) {
  const list = [];
  for (const [model, entry] of Object.entries(pricing.book.models || {})) {
    if (!entry || !entry.peak || !entry.offpeak) continue;
    const origin = (pricing.origins && pricing.origins[model]) || 'builtin';
    const tier = (value) => ({
      input_miss: num(value.input_miss),
      input_hit: num(value.input_hit),
      output: num(value.output),
    });
    list.push({
      model,
      origin,
      custom: origin === 'local',
      peak: tier(entry.peak),
      offpeak: tier(entry.offpeak),
    });
  }
  list.sort((left, right) => left.model.localeCompare(right.model));
  return list;
}

/** Complete payload behind `GET /dsh-budget/prices`. */
function pricePayload(pricing) {
  return {
    currency: DEFAULT_CURRENCY,
    unit: 'CNY / 1M tokens',
    offpeakFactor: DEFAULT_OFFPEAK_FACTOR,
    localPath: pricing.localPath,
    sources: pricing.sources || [],
    warnings: pricing.warnings || [],
    models: priceModelList(pricing),
  };
}

/**
 * Validate `POST /dsh-budget/prices/save`.
 *
 * One shape only: `{models:{name:{peak?,offpeak?}}, remove?:[name]}`. Every
 * number is a unit price in 元 / 1M tokens, so a string or a negative value is
 * an `invalid` issue with a field path instead of being silently coerced —
 * a typo here changes every future settlement.
 */
function validatePriceBody(body) {
  if (!isObject(body)) {
    return { issues: [issue('body must be a JSON object', [])], models: Object.create(null), remove: [] };
  }
  const issues = [];
  const models = Object.create(null);
  const remove = [];
  const rawModels = body.models === undefined ? {} : body.models;
  if (!isObject(rawModels)) {
    issues.push(issue('models must be an object keyed by model name', ['models']));
  } else {
    for (const [rawName, rawEntry] of Object.entries(rawModels)) {
      const model = typeof rawName === 'string' ? rawName.trim() : '';
      if (!model) {
        issues.push(issue('model name must not be empty', ['models']));
        continue;
      }
      if (model.length > 120) {
        issues.push(issue('model name is longer than 120 characters', ['models', model]));
        continue;
      }
      if (PRICE_UNSAFE_NAMES.has(model)) {
        issues.push(issue(`model name "${model}" is not allowed`, ['models', model]));
        continue;
      }
      if (!isObject(rawEntry)) {
        issues.push(issue('a model price must be an object with peak/offpeak', ['models', model]));
        continue;
      }
      const entry = Object.create(null);
      let fields = 0;
      for (const tierName of PRICE_TIERS) {
        const rawTier = rawEntry[tierName];
        if (rawTier === undefined) continue;
        if (!isObject(rawTier)) {
          issues.push(issue(`${tierName} must be an object`, ['models', model, tierName]));
          continue;
        }
        const cleanTier = Object.create(null);
        for (const field of PRICE_FIELDS) {
          const value = rawTier[field];
          if (value === undefined || value === null) continue;
          if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > PRICE_MAX_VALUE) {
            issues.push(
              issue(
                `${tierName}.${field} must be a number between 0 and ${PRICE_MAX_VALUE} (CNY / 1M tokens)`,
                ['models', model, tierName, field],
              ),
            );
            continue;
          }
          cleanTier[field] = value;
          fields += 1;
        }
        if (Object.keys(cleanTier).length) entry[tierName] = cleanTier;
      }
      if (!fields) {
        issues.push(
          issue('at least one unit price is required (peak.input_miss / peak.input_hit / peak.output …)', [
            'models',
            model,
          ]),
        );
        continue;
      }
      models[model] = entry;
    }
  }
  const rawRemove = body.remove === undefined ? [] : body.remove;
  if (!Array.isArray(rawRemove)) {
    issues.push(issue('remove must be an array of model names', ['remove']));
  } else {
    for (const item of rawRemove) {
      if (typeof item !== 'string' || !item.trim()) {
        issues.push(issue('remove entries must be non-empty strings', ['remove']));
        continue;
      }
      remove.push(item.trim());
    }
  }
  if (!issues.length && !Object.keys(models).length && !remove.length) {
    issues.push(issue('nothing to save: models and remove are both empty', ['models']));
  }
  return { issues, models, remove };
}

/**
 * Merge a validated patch into the local price file and write it atomically.
 * Only the fields the user edited are written; everything else keeps
 * inheriting from the packaged layers, so a UI save cannot accidentally pin a
 * value that later follows an official change.
 */
function writeLocalPrices(localPath, models, remove) {
  const existing = readJsonFile(localPath);
  const base = isObject(existing) && isObject(existing.models) ? existing.models : {};
  const next = Object.create(null);
  for (const [model, entry] of Object.entries(base)) {
    if (!model || PRICE_UNSAFE_NAMES.has(model)) continue;
    next[model] = isObject(entry) ? entry : Object.create(null);
  }
  for (const [model, entry] of Object.entries(models)) {
    const current = isObject(next[model]) ? next[model] : Object.create(null);
    const merged = Object.create(null);
    for (const [key, value] of Object.entries(current)) merged[key] = value;
    for (const tierName of PRICE_TIERS) {
      if (!entry[tierName]) continue;
      const tierSource = isObject(merged[tierName]) ? merged[tierName] : Object.create(null);
      const tierNext = Object.create(null);
      for (const [key, value] of Object.entries(tierSource)) tierNext[key] = value;
      for (const [key, value] of Object.entries(entry[tierName])) tierNext[key] = value;
      merged[tierName] = tierNext;
    }
    next[model] = merged;
  }
  for (const model of remove) delete next[model];
  const document = {
    _comment:
      '由 DSH 设置页「模型价格」写入；只覆盖写出的字段，其余继承 official-prices.json 或内置价。' +
      '单位：元 / 1M tokens。删除该文件或删除其中的模型即可恢复默认价。',
    models: next,
  };
  mkdirSync(dirname(localPath), { recursive: true });
  // Write-then-rename: a crash mid-write must not leave a half price table
  // that the next load would reject. `writeFileSync` with a string emits UTF-8
  // without a BOM, which the package-wide BOM test relies on.
  const temporary = `${localPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  renameSync(temporary, localPath);
  return { written: Object.keys(models).length, removed: remove.length };
}

/**
 * Snapshot format 2 drops the cache-write bucket and the 16-field settlement
 * summary. Older files are ignored rather than half-parsed: the session log is
 * the source of truth, so a cold start simply replays and recomputes with the
 * new price book. This also prevents a 0.3.x summary from rolling back money
 * under the wrong layout.
 */
const SNAPSHOT_VERSION = 2;
const SNAPSHOT_MAX_SESSIONS = 512;
const INSTANCE_STARTED_AT = Date.now();

function snapshotTarget(config) {
  const configured =
    typeof config.snapshotPath === 'string' && config.snapshotPath.trim()
      ? config.snapshotPath.trim()
      : null;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const basePath = configured || join(home, 'budget-guard', 'snapshots.json');
  const file = basename(basePath);
  return {
    dir: dirname(basePath),
    stem: file.replace(/\.json$/i, ''),
    legacy: basePath,
    instance: join(dirname(basePath), `${file.replace(/\.json$/i, '')}.${process.pid}.${INSTANCE_STARTED_AT}.json`),
  };
}

function serializableState(state, config) {
  const keepTurns = clamp(num(config && config.snapshotKeepTurns) || DEFAULTS.snapshotKeepTurns, 1, 100);
  const minTurn = Math.max(0, state.currentTurn - keepTurns);
  const charges = [...state.stepCharges.entries()].filter(([key]) => {
    const parts = key.split(':');
    const turn = Number(parts[parts.length - 2]);
    return !Number.isFinite(turn) || turn > minTurn;
  });
  return {
    sessionId: state.sessionId,
    parentSessionId: state.parentSessionId || null,
    lastSeq: state.lastSeq,
    turns: state.turns,
    turnsCompleted: state.turnsCompleted,
    steps: state.steps,
    toolCalls: state.toolCalls,
    inputTokens: state.inputTokens,
    inputMissTokens: state.inputMissTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    totalTokens: state.totalTokens,
    cost: state.cost,
    shadowCost: state.shadowCost,
    costBreakdown: state.costBreakdown,
    byModel: state.byModel,
    byTier: state.byTier,
    unknownTokens: state.unknownTokens,
    unknownModels: state.unknownModels,
    lastModel: state.lastModel,
    lastTier: state.lastTier,
    invalidTimeMessages: state.invalidTimeMessages,
    timezoneWarned: state.timezoneWarned,
    priceWarnings: state.priceWarnings,
    currentTurn: state.currentTurn,
    turnStartCost: state.turnStartCost,
    turnStartTokens: state.turnStartTokens,
    turnSteps: state.turnSteps,
    turnToolCalls: state.turnToolCalls,
    planSteps: state.planSteps,
    planTurn: state.planTurn || null,
    lastTurn: state.lastTurn,
    // Recent per-turn burn is what the UI shows when the model stated no plan.
    // Keep the last few so a cold start can show it without replaying every turn.
    turnSummaries: Array.isArray(state.turnSummaries) ? state.turnSummaries.slice(-3) : [],
    estimate: state.estimate,
    preEstimate: state.preEstimate,
    override: state.override,
    manualPending: state.manualPending,
    manualSuppressed: state.manualSuppressed,
    manualContinues: state.manualContinues,
    grantCost: state.grantCost,
    grantTokens: state.grantTokens,
    stopReason: state.stopReason,
    lastStopAt: num(state.lastStopAt),
    lastStopKind: state.lastStopKind || null,
    guardDisabled: !!state.guardDisabled,
    guardDisabledAt: num(state.guardDisabledAt),
    replacedSettlements: state.replacedSettlements,
    lastReplacementAt: state.lastReplacementAt,
    blockedSettlements: state.blockedSettlements,
    settledTrimmed: !!state.settledTrimmed,
    settledOverflow: !!state.settledOverflow,
    settledOverflowWarned: !!state.settledOverflowWarned,
    settledEvicted: num(state.settledEvicted),
    settledSeqWatermark: num(state.settledSeqWatermark),
    settledCharges: [...state.settledCharges.entries()].map(([key, value]) => [
      key,
      value === true ? null : value,
    ]),
    stepCharges: charges,
  };
}

function stateFromSnapshot(snapshot, savedAt) {
  const state = blankState(snapshot.sessionId);
  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'sessionId' || key === 'stale' || key === 'snapshotAt' || key === 'settledKeys') continue;
    if (key === 'settledCharges') continue;
    state[key] = value;
  }
  state.byModel = snapshot.byModel && typeof snapshot.byModel === 'object' ? snapshot.byModel : {};
  state.byTier = snapshot.byTier && typeof snapshot.byTier === 'object'
    ? snapshot.byTier
    : { peak: { cost: 0, tokens: 0 }, offpeak: { cost: 0, tokens: 0 } };
  state.unknownModels = snapshot.unknownModels && typeof snapshot.unknownModels === 'object' ? snapshot.unknownModels : {};
  state.planTurn = num(snapshot.planTurn) || null;
  state.turnSummaries = Array.isArray(snapshot.turnSummaries) ? snapshot.turnSummaries.slice(-30) : [];
  const snapshotBreakdown =
    snapshot.costBreakdown && typeof snapshot.costBreakdown === 'object' ? snapshot.costBreakdown : {};
  state.costBreakdown = {
    inputMiss: num(snapshotBreakdown.inputMiss),
    inputHit: num(snapshotBreakdown.inputHit),
    output: num(snapshotBreakdown.output),
  };
  state.priceWarnings = Array.isArray(snapshot.priceWarnings) ? snapshot.priceWarnings : [];
  state.stepCharges = new Map(Array.isArray(snapshot.stepCharges) ? snapshot.stepCharges : []);
  state.settledCharges = new Map();
  if (Array.isArray(snapshot.settledCharges)) {
    for (const entry of snapshot.settledCharges) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [key, value] = entry;
      state.settledCharges.set(String(key), Array.isArray(value) ? value : true);
    }
  } else if (Array.isArray(snapshot.settledKeys)) {
    // Pre-0.3 snapshot: only the keys were stored. Rebuild a summary for the
    // ones still carrying a full Charge; the rest stay "settled, detail gone".
    for (const key of snapshot.settledKeys) {
      const charge = state.stepCharges.get(String(key));
      state.settledCharges.set(String(key), charge ? summarizeCharge(charge) : true);
    }
  } else {
    for (const key of state.stepCharges.keys()) {
      state.settledCharges.set(key, summarizeCharge(state.stepCharges.get(key)));
    }
  }
  state.settledTrimmed = !!snapshot.settledTrimmed;
  state.settledOverflow = !!snapshot.settledOverflow;
  state.settledOverflowWarned = !!snapshot.settledOverflowWarned;
  state.settledEvicted = num(snapshot.settledEvicted);
  // Legacy snapshots have no watermark: the safest derivation is "everything the
  // log had reached at save time was settled", i.e. lastSeq. A watermark that is
  // too high only suppresses adoption (refuse instead of double-bill), which is
  // the direction this plugin always prefers.
  state.settledSeqWatermark = num(snapshot.settledSeqWatermark) || num(snapshot.lastSeq);
  state.settledSummaries = 0;
  for (const value of state.settledCharges.values()) {
    if (Array.isArray(value)) state.settledSummaries += 1;
  }
  state.blockedSettlements = num(snapshot.blockedSettlements);
  state.stale = true;
  state.snapshotAt = savedAt;
  state.snapshotLastSeq = snapshot.lastSeq || 0;
  return state;
}

function loadSnapshotFile(config, warn) {
  const snapshots = new Map();
  if (!config.enableSnapshot) return snapshots;
  const target = snapshotTarget(config);
  let names = [];
  try {
    names = readdirSync(target.dir)
      .filter((name) => name === `${target.stem}.json` || (name.startsWith(`${target.stem}.`) && name.endsWith('.json')))
      .sort();
  } catch (error) {
    if (!error || error.code !== 'ENOENT') warn?.(`snapshot directory read failed: ${String(error)}`);
    return snapshots;
  }
  for (const name of names) {
    const path = join(target.dir, name);
    try {
      const decoded = JSON.parse(readFileSync(path, 'utf8'));
      if (!decoded || decoded.version !== SNAPSHOT_VERSION || typeof decoded.sessions !== 'object') {
        warn?.(`snapshot version mismatch or malformed: ${path}`);
        continue;
      }
      const savedAt = Number(decoded.savedAt) || 0;
      for (const [id, snapshot] of Object.entries(decoded.sessions)) {
        if (!snapshot || typeof snapshot !== 'object' || !snapshot.sessionId) continue;
        const existing = snapshots.get(String(id));
        if (!existing || savedAt >= (existing.snapshotAt || 0)) {
          snapshots.set(String(id), stateFromSnapshot(snapshot, savedAt));
        }
      }
    } catch (error) {
      warn?.(`snapshot read failed (${path}): ${String(error)}`);
    }
  }
  return snapshots;
}

/**
 * Merge a newer (or equally advanced) disk snapshot with this instance.
 *
 * `lastSeq` is per-session and monotonic: it is the highest `session/event.seq`
 * this state has folded, so the larger value means "further into the same log".
 * The disk is therefore the base.
 *
 * **A merge never adds money.** That is a theorem, not a policy:
 *  - the merge path requires `disk.lastSeq >= memory.lastSeq`;
 *  - every charge this instance holds was created by an event with
 *    `seq <= memory.lastSeq`, so `seq <= disk.lastSeq` for all of them.
 * The disk's totals already contain every one of those settlements — including
 * the ones it *evicted* from `settledCharges` (eviction drops the record, never
 * the money). Asking "does the base still list this key?" is therefore the
 * wrong question here; an evicted key would look brand new and get billed twice.
 * (0.3.1 asked exactly that and had this hole; 0.3.2 added the seq watermark,
 * 0.3.3 removes the money branch entirely because it is unreachable.)
 *
 * What a merge does contribute is *records*: every local key the base does not
 * name becomes a **marker** (`true`: "already billed", no money, no summary) so
 * a later retry of that step is refused instead of re-billed. A summary is never
 * carried: the base billed that step at the base's amount and a local summary
 * could differ from it.
 *
 * PRECONDITION: `base.lastSeq >= local.lastSeq`. The caller guarantees it (see
 * `persistSnapshotFile`), and under it every local `seq` is also
 * `<= max(base.lastSeq, base.settledSeqWatermark)`, so no "newer than the base"
 * case exists and no seq gate is needed here. 0.3.2/0.3.3 kept such a gate; it
 * was unreachable from the only caller, and its counter was always 0 — the same
 * dead-branch mistake as the old `adopted` path. If a second call site ever
 * appears with a different direction, the gate must come back *with* a
 * reachable reason, not "defensively".
 */
function mergeSnapshotState(base, local, config) {
  const cap = clamp(
    num(config && config.perSessionMaxSettled) || DEFAULTS.perSessionMaxSettled,
    1,
    50000,
  );
  const hard = cap * 2;
  let markers = 0;
  let dropped = 0;

  // One pass over the union of what this instance remembers, so a key that is
  // both in `stepCharges` and `settledCharges` is counted once.
  const localKeys = new Map();
  for (const [key, charge] of local.stepCharges) localKeys.set(key, charge);
  for (const [key, value] of local.settledCharges) {
    if (localKeys.has(key)) continue;
    localKeys.set(key, Array.isArray(value) ? chargeFromSummary(value) : null);
  }

  for (const key of localKeys.keys()) {
    if (base.settledCharges.has(key) || base.stepCharges.has(key)) {
      dropped += 1;
      continue;
    }
    if (base.settledCharges.size >= hard) continue;
    base.settledCharges.set(key, true);
    markers += 1;
  }
  for (const key of [
    'turns',
    'turnsCompleted',
    'steps',
    'toolCalls',
    'inputTokens',
    'inputMissTokens',
    'outputTokens',
    'cacheReadTokens',
    'totalTokens',
    'replacedSettlements',
    'blockedSettlements',
    'invalidTimeMessages',
    'manualContinues',
  ]) {
    base[key] = Math.max(num(base[key]), num(local[key]));
  }
  base.lastSeq = Math.max(num(base.lastSeq), num(local.lastSeq));
  base.snapshotLastSeq = num(base.snapshotLastSeq);
  base.override = base.override || local.override || null;
  base.manualSuppressed = !!base.manualSuppressed || !!local.manualSuppressed;
  base.manualPending = !!base.manualPending;
  base.grantCost = Math.max(num(base.grantCost), num(local.grantCost));
  base.grantTokens = Math.max(num(base.grantTokens), num(local.grantTokens));
  base.planSteps = base.planSteps || local.planSteps || null;
  base.stopReason = base.stopReason || local.stopReason || null;
  base.settledTrimmed = !!base.settledTrimmed || !!local.settledTrimmed;
  base.settledOverflow = !!base.settledOverflow || !!local.settledOverflow;
  base.settledEvicted = Math.max(num(base.settledEvicted), num(local.settledEvicted));
  base.settledSeqWatermark = Math.max(
    num(base.settledSeqWatermark),
    num(local.settledSeqWatermark),
    num(base.lastSeq),
  );
  base.stale = false;
  return { state: base, markers, dropped };
}

/** Exported for the boundary tests that pin the merge's money rule. */
export { mergeSnapshotState, serializableState, stateFromSnapshot };

/**
 * Snapshot-competition warns fire once per flush, and a flush happens on every
 * assistant message. Two windows trading writes would otherwise flood the log
 * with "snapshot merge for …" and hide anything that actually matters.
 *
 * Rule: **pure rate limit** — one report per key per minute, whatever the
 * numbers say, because every one of these messages carries counts that change
 * on each flush ("content changed" would always be true and throttle nothing).
 * The suppressed total rides along as `(+N)`, and the counter resets with each
 * emission, so it means "in the minute since the last report", not a lifetime
 * tally.
 */
const WARN_THROTTLE_MS = 60 * 1000;
const warnThrottle = new Map();

function throttledWarn(gate, warn, key, message) {
  if (typeof warn !== 'function' || !gate) return;
  const now = Date.now();
  const previous = gate.get(key);
  if (previous && now - previous.at < WARN_THROTTLE_MS) {
    previous.suppressed += 1;
    return;
  }
  if (gate.size > 512) gate.clear();
  const suppressed = previous ? previous.suppressed : 0;
  gate.set(key, { at: now, suppressed: 0, message });
  warn(suppressed > 0 ? `${message} (+${suppressed} identical suppressed)` : message);
}

function persistSnapshotFile(config, states, snapshots, warn, gate, options) {
  if (!config.enableSnapshot) return;
  const target = snapshotTarget(config);
  const sessions = {};
  const now = Date.now();
  const maxSessions = clamp(num(config.snapshotMaxSessions) || DEFAULTS.snapshotMaxSessions, 1, SNAPSHOT_MAX_SESSIONS);
  const maxAgeDays = Math.max(0, num(config.snapshotMaxAgeDays));
  const merged = new Map([...snapshots, ...states]);
  const candidates = [];
  for (const [id, state] of merged) {
    const active = states.has(id);
    const stamp = state.snapshotAt || (state.lastTurn && state.lastTurn.endTime) || (state.estimate && state.estimate.at) || 0;
    if (!active && maxAgeDays > 0 && stamp > 0 && now - stamp > maxAgeDays * 24 * 60 * 60 * 1000) continue;
    candidates.push({ id, state, active, stamp });
  }
  candidates.sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    return right.stamp - left.stamp;
  });
  const activeCandidates = candidates.filter((candidate) => candidate.active);
  const inactiveCandidates = candidates.filter((candidate) => !candidate.active);
  const selected = [
    ...activeCandidates,
    ...inactiveCandidates.slice(0, Math.max(0, maxSessions - activeCandidates.length)),
  ];
  const diskLatest = loadSnapshotFile(config, () => {});
  for (const candidate of selected) {
    // A session whose cache was just discarded must not be reconciled with
    // anything on disk: the point of the reset is that the log decides again.
    // Merging here would hand the turtle back to whichever file still holds the
    // old numbers (its lastSeq is legitimately higher than a fresh replay's).
    const pinned = typeof options.skipMerge === 'function' && options.skipMerge(candidate.id);
    const latest = pinned ? undefined : diskLatest.get(candidate.id);
    let source = candidate.state;
    if (latest && latest.lastSeq > candidate.state.lastSeq) {
      // The disk instance folded further into the same log: it is the base.
      // Every key this instance holds becomes a marker (no money: see the
      // theorem in `mergeSnapshotState`).
      const merged = mergeSnapshotState(latest, candidate.state, config);
      throttledWarn(
        gate,
        warn,
        `merge:${candidate.id}`,
        `snapshot merge for ${candidate.id}: disk lastSeq ${latest.lastSeq} > memory ${candidate.state.lastSeq}; ` +
          `kept ${merged.markers} marker(s) without money, dropped ${merged.dropped} already-known key(s); ` +
          `lastSeq -> ${merged.state.lastSeq}`,
        true,
      );
      source = merged.state;
    } else if (latest && latest.lastSeq === candidate.state.lastSeq) {
      // Same log position. This instance stays the writer so its recent detail
      // remains replaceable; the only things taken from the disk are the
      // watermark (never allowed to regress) and an audit note about disk-side
      // step detail this write is about to drop.
      let droppedDetail = 0;
      for (const key of latest.stepCharges.keys()) {
        if (!candidate.state.stepCharges.has(key) && !candidate.state.settledCharges.has(key)) {
          droppedDetail += 1;
        }
      }
      if (num(latest.settledSeqWatermark) > num(candidate.state.settledSeqWatermark)) {
        throttledWarn(
          gate,
          warn,
          `restore:${candidate.id}`,
          `snapshot watermark restore for ${candidate.id}: disk settledSeqWatermark ${latest.settledSeqWatermark} ` +
            `> memory ${candidate.state.settledSeqWatermark} at the same lastSeq ${latest.lastSeq}`,
          true,
        );
        candidate.state.settledSeqWatermark = num(latest.settledSeqWatermark);
      }
      if (droppedDetail > 0) {
        // Accepted trade-off, recorded so it is not silent: this instance's
        // window wins for replacement purposes, but the disk had detail for
        // steps this instance never saw.
        throttledWarn(
          gate,
          warn,
          `dropped:${candidate.id}`,
          `snapshot detail dropped for ${candidate.id}: ${droppedDetail} disk-side step(s) at the same ` +
            `lastSeq ${latest.lastSeq} are not in this instance; this instance writes the file`,
          true,
        );
      }
    }
    const encoded = serializableState(source, config);
    if (encoded.stepCharges.length < source.stepCharges.size && !source.chargeTrimWarned) {
      source.chargeTrimWarned = true;
      warn?.(`stepCharges trimmed to the last ${config.snapshotKeepTurns} turns; older retries use settledCharges summaries instead of being refused`);
    }
    sessions[candidate.id] = encoded;
  }
  try {
    mkdirSync(target.dir, { recursive: true });
    const temp = `${target.instance}.tmp`;
    writeFileSync(temp, JSON.stringify({ version: SNAPSHOT_VERSION, savedAt: now, sessions }), 'utf8');
    renameSync(temp, target.instance);
    if (maxAgeDays > 0) {
      const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
      for (const name of readdirSync(target.dir)) {
        if (name === `${target.stem}.json`) continue;
        if (!name.startsWith(`${target.stem}.`) || !name.endsWith('.json')) continue;
        const candidate = join(target.dir, name);
        if (candidate === target.instance) continue;
        const suffix = name.slice(target.stem.length + 1, -'.json'.length);
        const [pidText, startText] = suffix.split('.');
        const pid = Number(pidText);
        const startTs = Number(startText);
        if (!Number.isInteger(pid) || !Number.isFinite(startTs)) continue;
        // Our own pid from an earlier life (pid reuse): the file can never be
        // written again, so it is always safe to remove.
        if (pid === process.pid && startTs !== INSTANCE_STARTED_AT) {
          try {
            unlinkSync(candidate);
          } catch {
            // Already gone.
          }
          continue;
        }
        if (pidAlive(pid)) continue;
        try {
          if (statSync(candidate).mtimeMs < cutoff) unlinkSync(candidate);
        } catch {
          // Another instance may remove its own file concurrently.
        }
      }
    }
  } catch (error) {
    warn?.(`snapshot write failed: ${String(error)}`);
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user; anything
    // other than an explicit ESRCH is treated as alive to avoid deleting data.
    return error && error.code !== 'ESRCH';
  }
}

function cancelAgent(ctx, agent, state, reason) {
  if (state.cancelRequested) return;
  state.cancelRequested = true;
  state.stopReason = 'budget';
  try {
    if (agent && typeof agent.cancel === 'function') {
      agent.cancel({ kind: 'hook', reason: reason || `${PLUGIN_ID}: budget threshold reached` }, { keepInbox: true });
    } else {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] agent.cancel() unavailable; budget stop could not cancel the turn`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] budget cancel failed: ${String(error)}`);
  }
}

function cancelUser(ctx, agent, state) {
  state.stopReason = 'user';
  state.manualPending = false;
  clearStop(state);
  try {
    if (agent && typeof agent.cancel === 'function') {
      agent.cancel({ kind: 'user' });
    }
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] user cancel failed: ${String(error)}`);
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config);
  const states = new Map();
  /** Filled in when the webServer service is available; see sameOrigin(). */
  const bind = { checked: false, loopback: true, host: '', origin: '', lastReject: null };
  const holidayInfo = normalizeHolidays(
    cfg.holidays,
    (message) => ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`),
    cfg.useBuiltinHolidays !== false,
  );
  const priceInfo = loadPriceBook();
  for (const warning of priceInfo.warnings) ctx.logger?.warn?.(`[${PLUGIN_ID}] ${warning}`);
  const pricing = {
    book: priceInfo.book,
    holidays: holidayInfo.dates,
    sources: priceInfo.sources,
    origins: priceInfo.origins,
    localPath: priceInfo.localPath,
    holidaysSource: holidayInfo.source,
    warnings: priceInfo.warnings,
    logger: ctx.logger,
  };

  /**
   * Re-read the price files in place so a save takes effect on the next
   * `assistant/message` without restarting DSH. Already settled charges keep
   * the unit price they were billed at (`charge.price`); only future
   * settlements use the new book.
   */
  const refreshPriceBook = () => {
    const info = loadPriceBook();
    pricing.book = info.book;
    pricing.sources = info.sources;
    pricing.origins = info.origins;
    pricing.localPath = info.localPath;
    pricing.warnings = info.warnings;
    for (const warning of info.warnings) ctx.logger?.warn?.(`[${PLUGIN_ID}] ${warning}`);
    return info;
  };
  const snapshots = loadSnapshotFile(cfg, (message) => ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`));
  let snapshotTimer = null;
  // Per-instance warn gate: a plugin reload starts a fresh one, and one test
  // harness cannot silence another one's diagnostics.
  const warnGate = new Map();
  const persistSnapshots = () => {
    persistSnapshotFile(
      cfg,
      states,
      snapshots,
      (message) => ctx.logger?.warn?.(`[${PLUGIN_ID}] ${message}`),
      warnGate,
      { skipMerge: (id) => resetSessions.has(id) },
    );
  };
  const scheduleSnapshot = () => {
    if (!cfg.enableSnapshot || snapshotTimer) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      persistSnapshots();
    }, 1500);
    if (snapshotTimer && typeof snapshotTimer.unref === 'function') snapshotTimer.unref();
  };

  const remember = (state) => {
    states.set(state.sessionId, state);
    if (states.size > MAX_SESSIONS) {
      const oldest = states.keys().next().value;
      if (oldest !== undefined && oldest !== state.sessionId) states.delete(oldest);
    }
    return state;
  };

  /** Sessions whose cached snapshot was discarded on purpose (`/budget reset-snapshot`). */
  const resetSessions = new Set();

  const stateForSession = (session) => {
    if (!session || session.id === undefined) return undefined;
    const id = String(session.id);
    const existing = states.get(id);
    if (existing) return existing;
    const snapshot = resetSessions.has(id) ? undefined : snapshots.get(id);
    const state = remember(blankState(id));
    state.parentSessionId =
      (session.header && session.header.parentSession) || (snapshot && snapshot.parentSessionId) || null;
    if (snapshot && snapshot.lastSeq > 0) {
      const seeded = stateFromSnapshot(serializableState(snapshot, cfg), snapshot.snapshotAt);
      Object.assign(state, seeded, {
        sessionId: id,
        parentSessionId: state.parentSessionId,
        stale: true,
      });
      state.lastSeq = snapshot.lastSeq;
    }
    let eventsHaveNew = false;
    try {
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
      eventsHaveNew = !!snapshot && events.some((event) => typeof event.seq === 'number' && event.seq > snapshot.lastSeq);
      foldSession(state, events, cfg, pricing);
      if (eventsHaveNew) state.stale = false;
    } catch (error) {
      ctx.logger?.warn?.(`[${PLUGIN_ID}] could not replay session ${id}: ${String(error)}`);
    }
    if (snapshot) {
      if (state.lastSeq >= snapshot.lastSeq && eventsHaveNew) {
        snapshots.delete(id);
      } else {
        state.stale = true;
        state.snapshotAt = snapshot.snapshotAt;
      }
    }
    scheduleSnapshot();
    return state;
  };

  const stateForAgent = (agent) => {
    const session = agent && agent.session ? agent.session : ctx.get('sessions')?.get?.(agent?.id);
    return session ? stateForSession(session) : undefined;
  };

  const computeAggregate = (sessionId) => {
    const all = new Map([...snapshots, ...states]);
    const self = all.get(String(sessionId));
    if (!self) return null;
    const children = [];
    const seen = new Set([String(sessionId)]);
    const collect = (parentId, depth) => {
      if (depth > 8) return;
      for (const [id, state] of all) {
        if (seen.has(id) || state.parentSessionId !== parentId) continue;
        seen.add(id);
        children.push({
          sessionId: id,
          cost: state.cost,
          tokens: state.totalTokens,
          stale: !!state.stale,
          depth: depth + 1,
          live: states.has(id),
        });
        collect(id, depth + 1);
      }
    };
    collect(String(sessionId), 0);
    if (children.length === 0) return null;
    const childrenCost = children.reduce((sum, child) => sum + child.cost, 0);
    const childrenTokens = children.reduce((sum, child) => sum + child.tokens, 0);
    return {
      self: { sessionId: self.sessionId, cost: self.cost, tokens: self.totalTokens, stale: !!self.stale },
      children,
      childrenCost,
      childrenTokens,
      totalCost: self.cost + childrenCost,
      totalTokens: self.totalTokens + childrenTokens,
      complete: children.every((child) => !child.stale && child.live),
      scope: 'discovered',
    };
  };

  const aggregateCache = new Map();
  const aggregateOf = (sessionId) => {
    const key = String(sessionId);
    const cached = aggregateCache.get(key);
    if (cached && Date.now() - cached.at < 500) return cached.value;
    const value = computeAggregate(sessionId);
    aggregateCache.set(key, { at: Date.now(), value });
    return value;
  };

  function applyEvent(state, event, replay) {
    if (!event || typeof event.type !== 'string') return;
    if (typeof event.seq === 'number') {
      if (event.seq <= state.lastSeq) return;
      if (state.stale && event.seq > (state.snapshotLastSeq || 0)) {
        state.stale = false;
        state.snapshotAt = 0;
      }
      state.lastSeq = event.seq;
    }
    const data = event.data || {};
    switch (event.type) {
      case 'turn/start': {
        state.currentTurn = num(data.turn) || state.currentTurn + 1;
        state.turnStartCost = state.cost;
        state.turnStartTokens = state.totalTokens;
        state.turnSteps = 0;
        state.turnToolCalls = 0;
        state.currentTurnText = '';
        // A plan belongs to one turn. Clearing it here keeps both the estimate
        // and `counters.planSteps` from leaking a previous turn's statement.
        state.planSteps = null;
        state.planTurn = null;
        state.cancelRequested = false;
        state.stopReason = null;
        if (!state.preEstimate && cfg.enablePreEstimate) {
          state.preEstimate = preEstimate(state, cfg);
        }
        break;
      }
      case 'step/start': {
        state.steps += 1;
        state.turnSteps += 1;
        break;
      }
      case 'tool/call': {
        state.toolCalls += 1;
        state.turnToolCalls += 1;
        break;
      }
      case 'assistant/message': {
        const message = data.message;
        if (data.usage) {
          applyUsage(
            state,
            data.usage,
            message && message.source,
            num(data.turn) || state.currentTurn,
            num(data.step) || state.turnSteps,
            event.time,
            pricing,
            cfg.perSessionMaxSettled,
            event.seq,
          );
        }
        const text = messageText(message);
        if (text) {
          state.lastAssistantText = text;
          state.currentTurnText += `\n${text}`;
          const plan = detectPlanSteps(text);
          if (plan) {
            state.planSteps = plan;
            state.planTurn = state.currentTurn;
          }
        }
        break;
      }
      case 'user/message': {
        if (!state.preEstimate && cfg.enablePreEstimate) {
          state.preEstimate = preEstimate(state, cfg);
        }
        break;
      }
      case 'command/run': {
        const commandName =
          typeof data.name === 'string'
            ? data.name
            : typeof data.commandName === 'string'
              ? data.commandName
              : '';
        const raw = data.rawInput ?? data.args ?? data.input ?? data.line;
        if (commandName.replace(/^\//, '') === 'budget' && typeof raw === 'string') {
          applyBudgetInput(state, raw, cfg);
        }
        break;
      }
      case 'turn/end': {
        state.currentTurn = num(data.turn) || state.currentTurn;
        closeTurn(state, event);
        if (!replay) {
          const limit = limitOf(state, cfg);
          maybeEstimate(state, cfg, false);
          if (configured(limit)) {
            const ratio = ratiosOf(state, limit).ratio;
            if (ratio >= num(cfg.warnRatio)) state.warnAnnounced = true;
            if (overThreshold(state, limit, cfg) && cfg.interceptMode === 'manual' && !state.manualSuppressed) {
              state.manualPending = true;
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function foldSession(state, events, config, priceContext) {
    if (!Array.isArray(events) || events.length === 0) return;
    for (const event of events) applyEvent(state, event, true);
    state.estimate = null;
    state.lastEstimateAt = 0;
    state.pricing = priceContext;
    if (config.enableTurnEstimate && state.steps > 0) {
      state.estimate = computeEstimate(state, config);
      state.lastEstimateAt = Date.now();
    }
  }

  ctx.effect(
    () => () => {
      if (snapshotTimer) {
        clearTimeout(snapshotTimer);
        snapshotTimer = null;
      }
      persistSnapshots();
      states.clear();
    },
    'budget-guard: session state + snapshot',
  );

  ctx.on('session/event', (session, event) => {
    const state = stateForSession(session);
    if (state) {
      applyEvent(state, event, false);
      // The aggregate only moves when money lands (assistant/message) or a
      // child session appears/disappears (`agent/created`/`agent/disposed`
      // below). Clearing on every streamed chunk made the 500ms cache useless.
      if (event.type === 'assistant/message') aggregateCache.clear();
      if (event.type === 'assistant/message' || event.type === 'turn/end' || event.type === 'command/run') {
        // Hot reload may re-require the module without running the effect
        // cleanup; a synchronous flush keeps the latest Charge visible.
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
        persistSnapshots();
      } else {
        scheduleSnapshot();
      }
    }
  });

  ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    stateForAgent(agent);
    aggregateCache.clear();
  });

  ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent;
    if (!agent) return;
    // Keep the derived state for the UI briefly; drop only the live marker.
    const state = states.get(String(agent.id));
    if (state) state.cancelRequested = false;
    aggregateCache.clear();
    scheduleSnapshot();
  });

  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload && payload.agent;
    const state = stateForAgent(agent);
    if (!state) return;
    const limit = limitOf(state, cfg);
    // No budget configured, or the user lifted the guard: never stop, never
    // prompt. This is the "don't interrupt someone who hasn't set a budget"
    // rule, and the reason `/budget unlock` works at the worst moment.
    if (!enforcementActive(state, limit)) return;
    if (overManualHardStop(state, limit, cfg)) {
      state.manualPending = false;
      state.lastStopAt = Date.now();
      state.lastStopKind = 'hard-stop';
      cancelAgent(
        ctx,
        agent,
        state,
        `${PLUGIN_ID}: manual hard stop at ${ratiosOf(state, limit).percent}% of ${budgetLabel(limit)}`,
      );
      return;
    }
    if (overThreshold(state, limit, cfg)) {
      state.warnAnnounced = true;
      if (cfg.interceptMode === 'auto') {
        // A pending manual prompt belongs to the previous stop. Leaving it set
        // while auto-cancelling makes the UI show "继续/不再提示/中止" instead
        // of the recovery row for the stop that actually happened.
        state.manualPending = false;
        state.lastStopAt = Date.now();
        state.lastStopKind = 'auto';
        cancelAgent(ctx, agent, state, `${PLUGIN_ID}: spent ${money(ratiosOf(state, limit).cost, limit.currency)} of ${budgetLabel(limit)}`);
      } else {
        if (!state.manualSuppressed) state.manualPending = true;
      }
      return;
    }
    if (warningRatioReached(state, limit, cfg)) state.warnAnnounced = true;
  });

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    if (!decision || decision.kind === 'reject') return decision;
    if (!cfg.enforceAtPreStep) return decision;
    const agent = payload && payload.agent;
    const state = stateForAgent(agent);
    if (!state) return decision;
    const limit = limitOf(state, cfg);
    if (!enforcementActive(state, limit) || !overThreshold(state, limit, cfg)) return decision;
    if (cfg.interceptMode === 'auto' || overManualHardStop(state, limit, cfg)) {
      state.manualPending = false;
      state.lastStopAt = Date.now();
      state.lastStopKind = 'pre-step';
      cancelAgent(ctx, agent, state, `${PLUGIN_ID}: budget exhausted before the next step`);
      return { kind: 'reject' };
    }
    if (state.manualSuppressed) return decision;
    state.manualPending = true;
    return decision;
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.effect(
      () =>
        commandCtx.commands.register({
          name: 'budget',
          description:
            '设置或查看本次任务预算：/budget 2.5、/budget 20000 tokens、/budget off、/budget continue、/budget abort、/budget unlock、/budget reset-snapshot、/budget prices、/budget debug',
          input: { hint: '2.5 | 20000 tokens | off | continue | abort | unlock | lock | reset-snapshot | prices | debug' },
          recordInput: true,
          handler: (invocation) => {
            const agent = invocation.agent;
            const session = agent && agent.session ? agent.session : commandCtx.get('sessions')?.get?.(agent?.id);
            const state = session ? stateForSession(session) : undefined;
            if (!state) return { kind: 'error', text: '无法读取当前会话的预算状态。' };
            // `command/run` is appended before this handler runs, so the
            // session/event fold has already applied the manual decision.
            // Re-applying it here would count one 继续 twice.
            const rawText = String(invocation.rawInput || '').trim();
            if (rawText.toLowerCase() === 'prices' || rawText === '价格') {
              return { kind: 'success', text: priceReport(pricing, state) };
            }
            if (rawText.toLowerCase().startsWith('debug') || rawText === '核对') {
              const requested = Number.parseInt(rawText.replace(/^\D+/, ''), 10);
              const limit = Number.isFinite(requested) ? clamp(requested, 1, 20) : 5;
              return { kind: 'success', text: debugReport(state, pricing, limit) };
            }
            if (rawText.toLowerCase() === 'reset-snapshot' || rawText === '重建') {
              // Escape hatch for a snapshot whose records can no longer be
              // rolled back (a pre-0.3.4 summary layout, a hand-edited file).
              //
              // This is a LIVE-ONLY operation: it deletes caches and seeds a
              // tombstone, so it must never be replayed from `command/run`
              // (that would wipe the cache on every restart). `applyBudgetInput`
              // recognises the word and does nothing, which is what the replay
              // hits; the effect below runs only in this handler.
              const id = String(state.sessionId);
              const carried = {
                manualPending: state.manualPending,
                manualSuppressed: state.manualSuppressed,
                manualContinues: state.manualContinues,
                grantCost: state.grantCost,
                grantTokens: state.grantTokens,
              };
              states.delete(id);
              snapshots.delete(id);
              resetSessions.add(id);
              if (snapshotTimer) {
                clearTimeout(snapshotTimer);
                snapshotTimer = null;
              }
              // Rebuild from the log right away, then persist a tombstone with a
              // fresh savedAt: the per-session winner on load is the newest
              // savedAt, so another instance's stale cache cannot resurrect the
              // numbers this command just dropped.
              let rebuilt = session ? stateForSession(session) : undefined;
              if (rebuilt) {
                // Manual decisions are the user's, not accounting: survive the
                // reset. Everything money-related is rebuilt from the log.
                Object.assign(rebuilt, carried);
                persistSnapshots();
              } else {
                rebuilt = state;
              }
              return {
                kind: 'success',
                text:
                  '已丢弃本会话的计费缓存与快照条目，并按会话日志重新计费（账目以日志为准）。' +
                  '保留「继续/不再提示」等手动决定与预算声明；其他实例若在之后写入新状态，仍以新状态为准。' +
                  '需要彻底清理时删除 $DSH_HOME/budget-guard/snapshots.*.json 后重启。',
              };
            }
            const result = applyBudgetInput(state, rawText, cfg, { skipManualActions: true });
            if (result.action === 'abort') cancelUser(ctx, agent, state);
            if (result.action === 'continue') {
              state.manualPending = false;
              result.text = `已允许继续；本次放行 10%，累计已放行 ${Math.min(100, state.manualContinues * 10)}%。`;
            }
            if (result.action === 'suppress') state.manualPending = false;
            return { kind: 'success', text: result.text };
          },
        }),
      'budget-guard: /budget command',
    );
  });

  ctx.inject(['webServer'], (webCtx) => {
    // `getOrigin()` reports the bind address the listener advertises. When it
    // is not loopback the exact-Origin rule becomes mandatory and the mutating
    // routes additionally require a loopback peer.
    try {
      const origin = typeof webCtx.webServer.getOrigin === 'function' ? webCtx.webServer.getOrigin() : '';
      if (origin) {
        const host = new URL(origin).hostname;
        bind.host = host;
        bind.origin = origin;
        bind.loopback = isLoopbackAddress(host) || host.toLowerCase() === 'localhost';
        bind.checked = true;
      }
    } catch (error) {
      bind.checked = false;
      ctx.logger?.warn?.(
        `[${PLUGIN_ID}] web server bind address unknown (${String(error)}); /config/save requires an exact Origin`,
      );
    }
    if (bind.checked && !bind.loopback) {
      ctx.logger?.warn?.(
        `[${PLUGIN_ID}] web server advertises ${bind.host}; /config/save and /action require a loopback client and an exact Origin`,
      );
    }
    if (cfg.requireLocalControl === false) {
      ctx.logger?.warn?.(
        `[${PLUGIN_ID}] requireLocalControl=false: any same-origin page on the network may change the budget`,
      );
    }
    if (cfg.requireLocalAction === false) {
      ctx.logger?.warn?.(
        `[${PLUGIN_ID}] requireLocalAction=false: a remote GUI may continue/abort a turn and set its session budget`,
      );
    }
    const routeOrigin = (request, requireOrigin, localOnly) =>
      sameOrigin(request, cfg, {
        requireOrigin,
        localOnly,
        bind,
        onReject: (reason, seen) => {
          // Record what the peer actually looked like. A user who hit the
          // "not local" 403 can read it back from `/dsh-budget/config` →
          // `server.lastReject`, instead of guessing whether a proxy rewrote
          // the address. Logged at most once a minute — a wrong peer would
          // otherwise repeat this on every settings save.
          bind.lastReject = { ...seen, reason };
          throttledWarn(
            warnGate,
            ctx.logger?.warn,
            'reject:last',
            `blocked ${reason}: remote=${seen.remote} host=${seen.host} origin=${seen.origin} ` +
              `sec-fetch-site=${seen.secFetchSite}`,
          );
        },
      });
    webCtx.effect(() => {
      const getRoute = webCtx.webServer.register({
        kind: 'exact',
        path: SURFACE_PATH,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          if (!routeOrigin(request, false, false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          const url = new URL(request.url || SURFACE_PATH, 'http://budget-guard.local');
          const sessionId = url.searchParams.get('sessionId');
          if (!sessionId) {
            sendJson(response, 200, { ok: true, state: null });
            return;
          }
          const session = webCtx.get('sessions')?.get?.(sessionId);
          let state = states.get(String(sessionId));
          if (!state) {
            const snapshot = snapshots.get(String(sessionId));
            if (session) {
              const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
              state = snapshot && events.length === 0 ? snapshot : stateForSession(session);
            } else {
              state = snapshot;
            }
          }
          if (!state) {
            sendJson(response, 200, { ok: true, state: null, loading: true });
            return;
          }
          const agent = webCtx.get('agents')?.get?.(sessionId);
          const running = !!(agent && agent.status === 'running');
          sendJson(response, 200, {
            ok: true,
            state: buildView(state, cfg, running, pricing, aggregateOf(sessionId)),
          });
        },
      });
      const postRoute = webCtx.webServer.register({
        kind: 'exact',
        path: ACTION_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          // Mutating: same peer rule as /config/save (abort/continue/set-budget
          // is exactly as powerful as changing the budget).
          if (!routeOrigin(request, false, cfg.requireLocalAction !== false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
            return;
          }
          const sessionId = body && typeof body.sessionId === 'string' ? body.sessionId : '';
          const action = body && typeof body.action === 'string' ? body.action : '';
          const agent = sessionId ? webCtx.get('agents')?.get?.(sessionId) : undefined;
          const session = sessionId ? webCtx.get('sessions')?.get?.(sessionId) : undefined;
          const state = session ? stateForSession(session) : sessionId ? states.get(sessionId) : undefined;
          if (!state) {
            sendJson(response, 404, { ok: false, error: 'unknown-session' });
            return;
          }
          if (action === 'set-budget') {
            if (!agent) {
              sendJson(response, 409, { ok: false, error: 'no-live-agent' });
              return;
            }
            const amount = num(body.amount);
            const tokenBudget = Math.round(num(body.tokens));
            if (amount <= 0 && tokenBudget <= 0) {
              // An explicit 0/0 is the API equivalent of `/budget off`: clear
              // the session override and return to the Config default. The
              // composer form never sends this, but it lets an operator clean
              // up a test override without typing a slash command.
              const cleared = applyBudgetInput(state, 'off', cfg);
              persistSnapshots();
              sendJson(response, 200, { ok: true, action: 'set-budget', cleared: true, message: cleared.text });
              return;
            }
            const line =
              amount > 0 && tokenBudget > 0
                ? `/budget both ${amount} ${tokenBudget}`
                : amount > 0
                  ? `/budget ${amount}`
                  : `/budget ${tokenBudget} tokens`;
            const commands = webCtx.get('commands');
            try {
              if (commands && typeof commands.execute === 'function') {
                await commands.execute(agent, line, [], new AbortController().signal);
              } else {
                state.override = {
                  ...(state.override || {}),
                  ...(amount > 0 ? { amount } : {}),
                  ...(tokenBudget > 0 ? { tokens: tokenBudget } : {}),
                };
                state.manualPending = false;
                state.manualSuppressed = false;
                state.guardDisabled = false;
                state.guardDisabledAt = 0;
                resetManualGrants(state);
                clearStop(state);
                state.estimate = computeEstimate(state, cfg);
              }
              // The action itself is a user decision: persist it now instead of
              // waiting for the next event, so a crash right after the click
              // cannot resurrect the previous locked/stopped state.
              persistSnapshots();
              sendJson(response, 200, { ok: true, action: 'set-budget' });
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error && error.message ? error.message : error) });
            }
            return;
          }
          if (action === 'abort') {
            if (!agent) {
              sendJson(response, 409, { ok: false, error: 'no-live-agent' });
              return;
            }
            cancelUser(ctx, agent, state);
            persistSnapshots();
            sendJson(response, 200, { ok: true, action: 'abort' });
            return;
          }
          if (action === 'suppress') {
            state.manualSuppressed = true;
            state.manualPending = false;
            state.manualDecidedAt = Date.now();
            clearStop(state);
            persistSnapshots();
            sendJson(response, 200, { ok: true, action: 'suppress' });
            return;
          }
          if (action === 'unlock') {
            // The escape hatch after a stop: the user keeps working, the guard
            // stops stopping this session. Money keeps being recorded.
            state.guardDisabled = true;
            state.guardDisabledAt = Date.now();
            state.manualPending = false;
            state.manualSuppressed = false;
            clearStop(state);
            persistSnapshots();
            sendJson(response, 200, { ok: true, action: 'unlock', disabled: true });
            return;
          }
          if (action === 'lock') {
            state.guardDisabled = false;
            state.guardDisabledAt = 0;
            state.manualPending = false;
            state.manualSuppressed = false;
            resetManualGrants(state);
            clearStop(state);
            state.estimate = computeEstimate(state, cfg);
            persistSnapshots();
            sendJson(response, 200, { ok: true, action: 'lock', disabled: false });
            return;
          }
          if (action === 'resume' || action === 'continue') {
            // `resume` is the recovery-row button: it both lifts the "stopped"
            // banner and grants the next 10%, which is what makes the session
            // usable again after an auto stop.
            const maxGranted = Math.max(0, num(cfg.maxGrantedPercent));
            if (state.manualContinues * 10 >= maxGranted) {
              sendJson(response, 200, {
                ok: false,
                error: 'grant-limit',
                message: `已达放行上限 ${maxGranted}%，请解除限制或 /budget off`,
              });
              return;
            }
            const limit = limitOf(state, cfg);
            state.manualPending = false;
            state.manualDecidedAt = Date.now();
            state.manualContinues += 1;
            clearStop(state);
            if (limit.amount > 0) state.grantCost = round6(state.cost + state.shadowCost + limit.amount * 0.1);
            if (limit.tokens > 0) state.grantTokens = state.totalTokens + limit.tokens * 0.1;
            persistSnapshots();
            sendJson(response, 200, { ok: true, action: 'continue', grantedPercent: state.manualContinues * 10 });
            return;
          }
          sendJson(response, 400, { ok: false, error: 'unknown-action' });
        },
      });
      const pricesGetRoute = webCtx.webServer.register({
        kind: 'exact',
        path: PRICES_PATH,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          // Read-only: the same origin rule as `/state` and `/config`, so a
          // remote GUI can *see* prices without being able to change them.
          if (!routeOrigin(request, false, false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          sendJson(response, 200, { ok: true, prices: pricePayload(pricing) });
        },
      });
      const pricesPostRoute = webCtx.webServer.register({
        kind: 'exact',
        path: PRICES_SAVE_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          // Changing a unit price changes every future settlement, so it has
          // the same blast radius as changing the global budget: loopback only
          // under the same `requireLocalControl` switch.
          if (!routeOrigin(request, true, cfg.requireLocalControl !== false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
            return;
          }
          const checked = validatePriceBody(body);
          if (checked.issues.length) {
            sendJson(response, 400, {
              ok: false,
              error: 'invalid',
              issues: checked.issues.map((item) => ({
                path: Array.isArray(item.path) ? item.path : [],
                message: item.message,
              })),
            });
            return;
          }
          try {
            const result = writeLocalPrices(pricing.localPath, checked.models, checked.remove);
            // Hot reload: no restart, no disable/enable. The next settlement
            // prices with the saved table; history is not rewritten on purpose.
            const info = refreshPriceBook();
            ctx.logger?.info?.(
              `[${PLUGIN_ID}] prices saved to ${info.localPath} ` +
                `(${result.written} model(s) written, ${result.removed} removed)`,
            );
            sendJson(response, 200, {
              ok: true,
              applied: true,
              written: result.written,
              removed: result.removed,
              localPath: info.localPath,
              prices: pricePayload(pricing),
            });
          } catch (error) {
            ctx.logger?.warn?.(`[${PLUGIN_ID}] could not save prices: ${String(error)}`);
            sendJson(response, 500, {
              ok: false,
              error: 'write-failed',
              message: String(error && error.message ? error.message : error),
            });
          }
        },
      });
      const configGetRoute = webCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_PATH,
        handler: async (request, response) => {
          if (request.method !== 'GET') {
            response.writeHead(405, { allow: 'GET' });
            response.end();
            return;
          }
          if (!routeOrigin(request, false, false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          sendJson(response, 200, {
            ok: true,
            config: {
              ...cfg,
              output: estimateOutputOf(cfg),
              holidaysSource: pricing.holidaysSource,
              priceSources: pricing.sources,
              // Answers "what is this listener bound to?" without guessing:
              // a non-loopback bind is what makes the header-only fallback
              // unsafe, so it is reported instead of being a TODO. `lastReject`
              // is the other half: when a save is refused, this is exactly what
              // the server saw (peer address included), which is how a proxy
              // rewrite gets diagnosed rather than guessed at.
              server: {
                origin: bind.origin,
                host: bind.host,
                loopback: bind.loopback,
                checked: bind.checked,
                lastReject: bind.lastReject || null,
              },
            },
          });
        },
      });
      const configPostRoute = webCtx.webServer.register({
        kind: 'exact',
        path: CONFIG_SAVE_PATH,
        handler: async (request, response) => {
          if (request.method !== 'POST') {
            response.writeHead(405, { allow: 'POST' });
            response.end();
            return;
          }
          if (!routeOrigin(request, true, cfg.requireLocalControl !== false)) {
            sendJson(response, 403, { ok: false, error: 'origin' });
            return;
          }
          let body;
          try {
            body = await readJsonBody(request);
          } catch (error) {
            sendJson(response, 400, { ok: false, error: String(error && error.message ? error.message : error) });
            return;
          }
          if (!isObject(body)) {
            sendJson(response, 400, { ok: false, error: 'bad-body' });
            return;
          }
          const patch = {};
          const unknown = [];
          for (const key of Object.keys(body)) {
            if (!SAVE_KEYS.includes(key)) {
              unknown.push(key);
              continue;
            }
            patch[key] = body[key];
          }
          if (unknown.length) {
            sendJson(response, 400, { ok: false, error: 'unknown-key', keys: unknown });
            return;
          }
          if (!Object.keys(patch).length) {
            sendJson(response, 400, { ok: false, error: 'empty-patch' });
            return;
          }
          // One authority for the whole Config shape: the saved row is exactly
          // what a manual `cordis.patch.yml` edit would produce, so cross-field
          // rules (warnRatio ≤ interceptRatio, grant < hard stop) are enforced
          // here instead of being duplicated per field.
          const validated = validateConfig({ ...cfg, ...patch });
          if (validated.issues && validated.issues.length) {
            sendJson(response, 400, {
              ok: false,
              error: 'invalid',
              // One shape for every consumer: `path` localizes the field,
              // `message` is what the settings page shows verbatim.
              issues: validated.issues.map((item) => ({
                path: Array.isArray(item.path) ? item.path : [],
                message: item.message,
              })),
            });
            return;
          }
          const clean = {};
          for (const key of Object.keys(patch)) clean[key] = validated.value[key];
          const editor = webCtx.get('configEditor');
          if (!editor || typeof editor.edit !== 'function') {
            sendJson(response, 503, { ok: false, error: 'config-editor-unavailable' });
            return;
          }
          let entry;
          try {
            entry = editor
              .entries()
              .find(
                (candidate) =>
                  candidate?.options?.id === 'budget-guard' ||
                  candidate?.id === 'budget-guard' ||
                  candidate?.id === 'include:budget-guard',
              );
          } catch (error) {
            sendJson(response, 503, { ok: false, error: String(error && error.message ? error.message : error) });
            return;
          }
          if (!entry) {
            sendJson(response, 404, { ok: false, error: 'entry-not-found' });
            return;
          }
          // Answer before the edit restarts this plugin: the route belongs to
          // the fiber that is about to be reloaded.
          sendJson(response, 200, { ok: true, applying: true });
          Promise.resolve()
            .then(() => editor.edit(entry, (current) => ({ ...current, ...clean })))
            .catch((error) => ctx.logger?.warn?.(`[${PLUGIN_ID}] config save failed: ${String(error)}`));
        },
      });
      return () => {
        getRoute();
        postRoute();
        pricesGetRoute();
        pricesPostRoute();
        configGetRoute();
        configPostRoute();
      };
    }, 'budget-guard: HTTP routes');
  });
}

/**
 * Request authentication for the HTTP routes.
 *
 * Headers are not credentials: `Origin` and `Sec-Fetch-Site` are both plain
 * request headers, so any script can forge either. The only signal a client
 * cannot forge is its TCP peer address, which is why the mutating routes
 * require a loopback peer by default. The two switches are separate because the
 * blast radius differs: `/config/save` changes the global budget
 * (`requireLocalControl`), while `/action` continues/aborts one turn and sets
 * its session budget (`requireLocalAction`). Both default to `true`; a GUI
 * served to another machine cannot mutate anything until the owner opts out,
 * and the README states the trade-off.
 *
 * Scope: reads stay same-origin so a remote GUI still shows its own numbers.
 */
function isLoopbackAddress(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  // Strip brackets and a zone suffix (`fe80::1%eth0`) before looking at it.
  const address = value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // v6 loopback, in the short and the fully expanded spelling.
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  // v4 and v4-mapped-v6 in the dotted spelling.
  if (/^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address)) return true;
  // v4-mapped-v6 in the HEX spelling (`::ffff:7f00:1`), which some stacks and
  // proxies report instead of `::ffff:127.0.0.1`. This is the form that used
  // to be rejected and cost a real user a "not local" 403.
  const hexMapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return high >> 8 === 127;
  }
  return false;
}

function remoteAddressOf(request) {
  const socket = request && request.socket;
  return socket && typeof socket.remoteAddress === 'string' ? socket.remoteAddress : undefined;
}

/** What the server actually saw, for a 403 the user has to explain. */
function describeRequest(request) {
  const headers = (request && request.headers) || {};
  const forwarded = headers['x-forwarded-for'];
  return {
    remote: remoteAddressOf(request) || null,
    forwardedFor: typeof forwarded === 'string' ? forwarded : null,
    host: typeof headers.host === 'string' ? headers.host : null,
    origin: typeof headers.origin === 'string' ? headers.origin : null,
    secFetchSite: typeof headers['sec-fetch-site'] === 'string' ? headers['sec-fetch-site'] : null,
    at: Date.now(),
  };
}

/**
 * Does `Host` name this listener? This is the DNS-rebinding guard: a page on
 * `evil.com` that resolves to 127.0.0.1 still sends `Host: evil.com`, so the
 * header — not the peer address — is what proves the request was aimed here.
 *
 * `localhost:<port>` is accepted as an alias of a loopback bind, and a
 * configured `allowedOrigins` entry may name a reverse proxy's host.
 */
function hostNamesThisListener(headers, config, bind) {
  const host = typeof headers.host === 'string' ? headers.host.toLowerCase() : '';
  if (!host) return false;
  const allowed = [];
  if (bind && bind.checked && bind.origin) {
    try {
      const url = new URL(bind.origin);
      allowed.push(url.host.toLowerCase());
      if (url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost') {
        allowed.push(`localhost:${url.port}`.toLowerCase());
        allowed.push(`127.0.0.1:${url.port}`.toLowerCase());
      }
    } catch {
      // An unparsable origin just means "no allowlist from the listener".
    }
  }
  if (allowed.includes(host)) return true;
  const origins = config && Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
  return origins.some((entry) => {
    if (typeof entry !== 'string') return false;
    try {
      return new URL(entry).host.toLowerCase() === host;
    } catch {
      return false;
    }
  });
}

/** Split a Host header into its lowercase hostname and optional port. */
function splitHostHeader(value) {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!text) return null;
  if (text.startsWith('[')) {
    const end = text.indexOf(']');
    if (end < 0) return null;
    const rest = text.slice(end + 1);
    if (rest && !rest.startsWith(':')) return null;
    return { hostname: text.slice(1, end), port: rest ? rest.slice(1) : '' };
  }
  const index = text.lastIndexOf(':');
  if (index > 0 && /^\d+$/.test(text.slice(index + 1))) {
    return { hostname: text.slice(0, index), port: text.slice(index + 1) };
  }
  return { hostname: text, port: '' };
}

/**
 * Does this `Host` header name a loopback listener? This is deliberately
 * independent of `getOrigin()`: when the Host service cannot report its bind
 * address, a local request that says `Host: localhost:PORT` is still provably
 * aimed at this machine. DNS rebinding cannot forge a loopback Host for a page
 * loaded from a remote origin, and a remote peer is already refused by the
 * `localOnly` check.
 */
function isLoopbackHostHeader(value) {
  const parts = splitHostHeader(value);
  if (!parts) return false;
  return parts.hostname === 'localhost' || isLoopbackAddress(parts.hostname);
}

/** Exact host match, with localhost / 127.0.0.1 / [::1] treated as aliases. */
function originMatchesHost(originUrl, hostHeader) {
  const header = typeof hostHeader === 'string' ? hostHeader.trim().toLowerCase() : '';
  if (!header) return false;
  if (originUrl.host.toLowerCase() === header) return true;
  const parts = splitHostHeader(header);
  if (!parts) return false;
  const defaultPort = originUrl.protocol === 'https:' ? '443' : '80';
  const originPort = originUrl.port || defaultPort;
  const headerPort = parts.port || defaultPort;
  if (originPort !== headerPort) return false;
  const originHost = originUrl.hostname.toLowerCase();
  if (originHost === parts.hostname) return true;
  const originLoopback = originHost === 'localhost' || isLoopbackAddress(originHost);
  return originLoopback && isLoopbackHostHeader(header);
}

function sameOrigin(request, config, options) {
  const settings = options || {};
  const requireOrigin = !!settings.requireOrigin;
  const localOnly = !!settings.localOnly;
  const bind = settings.bind || null;
  const headers = (request && request.headers) || {};
  const remote = remoteAddressOf(request);
  const deny = (reason) => {
    if (typeof settings.onReject === 'function') {
      settings.onReject(reason, describeRequest(request));
    }
    return false;
  };
  const remoteKnown = remote !== undefined;
  const localPeer = remoteKnown ? isLoopbackAddress(remote) : true;

  // A peer that is not on this machine is refused outright for the mutating
  // routes; a read from a remote GUI keeps working.
  if (localOnly && !localPeer) return deny('not-loopback');

  const bindStrict = !!(bind && bind.checked && bind.loopback === false);
  const origin = headers.origin;
  const addressedHere = hostNamesThisListener(headers, config, bind);
  const loopbackHost = isLoopbackHostHeader(headers.host);
  if (origin === undefined || origin === '') {
    // 0.3.9: the desktop shell / some same-origin fetches send neither Origin
    // nor Sec-Fetch-Site. A loopback peer that addressed this listener through
    // a loopback Host is the local user's own process, and `Host` is what rules
    // out DNS rebinding. This is the rule the user can actually reason about:
    // "本机 + Host 是 localhost/127.0.0.1 → 放行", even when the Host service
    // cannot report its bind address (`bind.checked === false`).
    if (localPeer && loopbackHost) {
      if (typeof settings.onAccept === 'function') settings.onAccept(describeRequest(request));
      return true;
    }
    if (!requireOrigin) {
      // Read routes: the Host header is the guard (DNS rebinding cannot forge
      // it), so a remote GUI reading its own state keeps working on any bind.
      if (addressedHere) return true;
      if (!bindStrict) return true; // local tooling, no advertised origin to compare with
      return deny('no-origin-and-host-not-local');
    }
    // Mutating routes. On a public bind the exact Origin is mandatory: anyone
    // can connect, so a matching Host alone proves nothing. The loopback-Host
    // case above is the one exception (the Host is the proof, not the bind).
    if (bindStrict) return deny('no-origin-on-public-bind');
    // The desktop shell and some same-origin fetches send neither Origin nor
    // Sec-Fetch-Site. A loopback peer that addressed THIS listener is the local
    // user's own process, and `Host` is what rules out DNS rebinding.
    if (localPeer && addressedHere) {
      if (typeof settings.onAccept === 'function') settings.onAccept(describeRequest(request));
      return true;
    }
    return deny('no-origin-and-host-not-local');
  }
  if (origin === 'null') return deny('origin-null');
  try {
    const host = headers.host;
    const parsed = new URL(origin);
    if (host !== undefined && originMatchesHost(parsed, host)) return true;
    const normalized = parsed.origin.toLowerCase();
    const allowed = config && Array.isArray(config.allowedOrigins) ? config.allowedOrigins : [];
    const permitted = allowed.some((entry) => {
      if (typeof entry !== 'string') return false;
      try {
        return new URL(entry).origin.toLowerCase() === normalized;
      } catch {
        return false;
      }
    });
    return permitted ? true : deny('origin-host-mismatch');
  } catch {
    return deny('origin-unparsable');
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        error.code = 'too-large';
        reject(error);
        return;
      }
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
  });
}

function issue(message, path) {
  return path ? { message, path } : { message };
}

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function numberField(value, key, min, max, issues, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    issues.push(issue(`${key} must be a ${integer ? 'integer' : 'number'} between ${min} and ${max}`, [key]));
    return false;
  }
  if (integer && !Number.isInteger(value)) {
    issues.push(issue(`${key} must be an integer`, [key]));
    return false;
  }
  return true;
}

/**
 * Standard Schema validation. Cordis calls `Config['~standard'].validate`
 * before `apply`, so an invalid row fails loudly as a `ValidationError`.
 */
function validateConfig(value) {
  const issues = [];
  if (value === undefined || value === null) return { value: { ...DEFAULTS } };
  if (!isObject(value)) return { issues: [issue('config must be an object')] };
  const result = { ...DEFAULTS };
  for (const key of Object.keys(value)) {
    if (!(key in DEFAULTS)) issues.push(issue(`unknown config key "${key}"`, [key]));
  }
  for (const key of ['budgetAmount', 'tokenBudget']) {
    if (key in value) {
      result[key] = value[key];
      numberField(value[key], key, 0, Number.MAX_SAFE_INTEGER, issues, false);
    }
  }
  for (const key of ['warnRatio', 'interceptRatio']) {
    if (key in value) {
      result[key] = value[key];
      numberField(value[key], key, 0.01, 1, issues, false);
    }
  }
  if ('turnEstimateMinInterval' in value) {
    result.turnEstimateMinInterval = value.turnEstimateMinInterval;
    numberField(value.turnEstimateMinInterval, 'turnEstimateMinInterval', 0, 3600000, issues, true);
  }
  if ('interceptMode' in value) {
    if (!INTERCEPT_MODES.includes(value.interceptMode)) {
      issues.push(issue('interceptMode must be "auto" or "manual"', ['interceptMode']));
    } else result.interceptMode = value.interceptMode;
  }
  if ('estimateOutput' in value) {
    if (!OUTPUT_MODES.includes(value.estimateOutput)) {
      issues.push(issue('estimateOutput must be "chat", "sidebar", or "both"', ['estimateOutput']));
    } else result.estimateOutput = value.estimateOutput;
  }
  for (const key of ['enablePreEstimate', 'enableTurnEstimate', 'enforceAtPreStep', 'enableSnapshot', 'useBuiltinHolidays', 'requireLocalControl', 'requireLocalAction']) {
    if (key in value) {
      if (typeof value[key] !== 'boolean') issues.push(issue(`${key} must be a boolean`, [key]));
      else result[key] = value[key];
    }
  }
  for (const key of ['unknownWarnRatio', 'maxGrantedPercent']) {
    if (key in value) {
      result[key] = value[key];
      numberField(value[key], key, 0, key === 'maxGrantedPercent' ? 500 : 1, issues, false);
    }
  }
  if ('perSessionMaxSettled' in value) {
    result.perSessionMaxSettled = value.perSessionMaxSettled;
    numberField(value.perSessionMaxSettled, 'perSessionMaxSettled', 1, 50000, issues, true);
  }
  if ('manualHardStopRatio' in value) {
    result.manualHardStopRatio = value.manualHardStopRatio;
    numberField(value.manualHardStopRatio, 'manualHardStopRatio', 1, 10, issues, false);
  }
  if ('snapshotMaxSessions' in value) {
    result.snapshotMaxSessions = value.snapshotMaxSessions;
    numberField(value.snapshotMaxSessions, 'snapshotMaxSessions', 1, SNAPSHOT_MAX_SESSIONS, issues, true);
  }
  if ('snapshotMaxAgeDays' in value) {
    result.snapshotMaxAgeDays = value.snapshotMaxAgeDays;
    numberField(value.snapshotMaxAgeDays, 'snapshotMaxAgeDays', 0, 3650, issues, false);
  }
  if ('snapshotKeepTurns' in value) {
    result.snapshotKeepTurns = value.snapshotKeepTurns;
    numberField(value.snapshotKeepTurns, 'snapshotKeepTurns', 1, 100, issues, true);
  }
  if ('snapshotPath' in value) {
    if (typeof value.snapshotPath !== 'string') {
      issues.push(issue('snapshotPath must be a string', ['snapshotPath']));
    } else {
      result.snapshotPath = value.snapshotPath;
    }
  }
  if ('currency' in value) {
    if (typeof value.currency !== 'string' || !CURRENCY_SYMBOLS[value.currency.toUpperCase()]) {
      issues.push(issue('currency must be CNY or RMB (amounts are not converted)', ['currency']));
    } else result.currency = value.currency.toUpperCase();
  }
  if ('holidays' in value) {
    if (!Array.isArray(value.holidays)) {
      issues.push(issue('holidays must be an array of YYYY-MM-DD strings', ['holidays']));
    } else {
      const holidays = [];
      for (const item of value.holidays) {
        if (typeof item !== 'string') {
          issues.push(issue('each holidays entry must be a string', ['holidays']));
          continue;
        }
        holidays.push(item);
      }
      result.holidays = holidays;
    }
  }
  if ('allowedOrigins' in value) {
    if (!Array.isArray(value.allowedOrigins)) {
      issues.push(issue('allowedOrigins must be an array of origins', ['allowedOrigins']));
    } else {
      const origins = [];
      for (const item of value.allowedOrigins) {
        if (typeof item !== 'string' || !/^https?:\/\//i.test(item)) {
          issues.push(issue('each allowedOrigins entry must be an http(s) origin', ['allowedOrigins']));
          continue;
        }
        origins.push(item.replace(/\/$/, ''));
      }
      result.allowedOrigins = origins;
    }
  }
  const warn = Number(result.warnRatio);
  const intercept = Number(result.interceptRatio);
  if (Number.isFinite(warn) && Number.isFinite(intercept) && warn > intercept) {
    issues.push(issue('warnRatio must be less than or equal to interceptRatio', ['warnRatio']));
  }
  const maxGrant = Number(result.maxGrantedPercent);
  const hardStopRatio = Number(result.manualHardStopRatio);
  const hardStop = Number(intercept) * hardStopRatio;
  if (Number.isFinite(maxGrant) && Number.isFinite(hardStop) && 1 + maxGrant / 100 >= hardStop) {
    issues.push(
      issue(
        `maxGrantedPercent=${maxGrant} conflicts with interceptRatio=${intercept} × manualHardStopRatio=${hardStopRatio}: ` +
          `grants could reach ${1 + maxGrant / 100}× budget while the manual hard stop is ${hardStop}×. ` +
          `Lower maxGrantedPercent (keep 1 + maxGrantedPercent/100 < ${hardStop}) or raise interceptRatio / manualHardStopRatio.`,
        ['maxGrantedPercent'],
      ),
    );
  }
  if (issues.length) return { issues };
  return { value: result };
}

/**
 * The Config export is a *native* Schemastery-shaped graph without importing
 * Schemastery: the app-boot projector recognizes the marker symbol, `type`, and
 * `meta`, and walks `dict`/`list`/`inner` statically. That gives the Settings
 * and Plugin Manager pages a real field form while the package keeps zero
 * runtime dependencies.
 */
const kSchemastery = Symbol.for('schemastery');

function nativeNode(spec) {
  if (!spec.meta) spec.meta = {};
  Object.defineProperty(spec, kSchemastery, { value: true });
  return spec;
}

function numberNode(defaultValue, min, max) {
  const meta = {};
  if (defaultValue !== undefined) meta.default = defaultValue;
  if (min !== undefined) meta.min = min;
  if (max !== undefined) meta.max = max;
  return nativeNode({ type: 'number', meta });
}

function booleanNode(defaultValue) {
  return nativeNode({ type: 'boolean', meta: { default: defaultValue } });
}

function stringNode(defaultValue) {
  return nativeNode({ type: 'string', meta: defaultValue === undefined ? {} : { default: defaultValue } });
}

function arrayNode(inner, defaultValue) {
  return nativeNode({ type: 'array', inner, meta: { default: defaultValue } });
}

function enumNode(values, defaultValue) {
  return nativeNode({
    type: 'union',
    list: values.map((value) => nativeNode({ type: 'const', value, meta: { required: true } })),
    meta: { default: defaultValue },
  });
}

function dictNode(inner, defaultValue) {
  return nativeNode({ type: 'dict', inner, meta: { default: defaultValue } });
}

function objectNode(dict, defaultValue) {
  return nativeNode({ type: 'object', dict, meta: { default: defaultValue } });
}

const configNode = objectNode(
  {
    budgetAmount: numberNode(DEFAULTS.budgetAmount, 0),
    tokenBudget: numberNode(DEFAULTS.tokenBudget, 0),
    currency: enumNode(['CNY', 'RMB'], DEFAULTS.currency),
    warnRatio: numberNode(DEFAULTS.warnRatio, 0.01, 1),
    interceptRatio: numberNode(DEFAULTS.interceptRatio, 0.01, 1),
    interceptMode: enumNode(INTERCEPT_MODES, DEFAULTS.interceptMode),
    enablePreEstimate: booleanNode(DEFAULTS.enablePreEstimate),
    enableTurnEstimate: booleanNode(DEFAULTS.enableTurnEstimate),
    estimateOutput: enumNode(OUTPUT_MODES, DEFAULTS.estimateOutput),
    turnEstimateMinInterval: numberNode(DEFAULTS.turnEstimateMinInterval, 0, 3600000),
    enforceAtPreStep: booleanNode(DEFAULTS.enforceAtPreStep),
    holidays: arrayNode(stringNode(), []),
    useBuiltinHolidays: booleanNode(DEFAULTS.useBuiltinHolidays),
    allowedOrigins: arrayNode(stringNode(), []),
    enableSnapshot: booleanNode(DEFAULTS.enableSnapshot),
    snapshotPath: stringNode(''),
    snapshotMaxSessions: numberNode(DEFAULTS.snapshotMaxSessions, 1, SNAPSHOT_MAX_SESSIONS),
    snapshotMaxAgeDays: numberNode(DEFAULTS.snapshotMaxAgeDays, 0, 3650),
    snapshotKeepTurns: numberNode(DEFAULTS.snapshotKeepTurns, 1, 100),
    unknownWarnRatio: numberNode(DEFAULTS.unknownWarnRatio, 0, 1),
    maxGrantedPercent: numberNode(DEFAULTS.maxGrantedPercent, 0, 500),
    manualHardStopRatio: numberNode(DEFAULTS.manualHardStopRatio, 1, 10),
    perSessionMaxSettled: numberNode(DEFAULTS.perSessionMaxSettled, 1, 50000),
    requireLocalControl: booleanNode(DEFAULTS.requireLocalControl),
    requireLocalAction: booleanNode(DEFAULTS.requireLocalAction),
  },
  {},
);

Object.defineProperty(configNode, '~standard', {
  value: { version: 1, vendor: PLUGIN_ID, validate: validateConfig },
  enumerable: true,
});

export const Config = configNode;

