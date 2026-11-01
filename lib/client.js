window.__ModuleLoader__.load({
  id: 'dsh-budget-guard',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const TOKENS = {
      bg: 'var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08))',
      bgSoft: 'var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12))',
      border: 'var(--dsw-alias-border-l1, rgba(127, 127, 127, 0.25))',
      text: 'var(--dsw-alias-label-primary, #1f2328)',
      secondary: 'var(--dsw-alias-label-secondary, #6b7280)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a8f98)',
      hoverBg: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))',
      radiusSm: 'var(--dsw-radius-sm, 6px)',
      brand: 'var(--dsw-alias-brand-primary, #247bbf)',
      warn: 'var(--dsw-alias-state-warn-primary, #b45309)',
      error: 'var(--dsw-alias-state-error-primary, #c0392b)',
      success: 'var(--dsw-alias-state-success-primary, #15803d)',
    };

    // Mirrors @deepseek-ai/dsh-client-ui-chat StatsPills.module.css: the host's
    // activity/usage dock pills use this exact size, line box, colour and
    // inline padding. Keeping the same expressions makes the plugin row track
    // the user's content-font setting and theme instead of hard-coding 11px.
    const PILL_FONT_SIZE = 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)';
    const PILL_LINE_HEIGHT = 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))';
    const PILL_PADDING = '1px 8px';
    const PILL_GAP = 6;

    // The right-column page. It is a real tab of DSH's right Sidebar, installed
    // through `dsh-better-sidebar`'s client service when that bundle is present;
    // without it the composer pill stays the only surface (and says so).
    const SIDEBAR_TAB_ID = 'budget-guard:estimate';
    const SIDEBAR_TAB_TITLE = '预算与进度';

    // Every Config key this page renders a control for. Kept next to the form so
    // a test can prove "控件 + 未覆盖清单 == DEFAULTS" and the README cannot
    // drift into claiming the form edits everything.
    const SETTINGS_KEYS = [
      'interceptMode',
      'warnRatio',
      'interceptRatio',
      'unknownWarnRatio',
      'maxGrantedPercent',
      'manualHardStopRatio',
      'enforceAtPreStep',
      'enableTurnEstimate',
      'estimateOutput',
      'turnEstimateMinInterval',
      'enablePreEstimate',
      'budgetAmount',
      'tokenBudget',
      'currency',
      'enableSnapshot',
      'snapshotMaxSessions',
      'snapshotMaxAgeDays',
      'snapshotKeepTurns',
      'perSessionMaxSettled',
      'requireLocalControl',
      'requireLocalAction',
    ];
    // Deliberately not in the form: a free-form path and three arrays need a
    // real editor, so they stay in cordis.patch.yml.
    const FORM_EXCLUDED_KEYS = ['snapshotPath', 'allowedOrigins', 'holidays', 'useBuiltinHolidays'];

    const sidebarHost = {
      service: null,
      available() {
        return !!(this.service && typeof this.service.openTab === 'function');
      },
      open(sessionId) {
        if (!this.available() || !sessionId) return false;
        try {
          this.service.openTab({ type: SIDEBAR_TAB_ID }, { sessionId: String(sessionId) });
          return true;
        } catch {
          return false;
        }
      },
    };

    // Once per session: a panel the reader closed by hand must not reopen on
    // the next poll. localStorage (not a module variable) so a second browser
    // tab on the same machine does not open the same session twice.
    const AUTO_OPEN_KEY = 'dsh-budget-guard:auto-opened';
    const AUTO_OPEN_TTL = 7 * 24 * 60 * 60 * 1000;
    const autoOpened = {};

    function readAutoOpened() {
      try {
        const raw = window.localStorage.getItem(AUTO_OPEN_KEY);
        const parsed = raw ? JSON.parse(raw) : {};
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return null;
      }
    }

    function autoOpenedOnce(sessionId) {
      const key = String(sessionId || '');
      if (!key) return true;
      if (autoOpened[key]) return true;
      const stored = readAutoOpened();
      if (stored) {
        const now = Date.now();
        const fresh = {};
        for (const [id, at] of Object.entries(stored)) {
          if (typeof at === 'number' && now - at < AUTO_OPEN_TTL) fresh[id] = at;
        }
        if (fresh[key]) {
          autoOpened[key] = true;
          return true;
        }
        fresh[key] = now;
        try {
          window.localStorage.setItem(AUTO_OPEN_KEY, JSON.stringify(fresh));
        } catch {
          // Storage can be unavailable (private mode); the memory guard stands.
        }
        autoOpened[key] = true;
        return false;
      }
      autoOpened[key] = true;
      return false;
    }

    async function fetchState(sessionId) {
      const response = await fetch(
        '/dsh-budget/state?sessionId=' + encodeURIComponent(String(sessionId || '')),
        { headers: { accept: 'application/json' }, cache: 'no-store' },
      );
      if (!response.ok) throw new Error('budget state HTTP ' + response.status);
      return response.json();
    }

    async function postAction(sessionId, action, extra) {
      const response = await fetch('/dsh-budget/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(extra || {}), sessionId: String(sessionId || ''), action }),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { ok: response.ok && body && body.ok === true, body };
    }

    async function fetchConfig() {
      const response = await fetch('/dsh-budget/config', {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('budget config HTTP ' + response.status);
      const body = await response.json();
      return body && body.ok ? body.config : null;
    }

    async function saveConfig(patch) {
      const response = await fetch('/dsh-budget/config/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { ok: response.ok && body && body.ok === true, status: response.status, body };
    }

    function useBudgetState(sessionId) {
      const [state, setState] = useState(null);
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let alive = true;
        if (!sessionId) {
          setState(null);
          return undefined;
        }
        const load = () => {
          fetchState(sessionId)
            .then((body) => {
              if (!alive) return;
              if (body && body.ok) {
                setState(body.state || (body.loading ? { loading: true } : null));
              }
            })
            .catch(() => {
              if (alive) setState((current) => current || null);
            });
        };
        load();
        const timer = setInterval(load, 2000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [sessionId, tick]);
      return [state, () => setTick((value) => value + 1)];
    }

    function useConfigState() {
      const [config, setConfig] = useState(null);
      const [tick, setTick] = useState(0);
      useEffect(() => {
        let alive = true;
        fetchConfig()
          .then((next) => {
            if (alive) setConfig(next);
          })
          .catch(() => {
            if (alive) setConfig((current) => current || null);
          });
        return () => {
          alive = false;
        };
      }, [tick]);
      return [config, () => setTick((value) => value + 1)];
    }

    function levelColor(level) {
      if (level === 'over' || level === 'manual') return TOKENS.error;
      if (level === 'warn') return TOKENS.warn;
      return TOKENS.secondary;
    }

    function BudgetButtons(props) {
      const [busy, setBusy] = useState(null);
      const canContinue = props.canContinue !== false;
      const run = (action) => {
        if (busy || (action === 'continue' && !canContinue)) return;
        setBusy(action);
        postAction(props.sessionId, action)
          .then(() => {
            props.onDone();
          })
          .catch(() => {})
          .finally(() => setBusy(null));
      };
      return h(
        'span',
        { style: { display: 'inline-flex', gap: 6, marginLeft: 8, flexShrink: 0 } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => run('continue'),
            disabled: !!busy || !canContinue,
            title: canContinue
              ? '本次放行 10% 预算，之后还会再次提示；彻底关闭请用 /budget off'
              : '已达放行上限，请中止或 /budget off',
            style: buttonStyle(TOKENS.brand, busy === 'continue' || !canContinue),
          },
          busy === 'continue' ? '处理中…' : canContinue ? '继续 (+10%)' : '已达上限',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => run('suppress'),
            disabled: !!busy,
            title: '本次任务内不再提示预算拦截（仍记录费用）；/budget off 可恢复',
            style: buttonStyle(TOKENS.secondary, busy === 'suppress'),
          },
          busy === 'suppress' ? '处理中…' : '不再提示',
        ),
        h(
          'button',
          {
            type: 'button',
            onClick: () => run('abort'),
            disabled: !!busy,
            title: '取消当前轮次',
            style: buttonStyle(TOKENS.error, busy === 'abort'),
          },
          busy === 'abort' ? '处理中…' : '中止',
        ),
      );
    }

    function buttonStyle(color, busy) {
      return {
        appearance: 'none',
        border: '1px solid ' + color,
        background: 'transparent',
        color,
        borderRadius: TOKENS.radiusSm,
        padding: '1px 8px',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
        font: 'inherit',
      };
    }

    function moneyText(value) {
      const amount = Number(value) || 0;
      // Amounts are always CNY; RMB is the same currency and the same symbol.
      const symbol = '¥';
      if (amount === 0) return symbol + '0.00';
      if (amount < 0.0001) return '<' + symbol + '0.0001';
      if (amount < 0.01) return symbol + amount.toFixed(4);
      if (amount < 0.1) return symbol + amount.toFixed(3);
      return symbol + amount.toFixed(2);
    }

    function DetailRow(props) {
      return h(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', gap: 16, padding: '1px 0' } },
        h('span', { style: { color: TOKENS.secondary } }, props.label),
        h('span', { style: { textAlign: 'right', color: props.color || TOKENS.text } }, props.value),
      );
    }

    function recentBurnLine(estimate) {
      if (!estimate || estimate.recentAvgCost == null || estimate.recentAvgTokens == null) {
        return '近期暂无完整轮次数据';
      }
      return '近期消耗：约 ' + estimate.recentAvgCostLabel + ' / ' +
        Number(estimate.recentAvgTokens || 0).toLocaleString() + ' tokens 每' +
        (estimate.recentUnit === 'step' ? '步' : '轮');
    }

    function estimateLine(estimate) {
      if (!estimate) return '';
      if (estimate.source === 'model_plan' && estimate.remainingSteps !== null) {
        const parts = ['还需 ' + estimate.remainingSteps + ' 步'];
        if (estimate.remainingCost !== null && estimate.remainingTokens !== null) {
          parts.push(estimate.remainingCostLabel + ' / ' + Number(estimate.remainingTokens).toLocaleString() + ' tokens');
        }
        return parts.join('、') + '（模型计划，仅供参考）';
      }
      return recentBurnLine(estimate);
    }

    function holidayLabel(source) {
      return source === 'config' ? '配置' : source === 'none' ? '无' : '内置';
    }

    /** Shared by the composer panel and the right-column page. */
    function DetailsPanel(props) {
      const state = props.state;
      const [form, setForm] = useState(false);
      const [amount, setAmount] = useState('');
      const [tokenValue, setTokenValue] = useState('');
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState(null);

      const pricing = state.pricing || {};
      const breakdown = state.used.breakdown || {};
      const warning = state.warning;
      const color = levelColor(warning ? warning.level : null);

      const openForm = () => {
        setAmount(state.budget.amount > 0 ? String(state.budget.amount) : '');
        setTokenValue(state.budget.tokens > 0 ? String(state.budget.tokens) : '');
        setMessage(null);
        setForm(true);
      };

      const save = () => {
        if (busy) return;
        const nextAmount = Number(amount) || 0;
        const nextTokens = Math.round(Number(tokenValue) || 0);
        if (nextAmount <= 0 && nextTokens <= 0) {
          setMessage('请输入金额或 Token');
          return;
        }
        setBusy(true);
        postAction(props.sessionId, 'set-budget', { amount: nextAmount, tokens: nextTokens })
          .then((result) => {
            if (result.ok) {
              setMessage('已保存');
              setForm(false);
              props.reload();
            } else {
              setMessage('保存失败');
            }
          })
          .catch(() => setMessage('保存失败'))
          .finally(() => setBusy(false));
      };

      const rows = [];
      rows.push(h(DetailRow, { key: 'in', label: '输入（未命中）', value: moneyText(breakdown.inputMiss) }));
      rows.push(h(DetailRow, { key: 'hit', label: '缓存命中', value: moneyText(breakdown.inputHit) }));
      rows.push(h(DetailRow, { key: 'out', label: '输出', value: moneyText(breakdown.output) }));
      rows.push(
        h(DetailRow, {
          key: 'tier',
          label: '峰 / 谷',
          value:
            moneyText((pricing.byTier || {}).peak ? pricing.byTier.peak.cost : 0, state.budget.currency) +
            ' / ' +
            moneyText((pricing.byTier || {}).offpeak ? pricing.byTier.offpeak.cost : 0, state.budget.currency),
        }),
      );
      rows.push(h(DetailRow, { key: 'model', label: '最近模型', value: pricing.lastModel || '—' }));
      rows.push(
        h(DetailRow, {
          key: 'now',
          label: '当前时段',
          value: pricing.currentTier === 'peak' ? '高峰（09–12 / 14–18）' : '空闲',
        }),
      );
      rows.push(
        h(DetailRow, {
          key: 'tokens',
          label: 'Token',
          value:
            Number(state.used.tokens || 0).toLocaleString() +
            '（输入 ' + Number(state.used.inputMissTokens || 0).toLocaleString() +
            ' · 命中 ' + Number(state.used.cacheReadTokens || 0).toLocaleString() +
            ' · 输出 ' + Number(state.used.outputTokens || 0).toLocaleString() + '）',
        }),
      );
      if (state.aggregate) {
        const aggregate = state.aggregate;
        rows.push(
          h(DetailRow, {
            key: 'agg',
            label: '含子代理',
            value:
              '自身 ' + moneyText(aggregate.self.cost, state.budget.currency) +
              ' + 子代理 ' + moneyText(aggregate.childrenCost, state.budget.currency) +
              ' = ' + moneyText(aggregate.totalCost, state.budget.currency),
          }),
        );
        rows.push(
          h(
            'details',
            { key: 'agg-detail', style: { marginTop: 2 } },
            h(
              'summary',
              { style: { cursor: 'pointer', color: TOKENS.secondary, fontSize: 10 } },
              '子代理 ' + aggregate.children.length + ' 个' + (aggregate.complete ? '' : '（含待校正）'),
            ),
            aggregate.children.map((child) =>
              h(DetailRow, {
                key: child.sessionId,
                label: child.sessionId.replace(/^session-/, '').slice(0, 8),
                value: moneyText(child.cost, state.budget.currency) + (child.stale ? ' ≈' : ''),
              }),
            ),
          ),
        );
      }
      if (state.estimate) {
        rows.push(h(DetailRow, {
          key: 'est',
          label: state.estimate.source === 'model_plan' ? '本轮预估' : '近期消耗',
          value: estimateLine(state.estimate),
        }));
      } else if (state.preEstimate) rows.push(h(DetailRow, { key: 'pre', label: '任务前预估', value: state.preEstimate.text }));
      if (pricing.unknownTokens > 0) {
        rows.push(
          h(DetailRow, {
            key: 'unknown',
            label: '未知模型',
            value: Number(pricing.unknownTokens).toLocaleString() + ' tokens 未计价',
            color: TOKENS.warn,
          }),
        );
      }
      if (state.used.shadowCost > 0) {
        rows.push(
          h(DetailRow, {
            key: 'shadow',
            label: '未知估算',
            value: state.used.shadowCostLabel + '（仅用于拦截判断）',
            color: TOKENS.warn,
          }),
        );
      }
      if (pricing.protectionAtRisk) {
        rows.push(
          h(DetailRow, {
            key: 'protection',
            label: '保护',
            value: '未定价 token 占比高；按最高单价模型估算，实际可能偏低',
            color: TOKENS.warn,
          }),
        );
      }
      if (warning) {
        rows.push(h(DetailRow, { key: 'warning', label: '预警', value: warning.text, color }));
      }
      if (pricing.warnings && pricing.warnings.length) {
        rows.push(
          h(
            'details',
            { key: 'warn', style: { marginTop: 3, color: TOKENS.warn, fontSize: 10 } },
            h('summary', { style: { cursor: 'pointer' } }, '价格警告 ' + pricing.warnings.length + ' 条'),
            ...pricing.warnings.map((item, index) =>
              h('div', { key: 'warn-' + index, style: { paddingLeft: 8 } }, '· ' + item),
            ),
          ),
        );
      }
      if (state.manual && state.manual.suppressed) {
        rows.push(
          h(DetailRow, {
            key: 'suppressed',
            label: '手动模式',
            value: '已关闭提示；超过 ' + (state.manual.hardStopPercent || 142) + '% 仍强制中止',
            color: TOKENS.warn,
          }),
        );
      }
      if (state.stale) {
        rows.push(
          h(DetailRow, {
            key: 'stale',
            label: '数据',
            value:
              '快照（待校正）' +
              (state.snapshotAt ? ' · ' + new Date(state.snapshotAt).toLocaleString() : ''),
            color: TOKENS.warn,
          }),
        );
      }
      const counters = state.counters || {};
      // A freshly reset session has lastSeq -1 (nothing folded yet) and a
      // watermark of 0: clamp both so the panel never prints a negative.
      const shownLastSeq = Math.max(0, Number(counters.lastSeq) || 0);
      if (counters.blockedSettlements > 0) {
        rows.push(
          h(DetailRow, {
            key: 'blocked',
            label: '结算',
            value:
              '有 ' + counters.blockedSettlements + ' 次结算因明细过期被拒绝（历史累计），账目可能偏高',
            color: TOKENS.warn,
          }),
        );
      }
      if (counters.settledOverflow) {
        rows.push(
          h(DetailRow, {
            key: 'overflow',
            label: '结算',
            value:
              '已结算记录达到上限，最早的 ' + Number(counters.settledEvicted || 0).toLocaleString() +
              ' 条已丢弃；新步骤仍会记录，旧步骤重试可能重复计费',
            color: TOKENS.warn,
          }),
        );
      } else if (counters.settledTrimmed) {
        rows.push(
          h(DetailRow, {
            key: 'trimmed',
            label: '结算',
            value: '较早步骤只记“已计费”标记；这些步骤重试会被拒绝而不是替换',
            color: TOKENS.warn,
          }),
        );
      }
      if (counters.settledCharges !== undefined) {
        rows.push(
          h(DetailRow, {
            key: 'settled',
            label: '结算记录',
            value:
              Number(counters.stepCharges || 0).toLocaleString() + ' 条明细 / ' +
              Number(counters.settledCharges || 0).toLocaleString() + ' 条已结算 · lastSeq ' +
              shownLastSeq.toLocaleString(),
            color: TOKENS.secondary,
          }),
        );
      }
      if (counters.settledSeqWatermark !== undefined) {
        // Diagnostic only: the two watermarks differ when the lagging events
        // carried no usage. Nobody acts on it, but it is the one number that
        // says "billing has reached event N" without replaying the log.
        const watermark = Math.max(0, Number(counters.settledSeqWatermark) || 0);
        const behind = shownLastSeq > watermark ? shownLastSeq - watermark : 0;
        rows.push(
          h(DetailRow, {
            key: 'watermark',
            label: '结算水位',
            value:
              watermark.toLocaleString() + (behind > 0 ? '（日志领先 ' + behind.toLocaleString() + ' 条事件）' : ''),
            color: TOKENS.secondary,
          }),
        );
      }
      rows.push(
        h(
          'div',
          { key: 'source', style: { marginTop: 3, color: TOKENS.secondary, fontSize: 10 } },
          '价格：' + (pricing.sources || []).join(' → ') + ' · 节假日：' + holidayLabel(pricing.holidaysSource),
        ),
      );
      if (pricing.rates) {
        const rates = pricing.rates;
        rows.push(
          h(
            'div',
            { key: 'rates', style: { marginTop: 1, color: TOKENS.tertiary, fontSize: 10 } },
            '计费口径（每 1M token，' + (rates.tier === 'peak' ? '高峰' : '空闲') + '价）：' +
              '未命中 ¥' + rates.inputMiss +
              ' · 缓存命中 ¥' + rates.inputHit +
              ' · 输出 ¥' + rates.output +
              '（' + rates.model + '）',
          ),
        );
      }

      return h(
        'div',
        {
          style: {
            marginTop: 4,
            padding: '8px 10px',
            border: '1px solid ' + TOKENS.border,
            borderRadius: TOKENS.radiusSm,
            background: TOKENS.bg,
            color: TOKENS.text,
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            lineHeight: '20px',
            maxWidth: 520,
            textAlign: 'left',
            boxSizing: 'border-box',
          },
        },
        h('div', { style: { fontWeight: 600, marginBottom: 2 } }, '费用明细'),
        rows,
        form || !state.configured
          ? h(
              'div',
              { style: { marginTop: 6, paddingTop: 6, borderTop: '1px solid ' + TOKENS.border } },
              h('div', { style: { fontWeight: 600, marginBottom: 3 } }, '设置本次预算'),
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                h('label', { style: { color: TOKENS.secondary } }, '金额'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: '0.01',
                  value: amount,
                  onChange: (event) => setAmount(event.target.value),
                  placeholder: '元',
                  style: inputStyle(70),
                }),
                h('label', { style: { color: TOKENS.secondary } }, 'Token'),
                h('input', {
                  type: 'number',
                  min: 0,
                  step: '1000',
                  value: tokenValue,
                  onChange: (event) => setTokenValue(event.target.value),
                  placeholder: 'tokens',
                  style: inputStyle(90),
                }),
                h('button', { type: 'button', onClick: save, disabled: busy, style: primaryButtonStyle(busy) }, busy ? '保存中…' : '保存'),
                h('button', { type: 'button', onClick: () => setForm(false), style: linkButtonStyle() }, '取消'),
              ),
              message ? h('div', { style: { marginTop: 2, color: message === '已保存' ? TOKENS.success : TOKENS.error } }, message) : null,
            )
          : h(
              'div',
              { style: { marginTop: 4, display: 'flex', gap: 12, flexWrap: 'wrap' } },
              h('button', { type: 'button', onClick: openForm, style: linkButtonStyle() }, '设置本次预算…'),
              sidebarHost.available() && props.showSidebarButton !== false
                ? h(
                    'button',
                    {
                      type: 'button',
                      onClick: () => sidebarHost.open(props.sessionId),
                      title: '在右侧栏常驻显示预算与每轮估算',
                      style: linkButtonStyle(),
                    },
                    '在右侧栏打开…',
                  )
                : null,
            ),
      );
    }

    function inputStyle(width) {
      return {
        width,
        boxSizing: 'border-box',
        padding: '1px 5px',
        borderRadius: 4,
        border: '1px solid ' + TOKENS.border,
        background: TOKENS.bgSoft,
        color: TOKENS.text,
        font: 'inherit',
        fontSize: 11,
      };
    }

    function primaryButtonStyle(busy) {
      return {
        appearance: 'none',
        border: '1px solid ' + TOKENS.brand,
        background: 'transparent',
        color: TOKENS.brand,
        borderRadius: 5,
        padding: '1px 8px',
        font: 'inherit',
        fontSize: 11,
        cursor: busy ? 'progress' : 'pointer',
        opacity: busy ? 0.6 : 1,
      };
    }

    function linkButtonStyle() {
      return {
        appearance: 'none',
        border: 'none',
        background: 'transparent',
        color: TOKENS.brand,
        padding: 0,
        font: 'inherit',
        fontSize: 11,
        cursor: 'pointer',
      };
    }

    /**
     * Compact ambient line under the composer. The surface is one short
     * sentence; clicking it reveals the cost breakdown and the per-session
     * budget form. Warnings only colour the text so the row stays as small as
     * the host's own usage line.
     */
    function BudgetDock(props) {
      const [state, reload] = useBudgetState(props.sessionId);
      const [open, setOpen] = useState(false);
      const [hover, setHover] = useState(false);

      // `estimateOutput` decides where the per-turn estimate lives. When it
      // names the right column, bring the page up once instead of silently
      // dropping the estimate; `both` only does it when the projection is
      // already over budget.
      useEffect(() => {
        if (!state || state.loading || !state.config) return;
        if (!sidebarHost.available()) return;
        const mode = state.config.estimateOutput;
        if (mode !== 'sidebar' && mode !== 'both') return;
        if (!state.estimate) return;
        if (mode !== 'sidebar' && !state.estimate.overBudget) return;
        if (autoOpenedOnce(props.sessionId)) return;
        sidebarHost.open(props.sessionId);
      }, [state]);

      if (!state) return null;
      if (state.loading) {
        return h(
          'div',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              color: TOKENS.tertiary,
              fontSize: PILL_FONT_SIZE,
              lineHeight: PILL_LINE_HEIGHT,
              fontVariantNumeric: 'tabular-nums',
              padding: PILL_PADDING,
              whiteSpace: 'nowrap',
            },
          },
          '预算状态加载中…',
        );
      }
      if (!state.configured && !state.estimate && !state.preEstimate && state.used.tokens === 0) return null;

      const warning = state.warning;
      const level = warning ? warning.level : null;
      const color = levelColor(level);
      const pricing = state.pricing || {};
      const staleMark = state.stale ? '≈' : '';
      const staleNote = state.stale ? '（待校正）' : '';
      const shadowNote = state.used.shadowCost > 0
        ? '（判定 ' + state.used.effectiveCostLabel + '，含未知估算）'
        : '';
      const guard = state.guard || {};
      const surface = (state.configured
        ? '预算 ' + state.budget.label + ' · 已用 ' + staleMark + state.used.costLabel + shadowNote
        : '未设置预算 · 已用 ' + staleMark + state.used.costLabel + shadowNote) +
        staleNote +
        (guard.disabled ? ' · 已解除限制' : '') +
        (state.manual && state.manual.suppressed ? ' · 已关闭提示' : '') +
        (pricing.unknownTokens > 0 ? ' · 价格未知' : '');

      const pillColor = level ? color : TOKENS.tertiary;
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            minWidth: 0,
            color: pillColor,
            fontSize: PILL_FONT_SIZE,
            lineHeight: PILL_LINE_HEIGHT,
            fontVariantNumeric: 'tabular-nums',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: PILL_GAP } },
          h(
            'button',
            {
              type: 'button',
              onClick: () => setOpen((value) => !value),
              onMouseEnter: () => setHover(true),
              onMouseLeave: () => setHover(false),
              'aria-expanded': open,
              title: '点击查看费用明细',
              style: {
                appearance: 'none',
                border: 'none',
                background: hover || open ? TOKENS.hoverBg : 'transparent',
                borderRadius: TOKENS.radiusSm,
                padding: PILL_PADDING,
                margin: 0,
                font: 'inherit',
                color: hover || open ? (level ? color : TOKENS.secondary) : 'inherit',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: PILL_GAP,
                whiteSpace: 'nowrap',
                maxWidth: 'min(70vw, 520px)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                textAlign: 'left',
                fontVariantNumeric: 'tabular-nums',
                transition: 'background 120ms ease, color 120ms ease',
              },
            },
            surface + (open ? ' ▴' : ' ▾'),
          ),
          level ? h('span', { style: { color, fontWeight: 500, fontSize: 14, lineHeight: 1 } }, '⚠') : null,
        ),
        state.manual.pending
          ? h(
              'div',
              { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginTop: 2 } },
              h('span', { style: { color: TOKENS.error, fontWeight: 500 } }, state.manual.text),
              h(BudgetButtons, { sessionId: props.sessionId, onDone: reload, canContinue: state.manual.canContinue }),
            )
          : guard.stopped
            ? h(RecoveryRow, {
                state,
                sessionId: props.sessionId,
                onDone: reload,
                onShowDetails: () => setOpen(true),
              })
            : null,
        open ? h(DetailsPanel, { state, sessionId: props.sessionId, reload }) : null,
      );
    }

    /**
     * Shown after a budget stop (auto cancel or pre-step reject) so the turn is
     * not a dead end: resume with the next 10%, lift the limit for this session,
     * or raise the budget. This is the counterpart of the cancel, not an extra.
     */
    function RecoveryRow(props) {
      const [busy, setBusy] = useState(null);
      const guard = props.state.guard || {};
      const run = (action) => {
        if (busy) return;
        setBusy(action);
        postAction(props.sessionId, action)
          .then((result) => {
            if (!result.ok && result.body && result.body.message) {
              setBusy(null);
            }
            props.onDone();
          })
          .catch(() => {})
          .finally(() => setBusy(null));
      };
      return h(
        'div',
        { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 2 } },
        h('span', { style: { color: TOKENS.error, fontWeight: 500 } }, '本轮已因预算中止。'),
        guard.canResume !== false
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => run('resume'),
                disabled: !!busy,
                title: '放行约 10% 预算，之后仍会按阈值提醒；累计到上限后可「解除限制」',
                style: buttonStyle(TOKENS.brand, busy === 'resume'),
              },
              busy === 'resume' ? '处理中…' : '继续 (+10%)',
            )
          : null,
        guard.canUnlock !== false
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => run('unlock'),
                disabled: !!busy,
                title: '本会话不再因预算中止（费用仍统计）；输入 /budget lock 或重设预算可恢复',
                style: buttonStyle(TOKENS.warn, busy === 'unlock'),
              },
              busy === 'unlock' ? '处理中…' : '解除限制',
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              // "查看明细" must actually reveal the breakdown; the parent owns
              // the `open` state, so reloading alone left the panel collapsed.
              if (typeof props.onShowDetails === 'function') props.onShowDetails();
              else props.onDone();
            },
            style: linkButtonStyle(),
          },
          '查看明细',
        ),
      );
    }

    /**
     * The right-column page: the same numbers as the pill, but always open and
     * with room for the projection. Rendered as a native DSH right-Sidebar tab
     * through `dsh-better-sidebar`.
     */
    function BudgetPanel(props) {
      const sessionId = props.sessionId || (props.scope && props.scope.sessionId) || '';
      const [state, reload] = useBudgetState(sessionId);
      if (!state || state.loading) {
        return h(
          'div',
          { style: { padding: 12, color: TOKENS.secondary, fontSize: 12 } },
          state ? '预算状态加载中…' : '等待会话…',
        );
      }
      const estimate = state.estimate;
      const warning = state.warning;
      const level = warning ? warning.level : null;
      const color = levelColor(level);
      const planned = !!(estimate && estimate.source === 'model_plan' && estimate.remainingSteps !== null);
      const percent = estimate
        ? Math.max(0, Math.min(100, estimate.progressPercent || 0))
        : Math.max(0, Math.min(100, (state.used && state.used.percent) || 0));

      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 12px',
            color: TOKENS.text,
            fontSize: 'var(--dsh-content-font-size-secondary, 13px)',
            lineHeight: '20px',
            fontVariantNumeric: 'tabular-nums',
            boxSizing: 'border-box',
            overflow: 'auto',
            height: '100%',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600 } }, '预算进度'),
          h(
            'span',
            { style: { color: TOKENS.secondary, fontSize: 10, border: '1px solid ' + TOKENS.border, borderRadius: 4, padding: '0 4px' } },
            '估算',
          ),
          h('span', { style: { flex: 1, minWidth: 60, height: 4, borderRadius: 999, background: TOKENS.bgSoft, overflow: 'hidden' } },
            h('span', { style: { display: 'block', width: percent + '%', height: '100%', background: level ? color : TOKENS.brand } }),
          ),
          h('span', { style: { color: TOKENS.secondary } }, (planned ? '已完成约 ' : '预算已用约 ') + percent + '%'),
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: '2px 12px' } },
          h('span', null, '预算 ', h('strong', null, state.configured ? state.budget.label : '未设置')),
          h('span', null, '已用 ', h('strong', null, (state.stale ? '≈' : '') + state.used.costLabel)),
          state.used.shadowCost > 0
            ? h('span', { style: { color: TOKENS.warn } }, '判定 ' + state.used.effectiveCostLabel)
            : null,
          h('span', { style: { color: TOKENS.secondary } }, state.used.tokenLabel),
        ),
        estimate
          ? h(
              'div',
              { style: { marginTop: 2 } },
              planned
                ? h(
                    'div',
                    null,
                    '预计还需 ' + estimate.remainingSteps + ' 步' +
                      (estimate.remainingTurns !== null ? '（约 ' + estimate.remainingTurns + ' 轮）' : '') +
                      (estimate.remainingCost !== null
                        ? '、' + estimate.remainingCostLabel + ' / ' + Number(estimate.remainingTokens).toLocaleString() + ' tokens'
                        : '') +
                      '（模型计划，仅供参考）',
                  )
                : h('div', { style: { color: TOKENS.secondary } }, recentBurnLine(estimate)),
            )
          : h('div', { style: { color: TOKENS.secondary } }, state.preEstimate ? state.preEstimate.text : '本轮尚未产生预估。'),
        warning
          ? h('div', { style: { color, fontWeight: level === 'over' ? 500 : 400 } }, warning.text)
          : null,
        h(DetailsPanel, { state, sessionId, reload, showSidebarButton: false }),
      );
    }

    /**
     * One card under the turn that just closed. `props.seq` is the closing
     * sequence, so only the newest matching estimate renders.
     */
    function TurnEstimateCard(props) {
      const [state] = useBudgetState(props.sessionId);
      if (!state || state.loading || !state.estimate || !state.config.enableTurnEstimate) return null;
      // `sidebar` means the right-column page carries the estimate. With no
      // sidebar service installed that page cannot exist, so keep the card
      // rather than dropping the estimate entirely.
      if (state.config.estimateOutput === 'sidebar' && sidebarHost.available()) return null;
      const estimate = state.estimate;
      const matchesSeq = props.seq !== undefined && estimate.endSeq !== null && props.seq === estimate.endSeq;
      const matchesTurn = !!props.turn && (props.turn.turn === estimate.turn || props.turn.index === estimate.turn);
      if (!matchesSeq && !matchesTurn) return null;

      const level = state.warning ? state.warning.level : null;
      const color = levelColor(level);
      const percent = Math.max(0, Math.min(100, estimate.progressPercent || 0));
      const planned = estimate.source === 'model_plan' && estimate.remainingSteps !== null;

      return h(
        'div',
        {
          style: {
            margin: '8px 0 4px',
            padding: '8px 12px',
            border: '1px solid ' + (level ? color : TOKENS.border),
            borderLeft: '3px solid ' + (level ? color : TOKENS.brand),
            borderRadius: 8,
            background: TOKENS.bg,
            color: TOKENS.text,
            fontSize: 12,
            lineHeight: '19px',
            fontVariantNumeric: 'tabular-nums',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('span', { style: { fontWeight: 600, color: TOKENS.brand } }, '预算进度'),
          h('span', { style: { color: TOKENS.secondary, fontSize: 10, border: '1px solid ' + TOKENS.border, borderRadius: 4, padding: '0 4px' } }, '估算'),
          h('span', { style: { flex: 1, minWidth: 80, height: 4, borderRadius: 999, background: TOKENS.bgSoft, overflow: 'hidden' } },
            h('span', { style: { display: 'block', width: percent + '%', height: '100%', background: level ? color : TOKENS.brand } }),
          ),
          h('span', { style: { color: TOKENS.secondary } }, (planned ? '已完成约 ' : '预算已用约 ') + percent + '%'),
        ),
        h(
          'div',
          { style: { marginTop: 3 } },
          planned
            ? '预计还需 ' + estimate.remainingSteps + ' 步' +
                (estimate.remainingTurns !== null ? '（约 ' + estimate.remainingTurns + ' 轮）' : '') +
                (estimate.remainingCost !== null
                  ? '、' + estimate.remainingCostLabel + ' / ' + Number(estimate.remainingTokens).toLocaleString() + ' tokens'
                  : '') +
                '（模型计划，仅供参考）；当前已用 ' + state.used.costLabel +
                (state.used.shadowCost > 0 ? '（判定 ' + state.used.effectiveCostLabel + '，含未知估算）' : '') +
                (state.configured ? ' / ' + state.budget.label : '') + '。'
            : recentBurnLine(estimate) + '；当前已用 ' + state.used.costLabel +
                (state.used.shadowCost > 0 ? '（判定 ' + state.used.effectiveCostLabel + '，含未知估算）' : '') +
                (state.configured ? ' / ' + state.budget.label : '') + '。',
        ),
        state.warning
          ? h(
              'div',
              {
                style: {
                  marginTop: 3,
                  color: levelColor(state.warning.level),
                  fontWeight: state.warning.level === 'over' ? 500 : 400,
                },
              },
              state.warning.text,
            )
          : state.pricing && state.pricing.unknownTokens > 0
            ? h(
                'div',
                { style: { marginTop: 3, color: TOKENS.warn, fontWeight: 500 } },
                '⚠ 含未定价模型 token，当前金额偏低（价格未知）。',
              )
            : null,
      );
    }

    /* ── settings form primitives ─────────────────────────────────────── */

    function Switch(props) {
      const checked = !!props.checked;
      const busy = !!props.busy;
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': props.label || '开关',
          onClick: props.onChange,
          disabled: busy,
          style: {
            width: 36,
            height: 20,
            border: 'none',
            borderRadius: 999,
            background: checked ? TOKENS.brand : TOKENS.bgSoft,
            position: 'relative',
            cursor: busy ? 'progress' : 'pointer',
            padding: 0,
            flexShrink: 0,
            transition: 'background 150ms ease',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0, 0, 0, 0.25)',
            transition: 'left 150ms ease',
          },
        }),
      );
    }

    function SettingRow(props) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 16,
            padding: '8px 0',
            borderBottom: '1px solid ' + TOKENS.border,
          },
        },
        h(
          'div',
          { style: { minWidth: 0 } },
          h('div', { style: { fontWeight: 500 } }, props.title),
          props.desc ? h('div', { style: { color: TOKENS.secondary, fontSize: 11, marginTop: 2 } }, props.desc) : null,
        ),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } }, props.children),
      );
    }

    function numberFrom(value, fallback) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function percentFrom(value, fallback) {
      // Config stores ratios (0.8 = 80%), and `percentInput` writes ratios back.
      // Older code divided by 100 twice, so "保存全部设置" sent 0.008 and the
      // Host rejected every save with `warnRatio must be ... between 0.01 and 1`.
      // Accept a legacy percent value (>1) as a courtesy, then clamp to a ratio.
      const parsed = numberFrom(value, fallback);
      const ratio = parsed > 1 ? parsed / 100 : parsed;
      return Math.min(1, Math.max(0, Math.round(ratio * 1000) / 1000));
    }

    function SettingsPage() {
      const [config, reload] = useConfigState();
      const [edits, setEdits] = useState({});
      const [busy, setBusy] = useState(null);
      const [message, setMessage] = useState(null);

      const refreshSoon = () => {
        setTimeout(() => reload(), 700);
        setTimeout(() => reload(), 1600);
      };

      if (!config) {
        return h(
          'div',
          { style: { color: TOKENS.text, fontSize: 12, padding: '4px 0' } },
          h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '预算护栏'),
          h('div', { style: { color: TOKENS.secondary } }, '正在读取配置…'),
        );
      }

      const valueOf = (key) => (key in edits ? edits[key] : config[key]);
      const setField = (key, value) => setEdits({ ...edits, [key]: value });

      const commit = (patch, label) => {
        if (busy) return;
        setBusy(label);
        setMessage(null);
        saveConfig(patch)
          .then((result) => {
            if (!result.ok) {
              const body = result.body || {};
              const issues = Array.isArray(body.issues) ? body.issues : [];
              if (issues.length) {
                const first = issues[0] || {};
                const where = Array.isArray(first.path) && first.path.length ? first.path.join('.') + '：' : '';
                const extra = issues.length > 1 ? '（另有 ' + (issues.length - 1) + ' 条问题）' : '';
                setMessage('保存失败 · ' + where + (first.message || '未知原因') + extra);
                return;
              }
              // The settings page is local-only by default; a remote browser
              // gets a 403 from the peer check instead of a validation issue.
              // The hint matters: a system proxy that hijacks localhost makes a
              // local save look remote, so point at the server's own view of the
              // peer instead of asserting a cause.
              if (result.status === 403 || body.error === 'origin') {
                setMessage(
                  '保存失败：此设置只允许在本机浏览器中修改。' +
                    '若开着代理（Clash 等），请让 localhost / 127.0.0.1 走直连；' +
                    '服务器实际看到的来源见 /dsh-budget/config 的 server.lastReject。',
                );
                return;
              }
              setMessage('保存失败' + (body.error ? '：' + body.error : ''));
              return;
            }
            setEdits({});
            setMessage('已保存，正在应用…');
            refreshSoon();
          })
          .catch(() => setMessage('保存失败'))
          .finally(() => setBusy(null));
      };

      const isAuto = valueOf('interceptMode') !== 'manual';
      const sidebarReady = sidebarHost.available();
      const outputMode = valueOf('estimateOutput');

      const saveAll = () => {
        commit(
          {
            interceptMode: isAuto ? 'auto' : 'manual',
            warnRatio: percentFrom(valueOf('warnRatio'), 0.8),
            interceptRatio: percentFrom(valueOf('interceptRatio'), 0.95),
            unknownWarnRatio: percentFrom(valueOf('unknownWarnRatio'), 0.2),
            maxGrantedPercent: Math.max(0, numberFrom(valueOf('maxGrantedPercent'), 30)),
            manualHardStopRatio: Math.max(1, numberFrom(valueOf('manualHardStopRatio'), 1.5)),
            enforceAtPreStep: !!valueOf('enforceAtPreStep'),
            enableTurnEstimate: !!valueOf('enableTurnEstimate'),
            enablePreEstimate: !!valueOf('enablePreEstimate'),
            estimateOutput: outputMode,
            turnEstimateMinInterval: Math.max(0, Math.round(numberFrom(valueOf('turnEstimateMinInterval'), 1500))),
            budgetAmount: Math.max(0, numberFrom(valueOf('budgetAmount'), 0)),
            tokenBudget: Math.max(0, Math.round(numberFrom(valueOf('tokenBudget'), 0))),
            currency: String(valueOf('currency') || 'CNY'),
            enableSnapshot: !!valueOf('enableSnapshot'),
            snapshotMaxSessions: Math.min(512, Math.max(1, Math.round(numberFrom(valueOf('snapshotMaxSessions'), 200)))),
            snapshotMaxAgeDays: Math.min(3650, Math.max(0, numberFrom(valueOf('snapshotMaxAgeDays'), 30))),
            snapshotKeepTurns: Math.min(100, Math.max(1, Math.round(numberFrom(valueOf('snapshotKeepTurns'), 8)))),
            perSessionMaxSettled: Math.min(50000, Math.max(1, Math.round(numberFrom(valueOf('perSessionMaxSettled'), 2000)))),
            requireLocalControl: !!valueOf('requireLocalControl'),
            requireLocalAction: !!valueOf('requireLocalAction'),
          },
          'all',
        );
      };

      const numberInput = (key, options) =>
        h('input', {
          type: 'number',
          min: options.min,
          max: options.max,
          step: options.step === undefined ? '1' : String(options.step),
          value: String(valueOf(key)),
          onChange: (event) => setField(key, event.target.value),
          style: { ...inputStyle(options.width || 90), padding: '2px 6px', fontSize: 12, textAlign: 'right' },
        });

      const percentInput = (key, width) =>
        h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
          h('input', {
            type: 'number',
            min: 1,
            max: 100,
            step: '1',
            value: String(Math.round(numberFrom(valueOf(key), 0) * 100)),
            onChange: (event) => setField(key, Math.round(numberFrom(event.target.value, 0)) / 100),
            style: { ...inputStyle(width || 64), padding: '2px 6px', fontSize: 12, textAlign: 'right' },
          }),
          h('span', { style: { color: TOKENS.secondary, fontSize: 11 } }, '%'),
        );

      const toggleRow = (key, title, desc) =>
        h(
          SettingRow,
          { title, desc },
          h(Switch, {
            checked: !!valueOf(key),
            label: title,
            onChange: () => setField(key, !valueOf(key)),
          }),
        );

      const sectionTitle = (text, extra) =>
        h(
          'div',
          { style: { marginTop: 12, marginBottom: 2, fontSize: 11, fontWeight: 600, color: TOKENS.secondary, letterSpacing: '0.04em' } },
          text,
          extra ? h('span', { style: { marginLeft: 8, fontWeight: 400, color: TOKENS.warn } }, extra) : null,
        );

      return h(
        'div',
        { style: { maxWidth: 720, color: TOKENS.text, fontSize: 12, lineHeight: '18px' } },
        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8 } }, '预算护栏'),

        sectionTitle('拦截'),
        h(
          SettingRow,
          {
            title: '拦截模式',
            desc: '自动拦截在达到阈值时取消本轮；手动拦截只提示，由你选择继续或中止。',
          },
          h(Switch, {
            checked: isAuto,
            label: '拦截模式',
            onChange: () => setField('interceptMode', isAuto ? 'manual' : 'auto'),
          }),
          h('span', { style: { minWidth: 56, color: isAuto ? TOKENS.brand : TOKENS.secondary } }, isAuto ? '自动拦截' : '手动拦截'),
        ),
        h(SettingRow, { title: '预警比例', desc: '达到此比例时预算条变色并显示 ⚠。' }, percentInput('warnRatio')),
        h(
          SettingRow,
          { title: '拦截阈值', desc: '达到此比例触发自动取消（auto）或提示（manual）。' },
          percentInput('interceptRatio'),
        ),
        h(
          SettingRow,
          { title: '未知模型告警', desc: '未定价 token 占比超过此值时提示“按最高价估算，实际可能偏低”。' },
          percentInput('unknownWarnRatio'),
        ),
        h(
          SettingRow,
          { title: '累计放行上限', desc: '手动模式「继续」最多累计放行多少预算；须低于硬停线。' },
          percentInput('maxGrantedPercent', 72),
        ),
        h(
          SettingRow,
          { title: '手动硬停倍数', desc: '手动模式（含「不再提示」）超过「拦截阈值 × 此倍数」时强制中止。' },
          numberInput('manualHardStopRatio', { min: 1, max: 10, step: 0.1, width: 72 }),
          h('span', { style: { color: TOKENS.secondary, fontSize: 11 } }, '×'),
        ),
        toggleRow('enforceAtPreStep', '每步前硬拦截', '超预算时拒绝下一步，避免继续产生模型调用。'),

        sectionTitle('每轮预估'),
        toggleRow('enableTurnEstimate', '启用每轮预估', '在对话卡片中显示消耗估算（注意：由于单步消耗波动大，未提供计划时仅展示近期历史均值，仅供参考）'),
        h(
          SettingRow,
          { title: '预估输出位置', desc: sidebarReady ? '右侧栏为 DSH 原生右侧面板中的一个常驻页。' : '当前未检测到右侧栏服务：选择右侧栏时会退回对话卡片。' },
          h(
            'select',
            {
              value: outputMode || 'both',
              onChange: (event) => setField('estimateOutput', event.target.value),
              style: { ...inputStyle(120), padding: '2px 6px', fontSize: 12 },
            },
            h('option', { value: 'chat' }, '对话卡片'),
            h('option', { value: 'sidebar' }, '右侧栏'),
            h('option', { value: 'both' }, '两者'),
          ),
        ),
        h(
          SettingRow,
          { title: '预估最小间隔', desc: '两次预估之间的最短毫秒数，避免连续快轮重复计算。' },
          numberInput('turnEstimateMinInterval', { min: 0, max: 3600000, step: 100, width: 90 }),
          h('span', { style: { color: TOKENS.secondary, fontSize: 11 } }, 'ms'),
        ),
        toggleRow('enablePreEstimate', '任务前粗估', '首轮开始前给出步数范围与预算占比。'),

        sectionTitle('默认预算'),
        h(
          'div',
          { style: { color: TOKENS.secondary, fontSize: 11, margin: '4px 0 6px' } },
          '所有会话的默认上限；单个会话可在输入框下方的预算条中覆盖。',
        ),
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' } },
          h(
            'label',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: TOKENS.secondary } },
            '金额',
            h('input', {
              type: 'number',
              min: 0,
              step: '0.01',
              value: String(valueOf('budgetAmount')),
              onChange: (event) => setField('budgetAmount', event.target.value),
              placeholder: '0',
              style: { ...inputStyle(100), padding: '3px 6px', fontSize: 12 },
            }),
          ),
          h(
            'label',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: TOKENS.secondary } },
            'Token',
            h('input', {
              type: 'number',
              min: 0,
              step: '1000',
              value: String(valueOf('tokenBudget')),
              onChange: (event) => setField('tokenBudget', event.target.value),
              placeholder: '0',
              style: { ...inputStyle(120), padding: '3px 6px', fontSize: 12 },
            }),
          ),
          h(
            'label',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: TOKENS.secondary } },
            '币种',
            h(
              'select',
              {
                value: String(valueOf('currency') || 'CNY'),
                onChange: (event) => setField('currency', event.target.value),
                style: { ...inputStyle(80), padding: '3px 6px', fontSize: 12 },
              },
              ...['CNY', 'RMB'].map((code) =>
                h('option', { key: code, value: code }, code),
              ),
            ),
          ),
        ),

        sectionTitle('快照'),
        toggleRow('enableSnapshot', '冷启动快照', '把累计状态写入磁盘，重启后先显示快照并标注「待校正」。'),
        h(
          SettingRow,
          { title: '快照保留会话数', desc: '每个实例最多保留的会话数，活跃会话优先。' },
          numberInput('snapshotMaxSessions', { min: 1, max: 512, width: 80 }),
        ),
        h(
          SettingRow,
          { title: '非活跃快照保留天数', desc: '超过这个天数的非活跃会话快照会被清理；0 表示不按时间清理。' },
          numberInput('snapshotMaxAgeDays', { min: 0, max: 3650, width: 80 }),
          h('span', { style: { color: TOKENS.secondary, fontSize: 11 } }, '天'),
        ),
        h(
          SettingRow,
          { title: '明细保留轮数', desc: '快照保留最近多少轮的重试明细；更早的重试用摘要替换，不再拒绝。' },
          numberInput('snapshotKeepTurns', { min: 1, max: 100, width: 72 }),
        ),
        h(
          SettingRow,
          { title: '每会话结算记录上限', desc: '每个会话最多记住多少条已结算步骤（含只记“已计费”的标记）；超过后重试会被拒绝而不是替换。' },
          numberInput('perSessionMaxSettled', { min: 1, max: 50000, width: 90 }),
        ),

        sectionTitle('访问'),
        h(
          SettingRow,
          {
            title: '仅本机可改设置',
            desc: '开启时 /config/save 只接受本机（loopback）请求；远程浏览器可以看数据但不能改全局预算。关闭后同一局域网内任何页面都能改。',
          },
          h(Switch, {
            checked: valueOf('requireLocalControl') !== false,
            label: '仅本机可改设置',
            onChange: () => setField('requireLocalControl', valueOf('requireLocalControl') === false),
          }),
        ),
        h(
          SettingRow,
          {
            title: '仅本机可操作本轮',
            desc: '开启时 /action（继续 / 不再提示 / 中止 / 设置本次预算）只接受本机请求。远程 GUI 想用 manual 的继续/中止，需要关掉这项或走 SSH 端口转发。',
          },
          h(Switch, {
            checked: valueOf('requireLocalAction') !== false,
            label: '仅本机可操作本轮',
            onChange: () => setField('requireLocalAction', valueOf('requireLocalAction') === false),
          }),
        ),

        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 } },
          h('button', { type: 'button', onClick: saveAll, disabled: !!busy, style: primaryButtonStyle(!!busy) }, busy ? '保存中…' : '保存全部设置'),
          message
            ? h(
                'span',
                { style: { color: message.startsWith('已保存') ? TOKENS.success : TOKENS.error } },
                message,
              )
            : null,
        ),
        h(
          'div',
          { style: { marginTop: 10, color: TOKENS.secondary, fontSize: 10 } },
          '价格：' + (config.priceSources || []).join(' → ') +
            ' · 节假日：' + holidayLabel(config.holidaysSource) +
            ' · 跨源白名单：' + ((config.allowedOrigins || []).length || '无') +
            ' · 右侧栏：' + (sidebarReady ? '可用' : '不可用') +
            ' · 绑定：' + (config.server && config.server.host ? config.server.host : '未知') +
            (config.server && config.server.loopback === false ? '（非本机绑定：需精确 Origin）' : '') +
            ' · 时区：Asia/Shanghai',
        ),
      );
    }

    return {
      inject: ['slots'],
      // Exposed for the coverage test: form controls + the keys that need YAML.
      settingsKeys: SETTINGS_KEYS,
      excludedKeys: FORM_EXCLUDED_KEYS,
      apply(ctx) {
        ctx.slots.inject('conversation.chat.turnTail', () =>
          ctx.slots.register(
            {
              name: 'conversation.chat.turnTail',
              id: 'budget-turn-estimate',
              order: 60,
              label: '预算进度',
            },
            TurnEstimateCard,
          ),
        );
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'budget-status',
              order: 10,
              label: '预算状态',
            },
            BudgetDock,
          ),
        );
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'budget-guard',
              order: 60,
              label: () => '预算护栏',
            },
            SettingsPage,
          ),
        );
        // Optional: DSH's right Sidebar is owned by dsh-better-sidebar, which
        // publishes `ctx.betterSidebar` for exactly this. Without the bundle
        // the inject never fires and the pill stays the only surface.
        if (typeof ctx.inject === 'function') {
          ctx.inject(['betterSidebar'], (sideCtx) => {
            const service = sideCtx.betterSidebar || (typeof sideCtx.get === 'function' ? sideCtx.get('betterSidebar') : null);
            if (!service || typeof service.registerTab !== 'function') return;
            sidebarHost.service = service;
            const register = () =>
              service.registerTab({
                id: SIDEBAR_TAB_ID,
                title: () => SIDEBAR_TAB_TITLE,
                description: () => '本会话的预算、已用费用，以及每轮结束后的剩余步数与金额估算',
                order: 45,
                single: true,
                component: BudgetPanel,
              });
            if (typeof sideCtx.effect === 'function') {
              sideCtx.effect(
                () => {
                  const dispose = register();
                  return () => {
                    if (sidebarHost.service === service) sidebarHost.service = null;
                    if (typeof dispose === 'function') dispose();
                  };
                },
                'budget-guard: right sidebar page',
              );
            } else {
              register();
            }
          });
        }
      },
    };
  },
});
