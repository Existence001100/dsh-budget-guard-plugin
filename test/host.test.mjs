import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, Config, mergeSnapshotState, money, name, serializableState, stateFromSnapshot } from '../lib/index.js';

// The price editor writes `$DSH_HOME/budget-guard/local-prices.json`. Anchor
// DSH_HOME at a scratch directory so a real user price table on this machine
// can never change an assertion here (and so this suite never writes to the
// real profile). `test/bom.test.mjs` skips `.tmp-*`.
const TEST_DSH_HOME = join(process.cwd(), 'test', '.tmp-dsh-home');
rmSync(TEST_DSH_HOME, { recursive: true, force: true });
mkdirSync(TEST_DSH_HOME, { recursive: true });
process.env.DSH_HOME = TEST_DSH_HOME;

function makeHarness(config, startSeq = 0, options = {}) {
  const events = [];
  const handlers = new Map();
  const routes = new Map();
  const commands = [];
  const commandExecutions = [];
  const bindOrigin = options.bindOrigin || 'http://127.0.0.1:56675';
  const commandService = {
    register(definition) {
      commands.push(definition);
      return () => {};
    },
    async execute(agent, line) {
      commandExecutions.push(line);
      return { commandId: 'test', result: { kind: 'success' } };
    },
  };
  const cancels = [];
  const warnings = [];
  const configEdits = [];
  const configEntry = { id: 'include:budget-guard', options: { id: 'budget-guard' } };
  const sessions = new Map();
  const agents = new Map();

  const session = {
    id: 'session-1',
    header: {},
    snapshotEvents: () => events.slice(),
  };
  sessions.set(session.id, session);

  const agent = {
    id: session.id,
    session,
    status: 'running',
    cancel(cause, options) {
      cancels.push({ cause, options });
      this.status = 'idle';
    },
  };
  agents.set(agent.id, agent);

  function addSession(id, parentSession) {
    const childEvents = [];
    const child = {
      id,
      header: parentSession ? { parentSession } : {},
      snapshotEvents: () => childEvents.slice(),
    };
    sessions.set(id, child);
    agents.set(id, {
      id,
      session: child,
      status: 'idle',
      cancel() {},
    });
    let childSeq = 0;
    return function emitChild(type, data, time = Date.now()) {
      const event = { type, seq: ++childSeq, time, data };
      childEvents.push(event);
      for (const listener of handlers.get('session/event') || []) listener(child, event);
      return event;
    };
  }

  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      info: () => {},
      error: () => {},
    },
    sessions: {
      get: (id) => sessions.get(String(id)),
    },
    agents: {
      get: (id) => agents.get(String(id)),
    },
    get(name) {
      if (name === 'sessions') return ctx.sessions;
      if (name === 'agents') return ctx.agents;
      if (name === 'commands') return commandService;
      if (name === 'configEditor') {
        return {
          entries: () => [configEntry],
          edit: (entry, change) => {
            configEdits.push({ entry, values: change({}, {}) });
            return Promise.resolve();
          },
        };
      }
      return undefined;
    },
    on(event, listener) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(listener);
      return () => {};
    },
    inject(names, callback) {
      const child = {
        ...ctx,
        webServer: {
          register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
          },
          getOrigin() {
            return bindOrigin;
          },
        },
        commands: {
          register(definition) {
            commands.push(definition);
            return () => {};
          },
        },
        effect(callback) {
          const dispose = callback();
          return () => {
            if (typeof dispose === 'function') dispose();
          };
        },
      };
      callback(child);
    },
    effect(callback) {
      callback();
      return () => {};
    },
  };

  apply(ctx, { enableSnapshot: false, ...config });

  let seq = startSeq;
  const defaultTime = Date.parse('2026-10-28T10:00:00+08:00'); // Wednesday peak
  function emit(type, data, time = defaultTime) {
    const event = { type, seq: ++seq, time, data };
    events.push(event);
    for (const listener of handlers.get('session/event') || []) listener(session, event);
    return event;
  }

  async function turnStopping() {
    for (const listener of handlers.get('agent/turn-stopping') || []) {
      await listener({ agent, turn: 1, signal: new AbortController().signal });
    }
  }

  async function preStep() {
    let decision = { kind: 'enter', messages: [] };
    for (const listener of handlers.get('agent/pre-step') || []) {
      decision = await listener(
        { agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
        async () => decision,
      );
    }
    return decision;
  }

  function callGet(
    url = '/dsh-budget/state?sessionId=session-1',
    headers = { host: '127.0.0.1:56675' },
    remoteAddress = '127.0.0.1',
  ) {
    const route = routes.get(url.split('?')[0]);
    assert.ok(route, `route registered for ${url}`);
    const response = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.body = text;
      },
    };
    return route
      .handler({ method: 'GET', url, headers, socket: { remoteAddress } }, response)
      .then(() => ({ status: response.status, body: JSON.parse(response.body) }));
  }

  function callPost(
    url,
    body,
    headers = { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
    remoteAddress = '127.0.0.1',
  ) {
    const route = routes.get(url);
    assert.ok(route, `route registered for ${url}`);
    const response = {
      status: 0,
      body: '',
      writeHead(status) {
        this.status = status;
      },
      end(text) {
        this.body = text;
      },
    };
    const payload = Buffer.from(JSON.stringify(body));
    const request = {
      method: 'POST',
      url,
      headers,
      socket: { remoteAddress },
      on(event, listener) {
        if (event === 'data') listener(payload);
        if (event === 'end') listener();
      },
    };
    return route.handler(request, response).then(() => ({ status: response.status, body: JSON.parse(response.body) }));
  }

  return {
    ctx,
    session,
    agent,
    events,
    handlers,
    routes,
    commands,
    commandExecutions,
    cancels,
    warnings,
    configEdits,
    addSession,
    emit,
    turnStopping,
    preStep,
    callGet,
    callPost,
  };
}

function assistant(harness, usage, text, provider = 'deepseek', model = 'deepseek-chat', time, step = 1) {
  return harness.emit(
    'assistant/message',
    {
      turn: 1,
      step,
      message: {
        role: 'assistant',
        source: { kind: 'model', provider, model },
        content: text ? [{ type: 'text', text }] : [],
      },
      stream: [],
      usage,
    },
    time,
  );
}

// ── Config validation is loud ───────────────────────────────────────────────
{
  const badMode = Config['~standard'].validate({ interceptMode: 'sometimes' });
  assert.ok(badMode.issues && badMode.issues.length === 1);
  const badRatio = Config['~standard'].validate({ warnRatio: 0.99, interceptRatio: 0.9 });
  assert.ok(badRatio.issues && badRatio.issues.some((issue) => issue.message.includes('warnRatio')));
  const unknown = Config['~standard'].validate({ budgteAmount: 2 });
  assert.ok(unknown.issues && unknown.issues[0].message.includes('unknown'));
  const good = Config['~standard'].validate({ interceptMode: 'manual', budgetAmount: 2 });
  assert.equal(good.value.interceptMode, 'manual');
  assert.equal(good.value.budgetAmount, 2);
  assert.equal(good.value.enableTurnEstimate, true);
  const badHolidays = Config['~standard'].validate({ holidays: '2026-10-01' });
  assert.ok(badHolidays.issues && badHolidays.issues.some((issue) => issue.message.includes('array')));
  const holidays = Config['~standard'].validate({ holidays: ['2026-10-01', '2026-10-02'] });
  assert.deepEqual(holidays.value.holidays, ['2026-10-01', '2026-10-02']);
  assert.deepEqual(Config['~standard'].validate({}).value.holidays, []);
  const origins = Config['~standard'].validate({ allowedOrigins: ['http://localhost:3000'] });
  assert.deepEqual(origins.value.allowedOrigins, ['http://localhost:3000']);
  const badOrigins = Config['~standard'].validate({ allowedOrigins: ['not-a-url'] });
  assert.ok(badOrigins.issues && badOrigins.issues.some((issue) => issue.message.includes('http')));
  const conflict = Config['~standard'].validate({ maxGrantedPercent: 50 });
  assert.ok(conflict.issues && conflict.issues.some((issue) => issue.message.includes('manual hard stop')));
  const badCurrency = Config['~standard'].validate({ currency: 'USD' });
  assert.ok(badCurrency.issues && badCurrency.issues.some((issue) => issue.message.includes('CNY or RMB')));
  assert.equal(Config['~standard'].validate({ currency: 'RMB' }).value.currency, 'RMB');
  assert.equal(Config['~standard'].validate({ currency: 'cny' }).value.currency, 'CNY');
  const zeroBudget = Config['~standard'].validate({ budgetAmount: 0, tokenBudget: 0 });
  assert.equal(zeroBudget.issues, undefined, '0 is a valid budget value');
  assert.equal(zeroBudget.value.budgetAmount, 0);
  assert.equal(zeroBudget.value.tokenBudget, 0);
  for (const key of [
    'unknownWarnRatio',
    'maxGrantedPercent',
    'manualHardStopRatio',
    'snapshotMaxSessions',
    'snapshotMaxAgeDays',
    'snapshotKeepTurns',
    'useBuiltinHolidays',
    'snapshotPath',
    'perSessionMaxSettled',
    'requireLocalControl',
  ]) {
    assert.ok(Config.dict[key], `${key} is present in the schemastery projection`);
  }
}

// ── settings page config API ───────────────────────────────────────────────
{
  const harness = makeHarness({});
  const initial = await harness.callGet('/dsh-budget/config');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.config.interceptMode, 'auto');

  const saved = await harness.callPost('/dsh-budget/config/save', {
    interceptMode: 'manual',
    budgetAmount: 3,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.applying, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.configEdits.length, 1);
  assert.equal(harness.configEdits[0].values.interceptMode, 'manual');
  assert.equal(harness.configEdits[0].values.budgetAmount, 3);

  const bad = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'nope' });
  assert.equal(bad.status, 400);
}

// ── every tunable is readable and patchable through one validated route ────
{
  const harness = makeHarness({});
  const initial = await harness.callGet('/dsh-budget/config');
  for (const key of [
    'interceptMode',
    'budgetAmount',
    'tokenBudget',
    'currency',
    'warnRatio',
    'interceptRatio',
    'enablePreEstimate',
    'enableTurnEstimate',
    'estimateOutput',
    'turnEstimateMinInterval',
    'enforceAtPreStep',
    'unknownWarnRatio',
    'maxGrantedPercent',
    'manualHardStopRatio',
    'perSessionMaxSettled',
    'requireLocalControl',
    'useBuiltinHolidays',
    'enableSnapshot',
    'snapshotMaxSessions',
    'snapshotKeepTurns',
    'snapshotMaxAgeDays',
  ]) {
    assert.ok(key in initial.body.config, `/config exposes ${key}`);
  }
  assert.deepEqual(initial.body.config.output, { mode: 'both', chat: true, sidebar: true });
  assert.equal(initial.body.config.holidaysSource, 'default');

  const ok = await harness.callPost('/dsh-budget/config/save', {
    warnRatio: 0.7,
    interceptRatio: 0.9,
    estimateOutput: 'sidebar',
    turnEstimateMinInterval: 900,
    enablePreEstimate: false,
  });
  assert.equal(ok.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const saved = harness.configEdits.at(-1).values;
  assert.equal(saved.warnRatio, 0.7);
  assert.equal(saved.interceptRatio, 0.9);
  assert.equal(saved.estimateOutput, 'sidebar');
  assert.equal(saved.turnEstimateMinInterval, 900);
  assert.equal(saved.enablePreEstimate, false);
  // The patch carries exactly the keys that were asked for, normalized.
  assert.deepEqual(
    Object.keys(saved).sort(),
    ['enablePreEstimate', 'estimateOutput', 'interceptRatio', 'turnEstimateMinInterval', 'warnRatio'],
  );

  // The settings page posts every control it owns in one patch; that whole
  // payload must validate against the current Config.
  const form = {
    interceptMode: 'auto',
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
    budgetAmount: 0,
    tokenBudget: 0,
    currency: 'CNY',
    enableSnapshot: true,
    snapshotMaxSessions: 200,
    snapshotKeepTurns: 8,
  };
  const formSave = await harness.callPost('/dsh-budget/config/save', form);
  assert.equal(formSave.status, 200, JSON.stringify(formSave.body));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(Object.keys(harness.configEdits.at(-1).values).sort(), Object.keys(form).sort());
  // A form value that ties the grant cap to the hard stop is refused, not clamped.
  const formTooLoose = await harness.callPost('/dsh-budget/config/save', { ...form, maxGrantedPercent: 50 });
  assert.equal(formTooLoose.status, 400);

  // Cross-field rules are enforced by the same validator the loader uses.
  const crossed = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.99, interceptRatio: 0.5 });
  assert.equal(crossed.status, 400);
  assert.equal(crossed.body.error, 'invalid');
  assert.ok(crossed.body.issues.some((item) => item.message.includes('warnRatio')));
  assert.ok(crossed.body.issues.every((item) => Array.isArray(item.path) && typeof item.message === 'string'));

  const grantConflict = await harness.callPost('/dsh-budget/config/save', { maxGrantedPercent: 60 });
  assert.equal(grantConflict.status, 400);
  assert.ok(grantConflict.body.issues.some((item) => item.message.includes('conflicts with interceptRatio')));
  assert.ok(grantConflict.body.issues.some((item) => item.message.includes('maxGrantedPercent=60')));

  const badEnum = await harness.callPost('/dsh-budget/config/save', { estimateOutput: 'telepathy' });
  assert.equal(badEnum.status, 400);

  const badRange = await harness.callPost('/dsh-budget/config/save', { turnEstimateMinInterval: -1 });
  assert.equal(badRange.status, 400);

  const unknownKey = await harness.callPost('/dsh-budget/config/save', { bogus: 1 });
  assert.equal(unknownKey.status, 400);
  assert.equal(unknownKey.body.error, 'unknown-key');
  assert.deepEqual(unknownKey.body.keys, ['bogus']);

  // `estimateOutput` decides where the estimate may render.
  const sidebarOnly = makeHarness({ estimateOutput: 'sidebar' });
  sidebarOnly.emit('user/message', {});
  const sidebarView = await sidebarOnly.callGet();
  assert.deepEqual(sidebarView.body.state.config.output, { mode: 'sidebar', chat: false, sidebar: true });
  const chatOnly = makeHarness({ estimateOutput: 'chat' });
  chatOnly.emit('user/message', {});
  const chatView = await chatOnly.callGet();
  assert.deepEqual(chatView.body.state.config.output, { mode: 'chat', chat: true, sidebar: false });
  const disabled = makeHarness({ estimateOutput: 'both', enableTurnEstimate: false });
  disabled.emit('user/message', {});
  const disabledView = await disabled.callGet();
  assert.deepEqual(disabledView.body.state.config.output, { mode: 'both', chat: false, sidebar: false });
}

// ── Origin allowlist keeps production strict and allows dev ports ──────────
{
  const harness = makeHarness({ allowedOrigins: ['http://localhost:3000'] });
  const denied = await harness.callGet('/dsh-budget/config', {
    host: '127.0.0.1:56675',
    origin: 'http://evil.example',
  });
  assert.equal(denied.status, 403);
  const allowed = await harness.callGet('/dsh-budget/config', {
    host: '127.0.0.1:56675',
    origin: 'http://localhost:3000',
  });
  assert.equal(allowed.status, 200);
  const noOrigin = await harness.callGet('/dsh-budget/config', { host: '127.0.0.1:56675' });
  assert.equal(noOrigin.status, 200);
}

// ── manual continue is cumulative; suppress stops prompts ──────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'manual', interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  // Peak: miss 2/M + output 8/M => 0.9 + 0.05 = 0.95 of the ¥1 budget.
  assistant(harness, { inputTokens: 450000, outputTokens: 6250 }, 'done');
  await harness.turnStopping();
  let state = (await harness.callGet()).body.state;
  assert.equal(state.manual.pending, true);
  assert.equal(state.manual.grantedPercent, 0);

  const continued1 = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'continue' });
  assert.equal(continued1.status, 200);
  const continued2 = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'continue' });
  assert.equal(continued2.status, 200);
  state = (await harness.callGet()).body.state;
  assert.equal(state.manual.continues, 2);
  assert.equal(state.manual.grantedPercent, 20);

  harness.emit('step/start', { turn: 1, step: 2 });
  assistant(
    harness,
    { inputTokens: 100000, outputTokens: 0 },
    'more',
    'deepseek',
    'deepseek-chat',
    undefined,
    2,
  );
  await harness.turnStopping();
  state = (await harness.callGet()).body.state;
  assert.equal(state.manual.pending, true, 'threshold reached again after the granted margin');
  const suppressed = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'suppress' });
  assert.equal(suppressed.status, 200);
  state = (await harness.callGet()).body.state;
  assert.equal(state.manual.pending, false);
  assert.equal(state.manual.suppressed, true);
  await harness.turnStopping();
  state = (await harness.callGet()).body.state;
  assert.equal(state.manual.pending, false, 'suppressed manual mode does not prompt again');
}

// ── parent + child aggregation ──────────────────────────────────────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'parent');
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const emitChild = harness.addSession('child-1', 'session-1');
  emitChild('turn/start', { turn: 1 });
  emitChild('step/start', { turn: 1, step: 1 });
  emitChild('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-flash' },
      content: [],
    },
    stream: [],
    usage: { inputTokens: 50000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 50000 },
  });
  emitChild('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const state = (await harness.callGet()).body.state;
  assert.equal(state.parentSessionId, null);
  assert.equal(state.aggregate.children.length, 1);
  assert.equal(state.aggregate.children[0].sessionId, 'child-1');
  assert.ok(Math.abs(state.aggregate.totalCost - (state.aggregate.self.cost + state.aggregate.childrenCost)) < 1e-9);
  assert.ok(state.aggregate.totalCost > state.aggregate.self.cost);
}

// ── P2: a snapshot-only child makes aggregate.complete false ───────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot-child');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(join(dir, 'snapshots.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      sessions: {
        'child-snapshot': {
          sessionId: 'child-snapshot',
          parentSessionId: 'session-1',
          cost: 1,
          lastSeq: 5,
          totalTokens: 100000,
          byModel: {},
          byTier: { peak: { cost: 1, tokens: 100000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 1, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
        },
        'grandchild-snapshot': {
          sessionId: 'grandchild-snapshot',
          parentSessionId: 'child-snapshot',
          cost: 0.5,
          lastSeq: 5,
          totalTokens: 50000,
          byModel: {},
          byTier: { peak: { cost: 0.5, tokens: 50000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.5, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
        },
      },
    }));
    const harness = makeHarness({
      enableSnapshot: true,
      snapshotPath: join(dir, 'snapshots.json'),
      turnEstimateMinInterval: 0,
    });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 10000, outputTokens: 0 }, 'parent');
    const state = (await harness.callGet()).body.state;
    assert.equal(state.aggregate.children.length, 2);
    assert.equal(state.aggregate.children.find((child) => child.sessionId === 'grandchild-snapshot').depth, 2);
    assert.equal(state.aggregate.children[0].stale, true);
    assert.equal(state.aggregate.complete, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── cold start: snapshot first, then live events win ───────────────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot');
  const snapshotPath = join(dir, 'snapshots.json');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const first = makeHarness({
      enableSnapshot: true,
      snapshotPath,
      turnEstimateMinInterval: 0,
    });
    first.emit('turn/start', { turn: 1 });
    first.emit('step/start', { turn: 1, step: 1 });
    assistant(first, { inputTokens: 100000, outputTokens: 0 }, 'cached');
    assistant(first, { inputTokens: 100000, outputTokens: 0 }, 'cached retry');
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const snapshotFiles = readdirSync(dir).filter((name) => name.startsWith('snapshots.') && name.endsWith('.json'));
    assert.ok(snapshotFiles.length >= 1, 'per-instance snapshot file written');

    const saved = JSON.parse(readFileSync(join(dir, snapshotFiles[0]), 'utf8'));
    const savedLast = Number(saved.sessions?.['session-1']?.lastSeq) || 0;
    assert.ok(savedLast > 0, 'snapshot carries a log watermark');

    const second = makeHarness(
      {
        enableSnapshot: true,
        snapshotPath,
        turnEstimateMinInterval: 0,
      },
      savedLast,
    );
    const cold = (await second.callGet()).body.state;
    assert.equal(cold.stale, true);
    assert.ok(Math.abs(cold.used.cost - 0.2) < 1e-9, `snapshot cost was ${cold.used.cost}`);
    assert.equal(cold.counters.replacedSettlements, 1, 'replacement audit survives restart');

    second.emit('turn/start', { turn: 2 });
    second.emit('step/start', { turn: 2, step: 1 });
    second.emit('assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 10000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 10000 },
    });
    const live = (await second.callGet()).body.state;
    assert.equal(live.stale, false);
    assert.ok(live.used.cost > cold.used.cost);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0: unknown model gets a conservative shadow cost and triggers the cap ──
{
  const harness = makeHarness({ budgetAmount: 0.1, interceptMode: 'auto', interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'unknown', 'local', 'mystery-model');
  assert.ok((await harness.callGet()).body.state.used.shadowCost > 0.3);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'amount budget triggers on conservative shadow cost');
  const state = (await harness.callGet()).body.state;
  assert.equal(state.used.cost, 0);
  assert.ok(state.pricing.protectionAtRisk);
}

// ── P0: same turn:step in two sessions must not collide ────────────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'first');
  assistant(harness, { inputTokens: 200000, outputTokens: 0 }, 'replacement');

  const emitOther = harness.addSession('other-session');
  const peakTime = Date.parse('2026-10-28T10:00:00+08:00');
  emitOther('turn/start', { turn: 1 }, peakTime);
  emitOther('step/start', { turn: 1, step: 1 }, peakTime);
  emitOther('assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
    stream: [],
    usage: { inputTokens: 50000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 50000 },
  }, peakTime);

  const parent = (await harness.callGet()).body.state;
  const other = (await harness.callGet('/dsh-budget/state?sessionId=other-session')).body.state;
  assert.equal(parent.counters.replacedSettlements, 1);
  assert.equal(other.counters.replacedSettlements, 0);
  assert.ok(Math.abs(parent.used.cost - 0.4) < 1e-9);
  assert.ok(Math.abs(other.used.cost - 0.1) < 1e-9);
}

// ── P0: peak -> off-peak retry replaces the whole tier split ───────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  const peak = Date.parse('2026-10-28T10:00:00+08:00');
  const offpeak = Date.parse('2026-10-28T22:00:00+08:00');
  harness.emit('turn/start', { turn: 1 }, peak);
  harness.emit('step/start', { turn: 1, step: 1 }, peak);
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'peak attempt', 'deepseek', 'deepseek-flash', peak);
  assistant(harness, { inputTokens: 200000, outputTokens: 0 }, 'offpeak retry', 'deepseek', 'deepseek-flash', offpeak);
  const state = (await harness.callGet()).body.state;
  assert.ok(Math.abs(state.used.cost - 0.2) < 1e-9);
  assert.equal(state.pricing.byTier.peak.cost, 0);
  assert.ok(Math.abs(state.pricing.byTier.offpeak.cost - 0.2) < 1e-9);
  assert.equal(state.counters.replacedSettlements, 1);
}

// ── P0 (r6): the disk being ahead means its totals already contain our money ─
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot-stale');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'live', 'deepseek', 'deepseek-chat', undefined, 1);
    const instanceName = readdirSync(dir).find((name) => name !== 'snapshots.json' && name.endsWith('.json'));
    const instancePath = join(dir, instanceName);
    const before = JSON.parse(readFileSync(instancePath, 'utf8')).sessions['session-1'].lastSeq;

    // A second instance folded further into the same log (lastSeq 99) and left
    // a snapshot whose charge detail is not available to us.
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now() + 1000,
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 9,
          lastSeq: 99,
          totalTokens: 1000,
          byModel: {},
          byTier: { peak: { cost: 9, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 9, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
        },
      },
    }));
    harness.emit('step/start', { turn: 1, step: 2 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'stale writer', 'deepseek', 'deepseek-chat', undefined, 2);
    const saved = JSON.parse(readFileSync(instancePath, 'utf8')).sessions['session-1'];
    assert.notEqual(before, 99);
    assert.equal(saved.lastSeq, 99, 'the newer disk lastSeq is kept, not overwritten');
    // The disk is strictly further into the same log, so its totals already
    // include both local settlements: adding them again would double-bill.
    assert.equal(saved.cost, 9, 'no money is invented by a merge');
    assert.equal(saved.stepCharges.length, 0, 'no local detail is re-added');
    const carried = saved.settledCharges.map((entry) => entry[0]).sort();
    assert.deepEqual(carried, ['session-1:1:1', 'session-1:1:2'], 'local keys survive as markers');
    assert.ok(saved.settledCharges.every((entry) => entry[1] === null), 'markers carry no summary');
    assert.ok(harness.warnings.some((warning) => warning.includes('snapshot merge')), 'the merge is auditable');
    assert.ok(harness.warnings.some((warning) => warning.includes('kept 2 marker(s) without money')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0 (r6): an EVICTED step on disk must not be re-adopted by a peer ──────
{
  const config = { perSessionMaxSettled: 2000 };
  const emptyTotals = {
    cost: 0.012,
    lastSeq: 100,
    settledSeqWatermark: 100,
    totalTokens: 2000,
    byModel: { 'deepseek-chat': { cost: 0.012, tokens: 2000, peakCost: 0.012, offpeakCost: 0, peakTokens: 2000, offpeakTokens: 0, calls: 2 } },
    byTier: { peak: { cost: 0.012, tokens: 2000 }, offpeak: { cost: 0, tokens: 0 } },
    costBreakdown: { inputMiss: 0.012, inputHit: 0, output: 0 },
    unknownTokens: 0,
    unknownModels: {},
    priceWarnings: [],
    // Both records were evicted: the map no longer names step 50, but its
    // money is still inside `cost`.
    stepCharges: [],
    settledCharges: [],
  };
  const stepFifty = {
    cost: 0.01,
    shadow: 0,
    tokens: 1000,
    input: 1000,
    inputMiss: 1000,
    output: 0,
    cacheRead: 0,
    model: 'deepseek-chat',
    tier: 'peak',
    seq: 50,
    unknown: false,
    breakdown: { inputMiss: 0.01, inputHit: 0, output: 0 },
  };
  const base = stateFromSnapshot(emptyTotals, 0);
  const local = stateFromSnapshot({
    sessionId: 'session-1',
    lastSeq: 60,
    stepCharges: [['session-1:1:50', stepFifty]],
    settledCharges: [['session-1:1:50', [1, 0, 0.01, 0, 1000, 1000, 1000, 0, 0, 0.01, 0, 0, 'deepseek-chat', 50]]],
  }, 0);
  const merged = mergeSnapshotState(base, local, config);
  assert.equal('adopted' in merged, false, 'a merge has no adoption counter: it can never add money');
  assert.equal('newer' in merged, false, 'no seq gate exists any more: the caller guarantees disk >= memory');
  assert.equal(merged.markers, 1);
  assert.equal(merged.state.cost, 0.012, 'cost stays the disk value (step 50 is already inside it)');
  assert.equal(merged.state.stepCharges.size, 0);
  assert.equal(merged.state.settledCharges.get('session-1:1:50'), true, 'kept only as a "already billed" marker');

  // Idempotency: merging the same pair twice must not change anything (the
  // writer re-reads the disk on every flush, so this runs repeatedly for real).
  const again = mergeSnapshotState(merged.state, local, config);
  assert.equal(again.state.cost, 0.012);
  assert.equal(again.markers, 0, 'the second pass finds every key already known');
  assert.equal(again.dropped, 1);

  // A legacy 13-field summary has no seq. Merge-wise it can only become a
  // marker; retry-wise `applyUsage` refuses it (see the short-summary test).
  const legacy = stateFromSnapshot({
    sessionId: 'session-1',
    lastSeq: 60,
    stepCharges: [],
    settledCharges: [['session-1:1:9', [1, 0, 0.01, 0, 1000, 1000, 1000, 0, 0, 0.01, 0, 0, 'deepseek-chat']]],
  }, 0);
  const legacyMerged = mergeSnapshotState(stateFromSnapshot(emptyTotals, 0), legacy, config);
  assert.equal(legacyMerged.state.cost, 0.012);
  assert.equal(legacyMerged.state.settledCharges.get('session-1:1:9'), true);
}

// ── P0: retry rolls back byModel, costBreakdown and unknownTokens ──────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'unknown attempt', 'local', 'mystery-model');
  const before = (await harness.callGet()).body.state;
  assert.equal(before.pricing.unknownTokens, 100000);
  assert.ok(before.used.shadowCost > 0);

  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'known retry');
  const after = (await harness.callGet()).body.state;
  assert.equal(after.pricing.unknownTokens, 0);
  assert.deepEqual(after.pricing.unknownModels, {});
  assert.equal(after.pricing.byModel['mystery-model'], undefined);
  assert.equal(after.pricing.byModel['deepseek-chat'].tokens, 100000);
  assert.ok(Math.abs(after.used.breakdown.inputMiss - 0.2) < 1e-9);
  assert.equal(after.used.breakdown.inputHit, 0);
  assert.equal(after.used.breakdown.output, 0);
  assert.equal(after.used.tokens, 100000);
  assert.equal(after.used.shadowCost, 0);
}

// ── P1: timezone-less warning is emitted once, not per message ─────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'no tz one', 'deepseek', 'deepseek-chat', '2026-10-28T10:00:00', 1);
  harness.emit('step/start', { turn: 1, step: 2 });
  assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'no tz two', 'deepseek', 'deepseek-chat', '2026-10-28T10:00:01', 2);
  const warnings = (await harness.callGet()).body.state.pricing.warnings.filter((warning) => warning.includes('缺少时区'));
  assert.equal(warnings.length, 1);
}

// ── P1: manual grant cap, hard stop after suppress, off semantics ──────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'manual', interceptRatio: 0.95, maxGrantedPercent: 30, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 450000, outputTokens: 6250 }, 'threshold');
  for (let index = 0; index < 3; index += 1) {
    const result = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'continue' });
    assert.equal(result.body.ok, true);
  }
  const fourth = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'continue' });
  assert.equal(fourth.body.ok, false);
  assert.equal(fourth.body.error, 'grant-limit');
  let state = (await harness.callGet()).body.state;
  assert.equal(state.manual.continues, 3);
  assert.equal(state.manual.canContinue, false);

  await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'suppress' });
  harness.emit('step/start', { turn: 1, step: 2 });
  assistant(harness, { inputTokens: 300000, outputTokens: 0 }, 'over hard stop', 'deepseek', 'deepseek-chat', undefined, 2);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'suppress still hard-stops at 1.5x intercept');
  state = (await harness.callGet()).body.state;
  assert.equal(state.manual.pending, false);
}

// ── P1: off restores the default budget name; precision has no tail ────────
{
  const harness = makeHarness({ budgetAmount: 2, turnEstimateMinInterval: 0 });
  const command = harness.commands[0];
  await command.handler({ agent: harness.agent, rawInput: '1.5', signal: new AbortController().signal });
  const off = await command.handler({ agent: harness.agent, rawInput: 'off', signal: new AbortController().signal });
  assert.ok(off.text.includes('默认预算'));
  const state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 2);

  harness.emit('turn/start', { turn: 2 });
  harness.emit('step/start', { turn: 2, step: 1 });
  assistant(harness, { inputTokens: 50000, outputTokens: 0 }, '0.1');
  harness.emit('step/start', { turn: 2, step: 2 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, '0.2', 'deepseek', 'deepseek-chat', undefined, 2);
  const after = (await harness.callGet()).body.state;
  assert.equal(after.used.costLabel, '¥0.30');

  const tokenOnly = makeHarness({ tokenBudget: 20000, turnEstimateMinInterval: 0 });
  const tokenOff = await tokenOnly.commands[0].handler({
    agent: tokenOnly.agent,
    rawInput: 'off',
    signal: new AbortController().signal,
  });
  assert.ok(tokenOff.text.includes('20.0k tokens'));
  assert.equal((await tokenOnly.callGet()).body.state.budget.tokens, 20000);

  const tiny = makeHarness({ turnEstimateMinInterval: 0 });
  tiny.emit('turn/start', { turn: 1 });
  tiny.emit('step/start', { turn: 1, step: 1 });
  assistant(tiny, { inputTokens: 10, outputTokens: 0 }, 'tiny');
  assert.equal((await tiny.callGet()).body.state.used.costLabel, '<¥0.0001');
}

// ── config/save auth: local peer + local Host is enough (no Origin needed) ──
{
  const harness = makeHarness({});
  // The desktop shell / some same-origin fetches send neither header. A loopback
  // peer that addressed THIS listener is the local user: accept it.
  const noHeaders = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '127.0.0.1:56675' });
  assert.equal(noHeaders.status, 200, 'local peer + local Host needs no Origin');
  const localhostAlias = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: 'localhost:56675' });
  assert.equal(localhostAlias.status, 200, 'localhost is an alias of a loopback bind');

  // DNS rebinding: the page resolves to 127.0.0.1 but its Host is evil.com.
  const rebound = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: 'evil.example:56675' });
  assert.equal(rebound.status, 403, 'a foreign Host is refused even from loopback');
  assert.equal((await harness.callGet('/dsh-budget/config')).body.config.server.lastReject.reason, 'no-origin-and-host-not-local');

  const nullOrigin = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '127.0.0.1:56675', origin: 'null' });
  assert.equal(nullOrigin.status, 403);
  const same = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' });
  assert.equal(same.status, 200);
  const fetchMetadata = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, {
    host: '127.0.0.1:56675',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(fetchMetadata.status, 200, 'same-origin fetch without Origin accepted via Fetch Metadata');
}

// ── a non-loopback peer is still refused, with or without headers ─────────
{
  const harness = makeHarness({});
  const lanNoHeaders = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '127.0.0.1:56675' }, '192.168.1.9');
  assert.equal(lanNoHeaders.status, 403, 'a LAN peer cannot ride the local-Host rule');
  const lanOrigin = await harness.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' }, '192.168.1.9');
  assert.equal(lanOrigin.status, 403);
  // A public bind always needs the exact Origin, even from loopback.
  const exposed = makeHarness({}, 0, { bindOrigin: 'http://0.0.0.0:3080' });
  const publicNoOrigin = await exposed.callPost('/dsh-budget/config/save', { interceptMode: 'auto' }, { host: '0.0.0.0:3080' });
  assert.equal(publicNoOrigin.status, 403);
  const exposedConfig = await exposed.callGet('/dsh-budget/config', { host: '0.0.0.0:3080' });
  assert.equal(exposedConfig.status, 200, 'reads still work on a public bind when Host names it');
  assert.equal(exposedConfig.body.config.server.lastReject.reason, 'no-origin-on-public-bind');
}

// ── P2: a failing agent.cancel must not make pre-step reject throw ─────────
{
  const harness = makeHarness({ budgetAmount: 0.5, interceptMode: 'auto', interceptRatio: 0.5, turnEstimateMinInterval: 0 });
  harness.agent.cancel = () => {
    throw new Error('already closed');
  };
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 300000, outputTokens: 0 }, 'over');
  const decision = await harness.preStep();
  assert.equal(decision.kind, 'reject');
  assert.ok(harness.warnings.some((warning) => warning.includes('budget cancel failed')));
}

// ── P0: per-instance snapshot files merge, newer savedAt wins ──────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot-merge');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshot = (id, cost, savedAt) => ({
    version: 2,
    savedAt,
    sessions: {
      [id]: {
        sessionId: id,
        cost,
        lastSeq: 5,
        totalTokens: 100000,
        byModel: {},
        byTier: { peak: { cost, tokens: 100000 }, offpeak: { cost: 0, tokens: 0 } },
        costBreakdown: { inputMiss: cost, inputHit: 0, output: 0 },
        unknownTokens: 0,
        unknownModels: {},
        priceWarnings: [],
        manualContinues: 0,
      },
    },
  });
  try {
    writeFileSync(join(dir, 'snapshots.111.json'), JSON.stringify(snapshot('alpha', 1, 100)));
    writeFileSync(join(dir, 'snapshots.222.json'), JSON.stringify(snapshot('beta', 2, 200)));
    writeFileSync(join(dir, 'snapshots.333.json'), JSON.stringify(snapshot('alpha', 3, 300)));

    const harness = makeHarness({
      enableSnapshot: true,
      snapshotPath: join(dir, 'snapshots.json'),
    });
    const alpha = await harness.callGet('/dsh-budget/state?sessionId=alpha');
    const beta = await harness.callGet('/dsh-budget/state?sessionId=beta');
    assert.equal(alpha.body.state.used.cost, 3, 'newer instance snapshot wins');
    assert.equal(beta.body.state.used.cost, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P1: snapshot cap keeps active sessions, drops oldest inactive ──────────
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot-cap');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const inactive = {};
  for (let index = 0; index < 3; index += 1) {
    inactive[`old-${index}`] = {
      sessionId: `old-${index}`,
      cost: index,
      lastSeq: 1,
      totalTokens: 1,
      byModel: {},
      byTier: { peak: { cost: 0, tokens: 0 }, offpeak: { cost: 0, tokens: 0 } },
      costBreakdown: { inputMiss: 0, inputHit: 0, output: 0 },
      unknownTokens: 0,
      unknownModels: {},
      priceWarnings: [],
    };
  }
  writeFileSync(join(dir, 'snapshots.json'), JSON.stringify({ version: 2, savedAt: now - 1000, sessions: inactive }));
  try {
    const harness = makeHarness({
      enableSnapshot: true,
      snapshotPath: join(dir, 'snapshots.json'),
      snapshotMaxSessions: 2,
      snapshotMaxAgeDays: 30,
      turnEstimateMinInterval: 0,
    });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 10000, outputTokens: 0 }, 'active');
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const file = readdirSync(dir).find((name) => name !== 'snapshots.json' && name.startsWith('snapshots.') && name.endsWith('.json'));
    assert.ok(file, 'instance snapshot written');
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const ids = Object.keys(saved.sessions);
    assert.equal(ids.length, 2, 'cap applied');
    assert.ok(ids.includes('session-1'), 'active session retained');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0: trimmed Charge details refuse a duplicate instead of double-billing ─
{
  const dir = join(process.cwd(), 'test', '.tmp-snapshot-trim');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const first = makeHarness({
      enableSnapshot: true,
      snapshotPath,
      snapshotKeepTurns: 1,
      turnEstimateMinInterval: 0,
    });
    first.emit('turn/start', { turn: 1 });
    for (let step = 1; step <= 60; step += 1) {
      first.emit('step/start', { turn: 1, step });
      first.emit('assistant/message', {
        turn: 1,
        step,
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
        stream: [],
        usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1000 },
      });
    }
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    first.emit('turn/start', { turn: 2 });
    first.emit('step/start', { turn: 2, step: 1 });
    first.emit('assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1000 },
    });
    first.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });
    const file = readdirSync(dir).find((name) => name !== 'snapshots.json' && name.endsWith('.json'));
    assert.ok(file, 'sync snapshot written without waiting for debounce');
    const saved = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    const savedState = saved.sessions['session-1'];
    assert.ok(
      savedState.settledCharges.some((entry) => entry[0] === 'session-1:1:1'),
      'the trimmed step keeps a rollback summary',
    );
    assert.equal(savedState.stepCharges.length, 1, 'only the current turn charge detail is retained');
    assert.ok(first.warnings.some((warning) => warning.includes('stepCharges trimmed')));

    const second = makeHarness(
      { enableSnapshot: true, snapshotPath, snapshotKeepTurns: 1, turnEstimateMinInterval: 0 },
      Number(savedState.lastSeq) || 0,
    );
    const before = (await second.callGet()).body.state;
    // A retry of the step whose detail was trimmed: it must REPLACE the old
    // settlement from the summary, not be refused (that was the P0).
    second.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 3000 },
    });
    const after = (await second.callGet()).body.state;
    assert.equal(after.counters.blockedSettlements, 0, 'a trimmed detail is replaced, never refused');
    assert.equal(after.counters.replacedSettlements, 1, 'the replacement is counted');
    assert.equal(
      after.used.tokens,
      before.used.tokens + 2000,
      'the ledger moved from the old 1000-token settlement to the new 3000-token one',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── composer budget form uses the /budget command path ──────────────────────
{
  const harness = makeHarness({});
  const result = await harness.callPost('/dsh-budget/action', {
    sessionId: 'session-1',
    action: 'set-budget',
    amount: 2,
    tokens: 30000,
  });
  assert.equal(result.status, 200);
  assert.equal(harness.commandExecutions.length, 1);
  assert.equal(harness.commandExecutions[0], '/budget both 2 30000');
}

// ── Accounting, plan detection and per-turn estimate ────────────────────────
{
  const harness = makeHarness({
    budgetAmount: 1,
    interceptMode: 'auto',
    warnRatio: 0.8,
    interceptRatio: 0.95,
    enablePreEstimate: true,
    enableTurnEstimate: true,
    turnEstimateMinInterval: 0,
  });

  harness.emit('user/message', {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '把这个仓库整理成可发布状态' }],
  });
  harness.emit('turn/start', { turn: 1 });
  const midTurn = await harness.callGet();
  assert.ok(midTurn.body.state.preEstimate, 'pre-task estimate exists before the turn closes');
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 120000, outputTokens: 8000 }, '计划共 6 步：先审计，再修改。');
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });

  const snapshot = await harness.callGet();
  assert.equal(snapshot.status, 200);
  const state = snapshot.body.state;
  assert.ok(state, 'state is served');
  assert.equal(state.counters.planSteps, 6);
  assert.equal(state.estimate.source, 'model_plan');
  assert.equal(state.estimate.remainingSteps, 5, 'model plan is preferred');
  assert.equal(state.estimate.basis, 'model-plan');
  assert.equal(state.estimate.progressBasis, 'plan');
  assert.ok(state.estimate.text.includes('已完成约'));
  assert.ok(state.estimate.text.includes('模型计划，仅供参考'));
  assert.ok(state.estimate.remainingCostLabel.startsWith('¥'));
  // 120k input at ¥2/M + 8k output at ¥8/M = ¥0.24 + ¥0.064
  assert.ok(Math.abs(state.used.cost - 0.304) < 0.000001, `cost was ${state.used.cost}`);
  assert.equal(state.used.percent, 30);
  assert.equal(harness.commands.length, 1);
  assert.ok(harness.routes.has('/dsh-budget/action'));
  assert.ok(harness.routes.has('/dsh-budget/config'));
  assert.ok(harness.routes.has('/dsh-budget/prices'));
  assert.ok(harness.routes.has('/dsh-budget/prices/save'));
  assert.ok(state.pricing.sources.includes('official-prices.json'));
  assert.equal(state.pricing.holidaysSource, 'default');
}

// ── Saturday is off-peak; cost is the off-peak price ────────────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  const saturday = Date.parse('2026-10-31T10:00:00+08:00');
  harness.emit('turn/start', { turn: 1 }, saturday);
  harness.emit('step/start', { turn: 1, step: 1 }, saturday);
  assistant(harness, { inputTokens: 120000, outputTokens: 8000 }, 'weekend', 'deepseek', 'deepseek-flash', saturday);
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, saturday);
  const state = (await harness.callGet()).body.state;
  assert.equal(state.pricing.lastTier, 'offpeak');
  // Off-peak: 120k input at ¥1/M + 8k output at ¥4/M = ¥0.12 + ¥0.032
  assert.ok(Math.abs(state.used.cost - 0.152) < 0.000001, `offpeak cost was ${state.used.cost}`);
  assert.ok(Math.abs(state.pricing.byTier.offpeak.cost - 0.152) < 0.000001);
}

// ── a retry/repeated settlement replaces, not adds ──────────────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'first attempt');
  assistant(harness, { inputTokens: 200000, outputTokens: 0 }, 'replacement attempt');
  const state = (await harness.callGet()).body.state;
  assert.ok(Math.abs(state.used.cost - 0.4) < 0.000001, `retry cost was ${state.used.cost}`);
  assert.equal(state.used.tokens, 200000);
  assert.equal(state.counters.replacedSettlements, 1, 'replacement is audited');
}

// ── unknown model: token counted, cost 0, visible warning ───────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'mystery', 'local', 'mystery-model');
  const state = (await harness.callGet()).body.state;
  assert.equal(state.used.cost, 0);
  assert.equal(state.pricing.unknownTokens, 100000);
  assert.equal(state.pricing.unknownModels['mystery-model'], 1);
  assert.ok(state.pricing.warnings.some((warning) => warning.includes('mystery-model')));
}

// ── no stated plan: observed burn only, never extrapolated ─────────────────
{
  const harness = makeHarness({ budgetAmount: 1, warnRatio: 0.8, interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'ordinary answer without a plan');
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const state = (await harness.callGet()).body.state;
  assert.equal(state.counters.planSteps, null);
  assert.equal(state.estimate.source, 'recent');
  assert.equal(state.estimate.remainingSteps, null, 'no plan means no guessed remaining steps');
  assert.equal(state.estimate.remainingCost, null, 'no plan means no predicted cost');
  assert.equal(state.estimate.remainingTokens, null, 'no plan means no predicted tokens');
  assert.equal(state.estimate.projectedCost, null);
  assert.equal(state.estimate.overBudget, false);
  assert.ok(state.estimate.recentAvgCost > 0, 'recent burn is observed history');
  assert.ok(state.estimate.recentAvgTokens > 0);
  assert.equal(state.estimate.recentUnit, 'turn');
  assert.match(state.estimate.text, /近期消耗/);
  assert.doesNotMatch(state.estimate.text, /预计还需/);
  assert.equal(state.warning, null, '20% used does not trigger a warning');
}

// ── reaching warnRatio is still a red warning (independent of estimates) ───
{
  const harness = makeHarness({ budgetAmount: 1, warnRatio: 0.8, interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 400000, outputTokens: 0 }, 'eighty percent');
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const state = (await harness.callGet()).body.state;
  assert.equal(state.estimate.source, 'recent');
  assert.equal(state.estimate.overBudget, false);
  assert.equal(state.warning.level, 'over', 'the real warnRatio warning stays red');
  assert.match(state.warning.text, /预算预警/);
}

// ── the estimate warns before the threshold, without hard-cancelling ────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  // ¥0.5 spent after one step; the stated 6-step plan projects ¥2.5 more.
  assistant(harness, { inputTokens: 240000, outputTokens: 2500 }, '计划共 6 步。');
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const snapshot = await harness.callGet();
  assert.equal(snapshot.body.state.estimate.overBudget, true);
  assert.equal(snapshot.body.state.warning.level, 'warn', 'projection is a yellow hint, not a red over-budget alert');
  assert.match(snapshot.body.state.warning.text, /按近期速度，可能会超出预算/);
  assert.equal(harness.cancels.length, 0, 'a projection warning never hard-cancels by itself');
}

// ── auto mode cancels at the threshold on turn-stopping ─────────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  // 450k input = ¥0.9, 6250 output = ¥0.05 → exactly 95%
  assistant(harness, { inputTokens: 450000, outputTokens: 6250 }, 'done');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'auto cancel fired');
  assert.equal(harness.cancels[0].cause.kind, 'hook');
  assert.equal(harness.cancels[0].options.keepInbox, true);
}

// ── manual mode does not cancel; it asks ────────────────────────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'manual', interceptRatio: 0.95, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 450000, outputTokens: 12500 }, 'done');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, 'manual mode never cancels by itself');
  const snapshot = await harness.callGet();
  assert.equal(snapshot.body.state.manual.pending, true);
  assert.ok(snapshot.body.state.manual.text.includes('是否继续'));
}

// ── pre-step hard guard rejects before another paid call ────────────────────
{
  const harness = makeHarness({ budgetAmount: 1, interceptMode: 'auto', interceptRatio: 0.5, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 300000, outputTokens: 1000 }, 'half way');
  const decision = await harness.preStep();
  assert.equal(decision.kind, 'reject');
  assert.equal(harness.cancels.length, 1);
}

// ── token-only budget and /budget override ─────────────────────────────────
{
  const harness = makeHarness({ tokenBudget: 10000, interceptMode: 'auto', interceptRatio: 0.9, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 9000, outputTokens: 1000 }, 'ten thousand tokens');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'token budget enforces independently of money');

  const command = harness.commands[0];
  const result = await command.handler({ agent: harness.agent, rawInput: '2.5', signal: new AbortController().signal });
  assert.equal(result.kind, 'success');
  assert.ok(result.text.includes('¥2.50'));
  const snapshot = await harness.callGet();
  assert.equal(snapshot.body.state.budget.amount, 2.5);

  const kResult = await command.handler({ agent: harness.agent, rawInput: '20k', signal: new AbortController().signal });
  assert.equal(kResult.kind, 'success');
  const kSnapshot = await harness.callGet();
  assert.equal(kSnapshot.body.state.budget.tokens, 20000);
  assert.ok(kResult.text.includes('20.0k tokens'));

  const prices = await command.handler({ agent: harness.agent, rawInput: 'prices', signal: new AbortController().signal });
  assert.equal(prices.kind, 'success');
  assert.ok(prices.text.includes('未定价模型'));

  // A logged command/run replays the same declaration after a Host restart.
  harness.emit('command/run', { commandId: 'cmd-1', name: 'budget', args: '1.5' });
  const replayed = await harness.callGet();
  assert.equal(replayed.body.state.budget.amount, 1.5);

  // command/run already applied the manual decision; the handler must not
  // count the same 继续 twice.
  harness.emit('command/run', { commandId: 'cmd-2', name: 'budget', args: 'continue' });
  await command.handler({ agent: harness.agent, rawInput: 'continue', commandId: 'cmd-2', signal: new AbortController().signal });
  const continued = await harness.callGet();
  assert.equal(continued.body.state.manual.continues, 1);
}

// ── P0-1: a 97-step session retries steps long after the trim window ───────
{
  const harness = makeHarness({ snapshotKeepTurns: 8, turnEstimateMinInterval: 0 });
  const emitUsage = (turn, step, inputTokens) =>
    harness.emit('assistant/message', {
      turn,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, totalTokens: inputTokens },
    });
  const stepsPerTurn = 10;
  const turns = 10;
  for (let turn = 1; turn <= turns; turn += 1) {
    harness.emit('turn/start', { turn });
    for (let step = 1; step <= stepsPerTurn; step += 1) {
      harness.emit('step/start', { turn, step });
      emitUsage(turn, step, 1000);
    }
    harness.emit('turn/end', { turn, reason: { kind: 'completed' } });
  }
  const filled = (await harness.callGet()).body.state;
  assert.equal(filled.counters.steps, 100);
  assert.equal(filled.counters.replacedSettlements, 0);
  const baselineTokens = filled.used.tokens;
  assert.equal(filled.counters.stepCharges, filled.counters.settledCharges, 'every step keeps a summary');
  // snapshotKeepTurns=8 of 10 turns means the first 20 steps are trimmed in the
  // next snapshot; the in-memory map still has them, so force the trim here.
  assert.ok(filled.counters.stepCharges >= 100);

  // Retry step 3 of turn 1: 9 turns of detail are outside the window.
  emitUsage(1, 3, 5000);
  const retried = (await harness.callGet()).body.state;
  assert.equal(retried.counters.blockedSettlements, 0, 'an old step is replaced, not refused');
  assert.equal(retried.counters.replacedSettlements, 1);
  assert.equal(retried.used.tokens, baselineTokens + 4000, 'the ledger moved 1000 -> 5000 tokens, no double count');
}

// ── P0-1: past perSessionMaxSettled the fallback is a visible refusal ─────
{
  const dir = join(process.cwd(), 'test', '.tmp-settled-marker');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const first = makeHarness({
      enableSnapshot: true,
      snapshotPath,
      perSessionMaxSettled: 2,
      snapshotKeepTurns: 1,
      turnEstimateMinInterval: 0,
    });
    const emitUsage = (turn, step, inputTokens) =>
      first.emit('assistant/message', {
        turn,
        step,
        message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
        stream: [],
        usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, totalTokens: inputTokens },
      });
    first.emit('turn/start', { turn: 1 });
    for (const step of [1, 2, 3]) {
      first.emit('step/start', { turn: 1, step });
      emitUsage(1, step, 1000);
    }
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    first.emit('turn/start', { turn: 2 });
    first.emit('step/start', { turn: 2, step: 1 });
    emitUsage(2, 1, 1000);
    first.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });

    const name = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const saved = JSON.parse(readFileSync(join(dir, name), 'utf8')).sessions['session-1'];
    const markers = saved.settledCharges.filter((entry) => entry[1] === null).map((entry) => entry[0]);
    const summaries = saved.settledCharges.filter((entry) => Array.isArray(entry[1])).map((entry) => entry[0]);
    // Over the summary cap the OLDEST records degrade to markers; the newest
    // stay rollbackable because a retry always targets a recent step.
    assert.deepEqual(markers, ['session-1:1:1', 'session-1:1:2'], 'oldest records degrade first');
    assert.deepEqual(summaries, ['session-1:1:3', 'session-1:2:1'], 'the newest steps stay replaceable');

    const second = makeHarness(
      {
        enableSnapshot: true,
        snapshotPath,
        perSessionMaxSettled: 2,
        snapshotKeepTurns: 1,
        turnEstimateMinInterval: 0,
      },
      Number(saved.lastSeq) || 0,
    );
    const before = (await second.callGet()).body.state;

    // Newest step: its detail is trimmed but the summary replaces it.
    second.emit('assistant/message', {
      turn: 2,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 5000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 5000 },
    });
    const replaced = (await second.callGet()).body.state;
    assert.equal(replaced.counters.blockedSettlements, 0);
    assert.equal(replaced.counters.replacedSettlements, 1);
    assert.equal(replaced.used.tokens, before.used.tokens + 4000, '1000 -> 5000 tokens, replaced not added');

    // Demoted (marker-only) step: refusing keeps the ledger honest.
    second.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 9000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 9000 },
    });
    const refused = (await second.callGet()).body.state;
    assert.equal(refused.counters.blockedSettlements, 1);
    assert.equal(refused.used.tokens, replaced.used.tokens, 'a refused settlement changes nothing');
    assert.ok(refused.pricing.warnings.some((warning) => warning.includes('明细已超过保留上限')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0-1: the snapshot keeps settledCharges bounded (2 × cap) ─────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-settled-cap');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, perSessionMaxSettled: 3, turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    for (let step = 1; step <= 8; step += 1) {
      harness.emit('step/start', { turn: 1, step });
      assistant(harness, { inputTokens: 1000, outputTokens: 0 }, undefined, 'deepseek', 'deepseek-chat', undefined, step);
    }
    const name = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const saved = JSON.parse(readFileSync(join(dir, name), 'utf8')).sessions['session-1'];
    assert.ok(Array.isArray(saved.settledCharges));
    assert.ok(saved.settledCharges.length <= 6, `settledCharges bounded, got ${saved.settledCharges.length}`);
    assert.equal(saved.settledKeys, undefined, 'the old field is gone');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0-3: a peer that is not on this machine cannot change the budget ─────
{
  const harness = makeHarness({});
  const forged = await harness.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '192.168.1.9',
  );
  assert.equal(forged.status, 403, 'a LAN peer cannot forge its way past /config/save');
  const forgedAction = await harness.callPost(
    '/dsh-budget/action',
    { sessionId: 'session-1', action: 'abort' },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '192.168.1.9',
  );
  assert.equal(forgedAction.status, 403, '/action is guarded the same way');
  const loopback = await harness.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '::ffff:127.0.0.1',
  );
  assert.equal(loopback.status, 200, 'the local settings page still saves');
  // Reads stay available to a remote GUI; only mutations are local-only.
  const remoteRead = await harness.callGet(
    '/dsh-budget/state?sessionId=session-1',
    { host: '127.0.0.1:56675' },
    '192.168.1.9',
  );
  assert.equal(remoteRead.status, 200);

  const optedOut = makeHarness({ requireLocalControl: false });
  // Opting out lifts the peer requirement, but a remote peer still has to prove
  // same-origin with a real Origin — Sec-Fetch-Site alone is forgeable.
  const allowed = await optedOut.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
    '192.168.1.9',
  );
  assert.equal(allowed.status, 200, 'requireLocalControl=false plus a matching Origin is the documented opt-out');
  const headerOnly = await optedOut.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '192.168.1.9',
  );
  assert.equal(headerOnly.status, 403, 'a remote peer cannot ride Sec-Fetch-Site alone');
}

// ── P0-3: a non-loopback bind drops the header-only fallback ──────────────
{
  const harness = makeHarness({}, 0, { bindOrigin: 'http://0.0.0.0:3080' });
  const headerOnly = await harness.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '0.0.0.0:3080', 'sec-fetch-site': 'same-origin' },
  );
  assert.equal(headerOnly.status, 403, 'Sec-Fetch-Site is not a credential on a public bind');
  const exactOrigin = await harness.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '0.0.0.0:3080', origin: 'http://0.0.0.0:3080' },
  );
  assert.equal(exactOrigin.status, 200);
  assert.ok(harness.warnings.some((warning) => warning.includes('advertises 0.0.0.0')));
}

// ── P0-8: /budget off explains exactly which default line comes back ───────
{
  const cases = [
    [{ budgetAmount: 2 }, /默认金额 ¥2\.00/, /仍会按默认预算拦截/],
    [{ tokenBudget: 20000 }, /默认 Token 20\.0k tokens/, /仍会按默认预算拦截/],
    [{ budgetAmount: 2, tokenBudget: 20000 }, /默认金额 ¥2\.00 \/ 默认 Token 20\.0k tokens/, /仍会按默认预算拦截/],
    [{}, /已清除会话覆盖；当前没有默认预算，本会话不再拦截。/, null],
  ];
  for (const [config, expected, second] of cases) {
    const harness = makeHarness(config);
    const command = harness.commands.find((item) => item.name === 'budget');
    const result = await command.handler({ agent: harness.agent, rawInput: 'off', signal: new AbortController().signal });
    assert.equal(result.kind, 'success');
    assert.match(result.text, expected);
    if (second) assert.match(result.text, second);
  }
}

// ── P2: money() boundaries match what the UI prints ───────────────────────
{
  const boundaries = [
    [0, '¥0.00'],
    [0.00005, '<¥0.0001'],
    [0.0001, '¥0.0001'],
    [0.001, '¥0.0010'],
    [0.01, '¥0.010'],
    [0.1, '¥0.10'],
    [0.3, '¥0.30'],
  ];
  for (const [value, expected] of boundaries) {
    assert.equal(money(value, 'CNY'), expected, `money(${value})`);
  }
  assert.equal(money(1.5, 'RMB'), '¥1.50');
}

// ── P2: plan-step detection accepts of / / / ／ ───────────────────────────
{
  for (const [text, expected] of [
    ['Step 3 of 9', 9],
    ['Step 3/7', 7],
    ['Step 3／11', 11],
    ['计划：共 6 步', 6],
  ]) {
    const harness = makeHarness({ turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, text);
    const state = (await harness.callGet()).body.state;
    assert.equal(state.counters.planSteps, expected, `"${text}" -> ${expected}`);
  }
}

// ── P1: the shadow bound is the most expensive loaded model at its top tier ─
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  // Off-peak Saturday, an unpriced model: the bound must NOT use the cheap
  // off-peak tariff of the known models.
  assistant(
    harness,
    { inputTokens: 1000000, outputTokens: 0 },
    'unknown',
    'local',
    'mystery-model',
    Date.parse('2026-10-31T03:00:00+08:00'),
  );
  const state = (await harness.callGet()).body.state;
  // deepseek-flash peak input_miss is 2 CNY/M, the highest loaded miss price.
  assert.ok(state.used.shadowCost >= 2, `shadow uses the peak tariff, got ${state.used.shadowCost}`);
  assert.equal(state.used.cost, 0, 'known cost stays 0 for an unpriced model');
}

// ── P0-1 (r5): summary fields align with what applyCharge touches ─────────
{
  const dir = join(process.cwd(), 'test', '.tmp-summary-align');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const first = makeHarness({
      enableSnapshot: true,
      snapshotPath,
      snapshotKeepTurns: 1,
      turnEstimateMinInterval: 0,
    });
    const peak = Date.parse('2026-10-28T10:00:00+08:00');
    // NB: assistant() hardcodes turn 1; multi-turn cases emit inline.
    const emit = (turn, step, inputTokens, provider, model) =>
      first.emit('assistant/message', {
        turn,
        step,
        message: { role: 'assistant', source: { kind: 'model', provider, model }, content: [] },
        stream: [],
        usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, totalTokens: inputTokens },
      }, peak);
    first.emit('turn/start', { turn: 1 });
    first.emit('step/start', { turn: 1, step: 1 });
    emit(1, 1, 100000, 'local', 'mystery-model');
    first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
    first.emit('turn/start', { turn: 2 });
    first.emit('step/start', { turn: 2, step: 1 });
    emit(2, 1, 1000, 'deepseek', 'deepseek-chat');
    first.emit('turn/end', { turn: 2, reason: { kind: 'completed' } });

    const name = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const saved = JSON.parse(readFileSync(join(dir, name), 'utf8')).sessions['session-1'];
    const summary = saved.settledCharges.find((entry) => entry[0] === 'session-1:1:1')[1];
    // Field count is pinned: summarizeCharge's layout list must match it.
    assert.equal(summary.length, 14, 'summary carries exactly the documented 14 fields');
    assert.equal(summary[12], 'mystery-model');

    const second = makeHarness(
      { enableSnapshot: true, snapshotPath, snapshotKeepTurns: 1, turnEstimateMinInterval: 0 },
      Number(saved.lastSeq) || 0,
    );
    const before = (await second.callGet()).body.state;
    assert.ok(before.pricing.byModel['mystery-model'], 'the unknown model is billed before the retry');

    // The trimmed unknown-model step is retried as a KNOWN model with a
    // different size: every bucket must end up holding only the final value.
    second.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 2000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 2000 },
    });
    const after = (await second.callGet()).body.state;
    assert.equal(after.counters.blockedSettlements, 0);
    assert.equal(after.counters.replacedSettlements, 1);
    assert.equal(after.pricing.byModel['mystery-model'], undefined, 'the replaced model bucket is deleted');
    assert.equal(after.pricing.byModel['deepseek-chat'].calls, 2, 'two known charges, no phantom call');
    assert.equal(after.pricing.unknownTokens, 0, 'unknown tokens rolled back too');
    assert.equal(after.used.percent !== undefined, true);
    // Both charges are peak, so byTier.tokens is exactly their sum.
    assert.equal(after.pricing.byTier.peak.tokens, 1000 + 2000);
    assert.equal(after.pricing.byTier.offpeak.tokens, 0);
    assert.equal(after.pricing.byModel['deepseek-chat'].peakTokens, 3000);
    assert.equal(after.pricing.byModel['deepseek-chat'].offpeakTokens, 0);
    // Σ breakdown == top-level cost (no residue in the split).
    const breakdown = after.used.breakdown;
    const sum = breakdown.inputMiss + breakdown.inputHit + breakdown.output;
    assert.ok(Math.abs(sum - after.used.cost) < 1e-9, `breakdown ${sum} == cost ${after.used.cost}`);
    assert.equal(after.used.tokens, 1000 + 2000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0 (r5→r6): the disk's record wins; a merge never re-adds money ────────
{
  const dir = join(process.cwd(), 'test', '.tmp-merge-settled');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    // 5000 tokens here vs 0.002 (1000 tokens) on the disk: the amounts differ on purpose.
    assistant(harness, { inputTokens: 5000, outputTokens: 0 }, 'local', 'deepseek', 'deepseek-chat', undefined, 1);
    const instanceName = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const instancePath = join(dir, instanceName);

    // A newer disk snapshot already billed step 1 at a DIFFERENT amount and
    // kept only the summary (its stepCharges detail was trimmed away).
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now() + 1000,
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 0.002,
          lastSeq: 99,
          settledSeqWatermark: 99,
          totalTokens: 1000,
          byModel: { 'deepseek-chat': { cost: 0.002, tokens: 1000, peakCost: 0.002, offpeakCost: 0, peakTokens: 1000, offpeakTokens: 0, calls: 1 } },
          byTier: { peak: { cost: 0.002, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.002, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
          stepCharges: [],
          settledCharges: [['session-1:1:1', [1, 0, 0.002, 0, 1000, 1000, 1000, 0, 0, 0.002, 0, 0, 'deepseek-chat', 3]]],
        },
      },
    }));
    // A second settlement triggers a write, which merges with the disk state.
    harness.emit('step/start', { turn: 1, step: 2 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'later', 'deepseek', 'deepseek-chat', undefined, 2);
    const saved = JSON.parse(readFileSync(instancePath, 'utf8')).sessions['session-1'];
    assert.equal(saved.cost, 0.002, 'step 1 and step 2 are already inside the disk totals');
    assert.equal(saved.stepCharges.length, 0);
    // step 1 is known to the disk; step 2 is not, so it survives as a marker.
    assert.equal(saved.settledCharges.find((entry) => entry[0] === 'session-1:1:2')[1], null);
    assert.ok(harness.warnings.some((warning) => warning.includes('dropped 1 already-known key(s)')));
    assert.ok(harness.warnings.some((warning) => warning.includes('kept 1 marker(s) without money')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P1-1 (r5): eviction is bounded, visible, and keeps the newest window ──
{
  const harness = makeHarness({ perSessionMaxSettled: 2, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  for (let step = 1; step <= 8; step += 1) {
    harness.emit('step/start', { turn: 1, step });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, undefined, 'deepseek', 'deepseek-chat', undefined, step);
  }
  const filled = (await harness.callGet()).body.state;
  assert.ok(filled.counters.settledCharges <= 4, `hard cap 2×cap applies, got ${filled.counters.settledCharges}`);
  assert.equal(filled.counters.settledOverflow, true);
  assert.ok(filled.counters.settledEvicted >= 1, 'evictions are counted');
  assert.ok(filled.pricing.warnings.some((warning) => warning.includes('开始丢弃最早的记录')));

  // A retry of a still-remembered recent step replaces instead of adding.
  const before = filled.used.tokens;
  harness.emit('assistant/message', {
    turn: 1,
    step: 8,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
    stream: [],
    usage: { inputTokens: 7000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 7000 },
  });
  const after = (await harness.callGet()).body.state;
  assert.equal(after.counters.blockedSettlements, 0);
  assert.equal(after.used.tokens, before + 6000, 'newest step is replaced, never double-billed');
}

// ── P1-3 (r5): invalid timestamps are a bounded counter, not a list ───────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  for (let step = 1; step <= 100; step += 1) {
    harness.emit('step/start', { turn: 1, step });
    harness.emit('assistant/message', {
      turn: 1,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1000 },
    }, 'not-a-timestamp');
  }
  const state = (await harness.callGet()).body.state;
  assert.equal(state.counters.invalidTimeMessages, 100, 'every skip is counted');
  assert.equal(typeof state.counters.invalidTimeMessages, 'number', 'the counter is O(1), not a list');
  assert.equal(state.used.tokens, 0, 'nothing was billed');
  assert.equal(state.pricing.invalidTimeMessages, 100);
}

// ── P1-2 (r5): /action has its own loopback switch, independent of config ─
{
  const configOnly = makeHarness({ requireLocalControl: false, requireLocalAction: true });
  const denied = await configOnly.callPost(
    '/dsh-budget/action',
    { sessionId: 'session-1', action: 'abort' },
    { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
    '192.168.1.9',
  );
  assert.equal(denied.status, 403, '/action stays local unless explicitly opened');
  const saveAllowed = await configOnly.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
    '192.168.1.9',
  );
  assert.equal(saveAllowed.status, 200, 'the two switches are independent');

  const actionOpen = makeHarness({ requireLocalAction: false });
  const allowed = await actionOpen.callPost(
    '/dsh-budget/action',
    { sessionId: 'session-1', action: 'continue' },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '192.168.1.9',
  );
  assert.equal(allowed.status, 200, 'remote manual continue/abort works when the owner opens it');
  const stillGuarded = await actionOpen.callPost(
    '/dsh-budget/config/save',
    { budgetAmount: 1 },
    { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
    '192.168.1.9',
  );
  assert.equal(stillGuarded.status, 403);
}

// ── P2-1 (r8): a 15-field summary still refuses a retry (no double bill) ──
{
  const dir = join(process.cwd(), 'test', '.tmp-short-summary');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 0.2,
          lastSeq: 5,
          totalTokens: 100000,
          byModel: { 'deepseek-chat': { cost: 0.2, tokens: 100000, peakCost: 0.2, offpeakCost: 0, peakTokens: 100000, offpeakTokens: 0, calls: 1 } },
          byTier: { peak: { cost: 0.2, tokens: 100000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.2, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
          stepCharges: [],
          // 13 fields: the layout written before `seq` existed.
          settledCharges: [['session-1:1:1', [1, 0, 0.2, 0, 100000, 100000, 100000, 0, 0, 0.2, 0, 0, 'deepseek-chat']]],
        },
      },
    }));
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 }, 5);
    const before = (await harness.callGet()).body.state;
    assert.equal(before.used.cost, 0.2);
    harness.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 3000 },
    });
    const after = (await harness.callGet()).body.state;
    assert.equal(after.counters.blockedSettlements, 1, 'a short summary is refused, not re-billed');
    assert.equal(after.used.cost, 0.2, 'the ledger stays at the old value');
    assert.equal(after.used.tokens, 100000);
    assert.ok(after.pricing.warnings.some((warning) => warning.includes('摘要格式无法回滚')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P2-2 (r8): settledCharges keeps insertion order across a round trip ───
{
  const config = { snapshotKeepTurns: 8, perSessionMaxSettled: 2000 };
  const keys = ['s:1:1', 's:1:2', 's:1:3', 's:1:4', 's:1:5'];
  const state = stateFromSnapshot({
    sessionId: 's',
    lastSeq: 9,
    stepCharges: [],
    settledCharges: keys.map((key) => [key, [1, 0, 0.001, 0, 10, 10, 10, 0, 0, 0.001, 0, 0, 'deepseek-chat', 1]]),
  }, 0);
  const encoded = serializableState(state, config);
  assert.deepEqual(encoded.settledCharges.map((entry) => entry[0]), keys, 'serialized order == settlement order');
  const reloaded = stateFromSnapshot(encoded, Date.now());
  assert.deepEqual([...reloaded.settledCharges.keys()], keys, 'a reloaded Map keeps that order');
  assert.equal(reloaded.settledSummaries, 5, 'the summary counter survives a reload');
}

// ── P1-3 (r8): equal lastSeq reports disk detail this write drops ─────────
{
  const dir = join(process.cwd(), 'test', '.tmp-equal-detail');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'one', 'deepseek', 'deepseek-chat', undefined, 1);
    const instanceName = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const instancePath = join(dir, instanceName);
    const localCost = JSON.parse(readFileSync(instancePath, 'utf8')).sessions['session-1'].cost;
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now() + 1000,
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 0.002,
          lastSeq: 4,
          settledSeqWatermark: 4,
          totalTokens: 1000,
          byModel: {},
          byTier: { peak: { cost: 0.002, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.002, inputHit: 0, output: 0 },
          unknownTokens: 0,
          unknownModels: {},
          priceWarnings: [],
          // Detail this instance never saw, at the same log position.
          stepCharges: [['session-1:9:9', { cost: 0.5, tokens: 5, model: 'deepseek-chat', tier: 'peak', seq: 4, breakdown: { inputMiss: 0.5, inputHit: 0, output: 0 } }]],
          settledCharges: [],
        },
      },
    }));
    harness.emit('command/run', { commandId: 'c1', name: 'budget', args: '2' });
    assert.ok(
      harness.warnings.some((warning) => warning.includes('snapshot detail dropped')),
      'the trade-off is recorded, not silent',
    );
    assert.ok(harness.warnings.some((warning) => warning.includes('1 disk-side step(s)')));
    const saved = JSON.parse(readFileSync(instancePath, 'utf8')).sessions['session-1'];
    assert.equal(saved.cost, localCost, 'this instance stays the writer, so its own total is written');
    assert.equal(saved.stepCharges.length, 1, 'its own detail is kept');
    assert.equal(saved.stepCharges[0][0], 'session-1:1:1', 'the disk-only step 9:9 is not carried over');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P1-1 (r9): every malformed summary refuses instead of throwing ────────
{
  const good = [1, 0, 0.2, 0, 100000, 100000, 100000, 0, 0, 0.2, 0, 0, 'deepseek-chat', 5];
  const cases = [
    ['13 fields', good.slice(0, 13)],
    ['15 fields', [...good, 99]],
    ['not an array', 'nope'],
    ['null element', good.map((value, index) => (index === 4 ? null : value))],
    ['model is not a string', good.map((value, index) => (index === 12 ? { name: 'x' } : value))],
    ['cost is not a finite number', good.map((value, index) => (index === 2 ? Number.NaN : value))],
  ];
  for (const [label, summary] of cases) {
    const dir = join(process.cwd(), `test/.tmp-bad-summary-${label.replace(/[^a-z]+/gi, '-')}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const snapshotPath = join(dir, 'snapshots.json');
    try {
      writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        sessions: {
          'session-1': {
            sessionId: 'session-1',
            cost: 0.2,
            lastSeq: 5,
            totalTokens: 100000,
            byModel: {}, byTier: { peak: { cost: 0.2, tokens: 100000 }, offpeak: { cost: 0, tokens: 0 } },
            costBreakdown: { inputMiss: 0.2, inputHit: 0, output: 0 },
            unknownTokens: 0, unknownModels: {}, priceWarnings: [],
            stepCharges: [],
            settledCharges: [['session-1:1:1', summary]],
          },
        },
      }));
      const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 }, 5);
      await harness.callGet();
      assert.doesNotThrow(() => {
        harness.emit('assistant/message', {
          turn: 1,
          step: 1,
          message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
          stream: [],
          usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 3000 },
        });
      }, `${label}: applyUsage must not throw`);
      const state = (await harness.callGet()).body.state;
      assert.equal(state.counters.blockedSettlements, 1, `${label}: refused`);
      assert.equal(state.used.cost, 0.2, `${label}: ledger unchanged`);
      assert.equal(state.used.tokens, 100000, `${label}: tokens unchanged`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── P1-2/P2-4 (r9): summary counter and in-place demotion stay consistent ──
{
  const harness = makeHarness({ perSessionMaxSettled: 2, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  for (let step = 1; step <= 10; step += 1) {
    harness.emit('step/start', { turn: 1, step });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, undefined, 'deepseek', 'deepseek-chat', undefined, step);
  }
  const harnessSnapshot = harness;
  // Read the private map through a snapshot write, which is what persists it.
  const dir = join(process.cwd(), 'test', '.tmp-counter');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const exposed = makeHarness({
      enableSnapshot: true,
      snapshotPath: join(dir, 'snapshots.json'),
      perSessionMaxSettled: 2,
      turnEstimateMinInterval: 0,
    });
    exposed.emit('turn/start', { turn: 1 });
    for (let step = 1; step <= 10; step += 1) {
      exposed.emit('step/start', { turn: 1, step });
      assistant(exposed, { inputTokens: 1000, outputTokens: 0 }, undefined, 'deepseek', 'deepseek-chat', undefined, step);
    }
    const name = readdirSync(dir).find((item) => item !== 'snapshots.json' && item.endsWith('.json'));
    const saved = JSON.parse(readFileSync(join(dir, name), 'utf8')).sessions['session-1'];
    const summaries = saved.settledCharges.filter((entry) => entry[1] !== null);
    assert.ok(saved.settledCharges.length <= 4, `hard cap respected, got ${saved.settledCharges.length}`);
    assert.ok(summaries.length <= 2, `summary cap respected, got ${summaries.length}`);
    // Demotion is in place: the leading entries are the markers, the tail keeps
    // the summaries, and the order is still settlement order.
    const order = saved.settledCharges.map((entry) => entry[0]);
    assert.deepEqual(order, [...order].sort((a, b) => Number(a.split(':')[2]) - Number(b.split(':')[2])));
    const firstSummaryIndex = saved.settledCharges.findIndex((entry) => entry[1] !== null);
    assert.ok(firstSummaryIndex >= 0, 'some summary survives');
    assert.ok(
      saved.settledCharges.slice(0, firstSummaryIndex).every((entry) => entry[1] === null),
      'markers form a prefix, so "oldest first" still holds',
    );
    const state = (await exposed.callGet()).body.state;
    assert.equal(state.counters.settledCharges, saved.settledCharges.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const inMemory = (await harnessSnapshot.callGet()).body.state;
  assert.ok(inMemory.counters.settledCharges <= 4);
}

// ── P1-3 (r9): the watermark never regresses, even when everything evicts ──
{
  const harness = makeHarness({ perSessionMaxSettled: 1, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  const seqs = [];
  for (const step of [1, 2, 3]) {
    harness.emit('step/start', { turn: 1, step });
    const event = harness.emit('assistant/message', {
      turn: 1,
      step,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 1000 },
    });
    seqs.push(event.seq);
  }
  const state = (await harness.callGet()).body.state;
  assert.equal(state.counters.settledSeqWatermark, seqs[seqs.length - 1], 'watermark tracks the newest settlement');
  assert.ok(state.counters.settledEvicted >= 1, 'eviction happened');
  assert.ok(state.counters.settledSeqWatermark > state.counters.lastSeq - 3, 'watermark did not collapse with eviction');
}

// ── P1-4 (r9): a repeated merge warn is reported once, not per flush ──────
{
  const dir = join(process.cwd(), 'test', '.tmp-warn-spam');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 });
    harness.emit('turn/start', { turn: 1 });
    harness.emit('step/start', { turn: 1, step: 1 });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'one', 'deepseek', 'deepseek-chat', undefined, 1);
    // A peer that is permanently far ahead: every flush merges from now on.
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now() + 600000,
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 0.5,
          lastSeq: 9999,
          settledSeqWatermark: 9999,
          totalTokens: 1000,
          byModel: {}, byTier: { peak: { cost: 0.5, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.5, inputHit: 0, output: 0 },
          unknownTokens: 0, unknownModels: {}, priceWarnings: [],
          stepCharges: [], settledCharges: [],
        },
      },
    }));
    for (let step = 2; step <= 6; step += 1) {
      harness.emit('step/start', { turn: 1, step });
      assistant(harness, { inputTokens: 1000, outputTokens: 0 }, `m${step}`, 'deepseek', 'deepseek-chat', undefined, step);
    }
    const mergeWarns = harness.warnings.filter((warning) => warning.includes('snapshot merge for'));
    assert.ok(mergeWarns.length >= 1, 'the first merge is reported');
    assert.ok(mergeWarns.length <= 2, `identical merges are throttled, got ${mergeWarns.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P2-1 (r9): /budget reset-snapshot rebuilds from the log ────────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-reset-snapshot');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 9,
          lastSeq: 5,
          totalTokens: 1000,
          byModel: {}, byTier: { peak: { cost: 9, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 9, inputHit: 0, output: 0 },
          unknownTokens: 0, unknownModels: {}, priceWarnings: [],
          stepCharges: [],
          settledCharges: [['session-1:1:1', [1, 0, 9, 0, 1000, 1000, 1000, 0, 0, 9, 0, 0, 'deepseek-chat']]],
        },
      },
    }));
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 }, 5);
    const before = (await harness.callGet()).body.state;
    assert.equal(before.used.cost, 9, 'the bad snapshot is being used');
    const command = harness.commands.find((item) => item.name === 'budget');
    const result = await command.handler({
      agent: harness.agent,
      rawInput: 'reset-snapshot',
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /重新计费/);
    const after = (await harness.callGet()).body.state;
    assert.equal(after.used.cost, 0, 'the ledger was rebuilt from the log');
    assert.equal(after.stale, false);
    assert.equal(after.counters.blockedSettlements, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P0-3 (r10): every loopback spelling is accepted, others are not ───────
{
  const harness = makeHarness({});
  for (const address of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '[::1]']) {
    const saved = await harness.callPost(
      '/dsh-budget/config/save',
      { budgetAmount: 1 },
      { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
      address,
    );
    assert.equal(saved.status, 200, `${address} is a loopback peer`);
  }
  for (const address of ['192.168.1.9', '10.0.0.1', '::ffff:0a00:0001', '0.0.0.0']) {
    const denied = await harness.callPost(
      '/dsh-budget/config/save',
      { budgetAmount: 1 },
      { host: '127.0.0.1:56675', 'sec-fetch-site': 'same-origin' },
      address,
    );
    assert.equal(denied.status, 403, `${address} is not loopback`);
  }
  // The refusal is diagnosable: /config reports the peer the server actually saw.
  const config = await harness.callGet('/dsh-budget/config');
  const reject = config.body.config.server.lastReject;
  assert.equal(reject.reason, 'not-loopback');
  assert.equal(reject.remote, '0.0.0.0');
  assert.equal(reject.host, '127.0.0.1:56675');
  assert.equal(reject.secFetchSite, 'same-origin');
}

// ── P1-4 (r10): every settledSummaries maintenance path is covered ────────
{
  // eviction: cap=1 => one summary survives, hard cap is two entries
  const harness = makeHarness({ perSessionMaxSettled: 1, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  for (let step = 1; step <= 5; step += 1) {
    harness.emit('step/start', { turn: 1, step });
    assistant(harness, { inputTokens: 1000, outputTokens: 0 }, undefined, 'deepseek', 'deepseek-chat', undefined, step);
  }
  const direct = await harness.callGet();
  assert.ok(direct.body.state.counters.settledEvicted >= 1, 'eviction happened');
  assert.ok(direct.body.state.counters.settledCharges <= 2, 'hard cap = 2 entries');
  // reload: read back counts the summaries anew
  const state = stateFromSnapshot({
    sessionId: 's',
    lastSeq: 9,
    stepCharges: [],
    settledCharges: [
      ['s:1:1', [1, 0, 0.001, 0, 10, 10, 10, 0, 0, 0.001, 0, 0, 'deepseek-chat', 1]],
      ['s:1:2', [1, 0, 0.001, 0, 10, 10, 10, 0, 0, 0.001, 0, 0, 'deepseek-chat', 2]],
      ['s:1:3', null],
    ],
  }, 0);
  assert.equal(state.settledSummaries, 2, 'two summaries and one marker');
}

// ── P1-1/P1-2 (r10): 0.3.0-era summaries roll back, junk is refused ────────
{
  // The exact shape this version writes: numeric tier/unknown, fourteen fields.
  const legacy = [1, 0, 0.2, 0, 100000, 100000, 100000, 0, 0, 0.2, 0, 0, 'deepseek-chat', 5];
  const writeSnapshot = (dir, summary) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now(),
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 0.2,
          lastSeq: 5,
          totalTokens: 100000,
          byModel: {}, byTier: { peak: { cost: 0.2, tokens: 100000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 0.2, inputHit: 0, output: 0 },
          unknownTokens: 0, unknownModels: {}, priceWarnings: [],
          stepCharges: [],
          settledCharges: [['session-1:1:1', summary]],
        },
      },
    }));
  };
  const retry = async (dir) => {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath: join(dir, 'snapshots.json'), turnEstimateMinInterval: 0 }, 5);
    await harness.callGet();
    harness.emit('assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
      stream: [],
      usage: { inputTokens: 3000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 3000 },
    });
    return (await harness.callGet()).body.state;
  };

  const dirLegacy = join(process.cwd(), 'test', '.tmp-legacy16');
  rmSync(dirLegacy, { recursive: true, force: true });
  try {
    writeSnapshot(dirLegacy, legacy);
    const state = await retry(dirLegacy);
    assert.equal(state.counters.blockedSettlements, 0, 'a current-layout summary is rollbackable');
    assert.equal(state.counters.replacedSettlements, 1);
    assert.equal(state.used.tokens, 3000, 'the old 100k-token charge was replaced, not stacked');
  } finally {
    rmSync(dirLegacy, { recursive: true, force: true });
  }

  const junk = [
    ['tier2', legacy.map((value, index) => (index === 0 ? 2 : value))],
    ['tierNeg', legacy.map((value, index) => (index === 0 ? -1 : value))],
    ['tierString', legacy.map((value, index) => (index === 0 ? 'peak' : value))],
    ['unknown2', legacy.map((value, index) => (index === 1 ? 2 : value))],
    ['tokensNeg', legacy.map((value, index) => (index === 4 ? -1 : value))],
    ['costNeg', legacy.map((value, index) => (index === 2 ? -1 : value))],
    ['seqNaN', legacy.map((value, index) => (index === 13 ? Number.NaN : value))],
  ];
  for (const [label, summary] of junk) {
    const dir = join(process.cwd(), `test/.tmp-strict-${label}`);
    rmSync(dir, { recursive: true, force: true });
    try {
      writeSnapshot(dir, summary);
      const state = await retry(dir);
      assert.equal(state.counters.blockedSettlements, 1, `${label} refused`);
      assert.equal(state.used.cost, 0.2, `${label} ledger unchanged`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// ── P0-2 (r10): a replayed reset-snapshot does nothing ────────────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'one', 'deepseek', 'deepseek-chat', undefined, 1);
  const before = (await harness.callGet()).body.state;
  harness.emit('command/run', { commandId: 'r1', name: 'budget', args: 'reset-snapshot' });
  const after = (await harness.callGet()).body.state;
  assert.equal(after.used.cost, before.used.cost, 'replay must not wipe the ledger');
  assert.equal(after.counters.settledCharges, before.counters.settledCharges);
}

// ── P0-1 (r10): the reset tombstone beats another instance's stale cache ──
{
  const dir = join(process.cwd(), 'test', '.tmp-reset-tombstone');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  try {
    writeFileSync(join(dir, 'snapshots.111.111.json'), JSON.stringify({
      version: 2,
      savedAt: Date.now() - 60000,
      sessions: {
        'session-1': {
          sessionId: 'session-1',
          cost: 9,
          lastSeq: 5,
          totalTokens: 1000,
          byModel: {}, byTier: { peak: { cost: 9, tokens: 1000 }, offpeak: { cost: 0, tokens: 0 } },
          costBreakdown: { inputMiss: 9, inputHit: 0, output: 0 },
          unknownTokens: 0, unknownModels: {}, priceWarnings: [],
          stepCharges: [], settledCharges: [],
        },
      },
    }));
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 }, 5);
    assert.equal((await harness.callGet()).body.state.used.cost, 9, 'the stale cache is in use');
    const command = harness.commands.find((item) => item.name === 'budget');
    await command.handler({ agent: harness.agent, rawInput: 'reset-snapshot', signal: new AbortController().signal });
    let winner = null;
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const decoded = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      const entry = decoded.sessions && decoded.sessions['session-1'];
      if (!entry) continue;
      if (!winner || decoded.savedAt >= winner.savedAt) winner = { savedAt: decoded.savedAt, entry };
    }
    assert.ok(winner, 'a snapshot entry exists after the reset');
    assert.equal(winner.entry.cost, 0, 'the newest entry is the reset tombstone');
    const reloaded = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 }, 5);
    assert.equal((await reloaded.callGet()).body.state.used.cost, 0, 'the stale cache did not resurrect');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── P1-5 (r10): reset keeps the user's manual decisions ───────────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 1000, outputTokens: 0 }, 'one', 'deepseek', 'deepseek-chat', undefined, 1);
  await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'suppress' });
  const suppressed = (await harness.callGet()).body.state;
  assert.equal(suppressed.manual.suppressed, true);
  const beforeReset = suppressed.used.cost;
  const command = harness.commands.find((item) => item.name === 'budget');
  await command.handler({ agent: harness.agent, rawInput: 'reset-snapshot', signal: new AbortController().signal });
  const after = (await harness.callGet()).body.state;
  assert.equal(after.manual.suppressed, true, 'reset does not undo "不再提示"');
  // The log still contains the charge, so a rebuild lands on the same number:
  // reset drops *cache* error, not log-derived truth.
  assert.equal(after.used.cost, beforeReset, 'the rebuilt ledger matches the log');
  assert.equal(after.stale, false);
}

// ── zero budget never intercepts (no budget was ever set) ─────────────────
{
  // Even at absurd spend, an unset budget must not cancel, reject or prompt.
  const harness = makeHarness({ budgetAmount: 0, tokenBudget: 0, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 900000, outputTokens: 200000 }, 'spend a lot');
  await harness.turnStopping();
  const decision = await harness.preStep();
  assert.equal(harness.cancels.length, 0, 'no cancel without a budget');
  assert.equal(decision.kind, 'enter', 'no pre-step rejection without a budget');
  const state = (await harness.callGet()).body.state;
  assert.equal(state.configured, false);
  assert.equal(state.budget.label, '未设置预算');
  assert.equal(state.overBudget, false, 'all-zero budget cannot be over budget');
  assert.ok(!state.estimate || state.estimate.overBudget === false);
  assert.equal(state.warning, null, 'all-zero budget produces no warning');
  assert.equal(state.manual.pending, false);
  assert.equal(state.manual.canContinue, false, 'no manual continue button without a budget');
  assert.equal(state.guard.stopped, false);
  assert.ok(state.used.cost > 0, 'cost is still recorded');

  // After the turn closes, the estimate card must not fake a 0% budget
  // progress: there is no line, so it says so and keeps reporting burn.
  harness.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const withEstimate = (await harness.callGet()).body.state;
  assert.ok(withEstimate.estimate, 'the estimate still exists with no budget');
  assert.match(withEstimate.estimate.text, /未设置预算/);
  assert.doesNotMatch(withEstimate.estimate.text, /预算已用约/, 'no fake 0% budget progress');
  assert.equal(withEstimate.estimate.overBudget, false);
  assert.equal(withEstimate.warning, null);
  assert.equal(withEstimate.configured, false);
}

// ── all-zero budget in manual mode never prompts either ───────────────────
{
  const harness = makeHarness({
    budgetAmount: 0,
    tokenBudget: 0,
    interceptMode: 'manual',
    turnEstimateMinInterval: 0,
  });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 900000, outputTokens: 200000 }, 'manual but unset');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, 'manual mode has nothing to stop for');
  assert.equal((await harness.preStep()).kind, 'enter');
  const state = (await harness.callGet()).body.state;
  assert.equal(state.configured, false);
  assert.equal(state.manual.pending, false, 'no manual prompt without a budget');
  assert.equal(state.manual.canContinue, false);
  assert.equal(state.manual.text, null);
  assert.equal(state.warning, null);
  assert.equal(state.overBudget, false);
}

// ── amount 0 does not interfere with a token-only budget ──────────────────
{
  const harness = makeHarness({ budgetAmount: 0, tokenBudget: 10000, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 9000, outputTokens: 0 }, 'nine thousand');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, '9000 < 95% of a 10000 token budget');
  assert.equal((await harness.preStep()).kind, 'enter');
  let state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0);
  assert.equal(state.budget.tokens, 10000);
  assert.equal(state.configured, true, 'the token line still exists');
  assert.equal(state.overBudget, false);

  harness.emit('step/start', { turn: 1, step: 2 });
  assistant(harness, { inputTokens: 2000, outputTokens: 0 }, 'eleven thousand', 'deepseek', 'deepseek-chat', undefined, 2);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, '11000 > 95% of a 10000 token budget');
  state = (await harness.callGet()).body.state;
  assert.equal(state.overBudget, true);
}

// ── token 0 does not interfere with an amount-only budget ─────────────────
{
  const harness = makeHarness({ budgetAmount: 1, tokenBudget: 0, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  // peak deepseek-flash: 250k miss = ¥0.5
  assistant(harness, { inputTokens: 250000, outputTokens: 0 }, 'half a yuan');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, '¥0.5 < 95% of ¥1');
  assert.equal((await harness.preStep()).kind, 'enter');
  let state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 1);
  assert.equal(state.budget.tokens, 0);
  assert.equal(state.configured, true);
  assert.equal(state.overBudget, false);

  harness.emit('step/start', { turn: 1, step: 2 });
  // +300k = ¥0.6, total ¥1.1
  assistant(harness, { inputTokens: 300000, outputTokens: 0 }, 'over a yuan', 'deepseek', 'deepseek-chat', undefined, 2);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, '¥1.1 > 95% of ¥1');
  state = (await harness.callGet()).body.state;
  assert.equal(state.overBudget, true);
}

// ── a budget stop can always be lifted from the UI (auto mode too) ────────
{
  const harness = makeHarness({ budgetAmount: 0.01, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  assistant(harness, { inputTokens: 100000, outputTokens: 0 }, 'overspend');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'auto stops at the threshold');
  const stopped = (await harness.callGet()).body.state;
  assert.equal(stopped.guard.stopped, true, 'the UI is told a stop happened');
  assert.equal(stopped.guard.lastStopKind, 'auto');
  assert.equal(stopped.guard.canUnlock, true);

  // Resume: grants 10% and clears the banner so work can continue.
  const resumed = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'resume' });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.ok, true);
  const afterResume = (await harness.callGet()).body.state;
  assert.equal(afterResume.guard.stopped, false, 'resume clears the stop banner');
  assert.equal(afterResume.manual.continues, 1);
  assert.equal(harness.cancels.length, 1, 'resume does not cancel anything');

  // Second stop (still over budget), then unlock: enforcement must go quiet.
  // NB: assistant() hardcodes turn 1, so emit inline for a new turn.
  harness.emit('turn/start', { turn: 2 });
  harness.emit('step/start', { turn: 2, step: 1 });
  harness.emit('assistant/message', {
    turn: 2,
    step: 1,
    message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' }, content: [] },
    stream: [],
    usage: { inputTokens: 100000, outputTokens: 0, cacheReadTokens: 0, totalTokens: 100000 },
  });
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 2, 'over the new line it stops again');
  const unlocked = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'unlock' });
  assert.equal(unlocked.status, 200);
  const lifted = (await harness.callGet()).body.state;
  assert.equal(lifted.guard.disabled, true);
  assert.equal(lifted.guard.stopped, false);
  assert.match(lifted.warning ? lifted.warning.text : '', /解除|/);

  await harness.turnStopping();
  const decision = await harness.preStep();
  assert.equal(harness.cancels.length, 2, 'unlock stops all further cancels');
  assert.equal(decision.kind, 'enter', 'unlock also disables the pre-step guard');

  // /budget lock restores enforcement, and setting a budget does too.
  const command = harness.commands.find((item) => item.name === 'budget');
  await command.handler({ agent: harness.agent, rawInput: 'lock', signal: new AbortController().signal });
  assert.equal((await harness.callGet()).body.state.guard.disabled, false);
  harness.emit('command/run', { commandId: 'b1', name: 'budget', args: 'unlock' });
  assert.equal((await harness.callGet()).body.state.guard.disabled, true, 'unlock replays from the log');
  harness.emit('command/run', { commandId: 'b2', name: 'budget', args: '0.02' });
  assert.equal((await harness.callGet()).body.state.guard.disabled, false, 'setting a budget re-arms the guard');
}

// ── model price settings: merged read, hot-reloaded save, custom removal ───
{
  const dir = join(process.cwd(), 'test', '.tmp-prices');
  rmSync(dir, { recursive: true, force: true });
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = dir;
  try {
    const localPriceFile = join(dir, 'budget-guard', 'local-prices.json');
    const harness = makeHarness({ turnEstimateMinInterval: 0 });

    // GET merges every layer and says where a save will land.
    const initial = await harness.callGet('/dsh-budget/prices');
    assert.equal(initial.status, 200);
    const prices = initial.body.prices;
    assert.equal(prices.unit, 'CNY / 1M tokens');
    assert.equal(prices.offpeakFactor, 0.5);
    assert.equal(prices.localPath, localPriceFile);
    assert.ok(prices.sources.includes('official-prices.json'));
    const flash = prices.models.find((item) => item.model === 'deepseek-flash');
    assert.deepEqual(flash.peak, { input_miss: 2, input_hit: 0.04, output: 8 });
    assert.deepEqual(flash.offpeak, { input_miss: 1, input_hit: 0.02, output: 4 });
    assert.equal(flash.origin, 'official');
    assert.equal(flash.custom, false);

    // A save writes ONLY $DSH_HOME/budget-guard/local-prices.json.
    const saved = await harness.callPost('/dsh-budget/prices/save', {
      models: {
        'deepseek-flash': { peak: { output: 9 } },
        'gpt-4o-local': {
          peak: { input_miss: 3, input_hit: 0.3, output: 12 },
          offpeak: { input_miss: 1.5, input_hit: 0.15, output: 6 },
        },
        // Peak only: the offpeak tier must be inferred at 50%, never 0.
        'peak-only-local': { peak: { input_miss: 4, input_hit: 0.4, output: 8 } },
      },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.applied, true);
    assert.ok(existsSync(localPriceFile), 'the price file lands under DSH_HOME');
    assert.equal(
      existsSync(join(process.cwd(), 'prices', 'local-prices.json')),
      false,
      'the packaged prices/ directory is never written',
    );
    const raw = readFileSync(localPriceFile, 'utf8');
    assert.ok(!raw.startsWith('\uFEFF'), 'no BOM (it would break JSON.parse on the next load)');
    const stored = JSON.parse(raw);
    assert.equal(stored.models['deepseek-flash'].peak.output, 9);
    assert.equal(
      stored.models['deepseek-flash'].peak.input_miss,
      undefined,
      'only the edited field is written; the rest keeps inheriting',
    );
    assert.deepEqual(stored.models['gpt-4o-local'].offpeak, { input_miss: 1.5, input_hit: 0.15, output: 6 });

    // Hot reload: the merged book in memory changed without a restart.
    const after = (await harness.callGet('/dsh-budget/prices')).body.prices;
    const flashAfter = after.models.find((item) => item.model === 'deepseek-flash');
    assert.equal(flashAfter.peak.output, 9);
    assert.equal(flashAfter.peak.input_miss, 2, 'unspecified fields still inherit');
    assert.equal(flashAfter.origin, 'local');
    assert.equal(flashAfter.custom, true);
    assert.ok(after.models.some((item) => item.model === 'gpt-4o-local'));
    const peakOnly = after.models.find((item) => item.model === 'peak-only-local');
    assert.deepEqual(peakOnly.peak, { input_miss: 4, input_hit: 0.4, output: 8 });
    assert.deepEqual(
      peakOnly.offpeak,
      { input_miss: 2, input_hit: 0.2, output: 4 },
      'a peak-only custom model keeps the documented 50% off-peak fallback',
    );
    assert.ok(after.sources.includes(localPriceFile));

    // And the next settlement bills with the new price: 1M output × ¥9.
    const peak = Date.parse('2026-10-28T10:00:00+08:00'); // Wednesday peak
    harness.emit('turn/start', { turn: 1 }, peak);
    harness.emit('step/start', { turn: 1, step: 1 }, peak);
    assistant(harness, { inputTokens: 0, outputTokens: 1000000 }, 'reprice', 'deepseek', 'deepseek-flash', peak);
    const billed = (await harness.callGet()).body.state;
    assert.ok(Math.abs(billed.used.cost - 9) < 1e-9, `the saved price is used for billing, cost=${billed.used.cost}`);

    // Removing a custom model restores the inherited price.
    const removed = await harness.callPost('/dsh-budget/prices/save', {
      models: {},
      remove: ['deepseek-flash', 'gpt-4o-local', 'peak-only-local'],
    });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    const restored = removed.body.prices.models.find((item) => item.model === 'deepseek-flash');
    assert.equal(restored.peak.output, 8);
    assert.equal(restored.origin, 'official');
    assert.ok(!removed.body.prices.models.some((item) => item.model === 'gpt-4o-local'));

    // A fresh instance reads the same file: the state is the file, not memory.
    const cold = (await makeHarness({ turnEstimateMinInterval: 0 }).callGet('/dsh-budget/prices')).body.prices;
    const coldFlash = cold.models.find((item) => item.model === 'deepseek-flash');
    assert.equal(coldFlash.peak.output, 8, 'a restart loads the saved table');
    assert.ok(!cold.models.some((item) => item.model === 'gpt-4o-local'));
    assert.ok(!cold.sources.includes(localPriceFile), 'an emptied table adds no source');

    // Validation: numbers only, with a field path in the issue.
    const bad = await harness.callPost('/dsh-budget/prices/save', {
      models: { 'gpt-4o-local': { peak: { output: '8' } } },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'invalid');
    assert.deepEqual(bad.body.issues[0].path, ['models', 'gpt-4o-local', 'peak', 'output']);
    const negative = await harness.callPost('/dsh-budget/prices/save', {
      models: { 'gpt-4o-local': { peak: { output: -1 } } },
    });
    assert.equal(negative.status, 400);
    const empty = await harness.callPost('/dsh-budget/prices/save', {});
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'invalid');

    // Same peer rule as /config/save: a remote browser may read, not write.
    const remoteRead = await harness.callGet('/dsh-budget/prices', { host: '127.0.0.1:56675' }, '10.0.0.9');
    assert.equal(remoteRead.status, 200, 'reads stay available to a remote GUI');
    const remoteWrite = await harness.callPost(
      '/dsh-budget/prices/save',
      { models: { 'gpt-4o-local': { peak: { output: 1 } } } },
      { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
      '10.0.0.9',
    );
    assert.equal(remoteWrite.status, 403);

    // The in-app hint points at the writable file, not the packaged example.
    const command = harness.commands.find((item) => item.name === 'budget');
    const report = await command.handler({
      agent: harness.agent,
      rawInput: 'prices',
      signal: new AbortController().signal,
    });
    assert.equal(report.kind, 'success');
    assert.ok(report.text.includes(localPriceFile), 'the hint names the settings-page file');
  } finally {
    process.env.DSH_HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
}

rmSync(TEST_DSH_HOME, { recursive: true, force: true });

console.log('host tests passed');
