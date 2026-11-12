/**
 * End-to-end regression suite for the user-facing paths in the prompt:
 * save from localhost/127.0.0.1, validation, interception/unlock/lock, billing,
 * commands, cold start and the recovery UI.
 *
 * The harness mirrors the Host surface used by `src/index.ts` (session events,
 * the four HTTP routes, the `/budget` command and the two agent hooks). It is
 * intentionally small: it exercises the same code paths as the live Host
 * without booting DSH.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { apply, name } from '../lib/index.js';
import { priceMessage } from '../lib/pricing.js';

// Model prices are read from `$DSH_HOME/budget-guard/local-prices.json`; point
// DSH_HOME at a scratch directory so the developer's own price table cannot
// change the amounts asserted below.
const TEST_DSH_HOME = join(process.cwd(), 'test', '.tmp-dsh-home-regression');
rmSync(TEST_DSH_HOME, { recursive: true, force: true });
mkdirSync(TEST_DSH_HOME, { recursive: true });
process.env.DSH_HOME = TEST_DSH_HOME;

function makeHarness(config = {}, startSeq = 0, options = {}) {
  const events = [];
  const handlers = new Map();
  const routes = new Map();
  const commands = [];
  const cancels = [];
  const warnings = [];
  const configEdits = [];
  const disposers = [];
  const sessions = new Map();
  const agents = new Map();
  const bindOrigin = 'bindOrigin' in options ? options.bindOrigin : 'http://127.0.0.1:56675';
  const configEntry = { id: 'include:budget-guard', options: { id: 'budget-guard' } };

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
    cancel(cause = {}) {
      cancels.push({ cause });
      this.status = 'idle';
    },
  };
  agents.set(agent.id, agent);

  const commandService = {
    register(definition) {
      commands.push(definition);
      return () => {};
    },
    async execute(_agent, line) {
      const definition = commands.find((item) => item.name === 'budget');
      const raw = String(line).replace(/^\/budget\b/i, '').trim();
      events.push({ type: 'command/run', seq: ++sequence, time: Date.now(), data: { commandId: 'action', name: 'budget', args: raw } });
      for (const listener of handlers.get('session/event') || []) listener(session, events.at(-1));
      if (definition) {
        await definition.handler({
          agent,
          rawInput: raw,
          commandId: 'action',
          signal: new AbortController().signal,
        });
      }
      return { commandId: 'action', result: { kind: 'success' } };
    },
  };

  let sequence = startSeq;
  const ctx = {
    logger: {
      warn: (...args) => warnings.push(args.join(' ')),
      info: () => {},
      error: () => {},
    },
    sessions: { get: (id) => sessions.get(String(id)) },
    agents: { get: (id) => agents.get(String(id)) },
    get(service) {
      if (service === 'sessions') return ctx.sessions;
      if (service === 'agents') return ctx.agents;
      if (service === 'commands') return commandService;
      if (service === 'configEditor') {
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
            return bindOrigin === null ? undefined : bindOrigin;
          },
        },
        commands: commandService,
        effect(callback) {
          const dispose = callback();
          disposers.push(dispose);
          return () => {};
        },
      };
      callback(child);
    },
    effect(callback) {
      const dispose = callback();
      disposers.push(dispose);
      return () => {};
    },
  };

  apply(ctx, { enableSnapshot: false, ...config });

  const defaultTime = Date.parse('2026-10-28T10:00:00+08:00'); // Wednesday peak
  function emit(type, data, time = defaultTime) {
    const event = { type, seq: ++sequence, time, data };
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

  function callGet(url = '/dsh-budget/state?sessionId=session-1', headers = { host: '127.0.0.1:56675' }, remoteAddress = '127.0.0.1') {
    const route = routes.get(url.split('?')[0]);
    assert.ok(route, `route registered for ${url}`);
    const response = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status; },
      end(text) { this.body = text; },
    };
    return route
      .handler({ method: 'GET', url, headers, socket: { remoteAddress } }, response)
      .then(() => ({ status: response.status, body: JSON.parse(response.body) }));
  }

  function callPost(url, body, headers = { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' }, remoteAddress = '127.0.0.1') {
    const route = routes.get(url);
    assert.ok(route, `route registered for ${url}`);
    const response = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status; },
      end(text) { this.body = text; },
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

  function assistant(usage, text = '', model = 'deepseek-chat', time = defaultTime, step = 1) {
    return emit(
      'assistant/message',
      {
        turn: 1,
        step,
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek', model },
          content: text ? [{ type: 'text', text }] : [],
        },
        stream: [],
        usage,
      },
      time,
    );
  }

  async function command(rawInput) {
    const definition = commands.find((item) => item.name === 'budget');
    assert.ok(definition, '/budget command registered');
    const event = emit('command/run', {
      commandId: `cmd-${sequence + 1}`,
      name: 'budget',
      args: rawInput,
    });
    return definition.handler({
      agent,
      rawInput,
      commandId: event.data.commandId,
      signal: new AbortController().signal,
    });
  }

  function dispose() {
    for (const disposeEffect of disposers.splice(0).reverse()) {
      if (typeof disposeEffect === 'function') disposeEffect();
    }
  }

  return {
    ctx,
    session,
    agent,
    events,
    routes,
    commands,
    cancels,
    warnings,
    configEdits,
    emit,
    turnStopping,
    preStep,
    callGet,
    callPost,
    assistant,
    command,
    dispose,
    get sequence() { return sequence; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// ── 1. /config/save is usable from localhost and 127.0.0.1 ────────────────
{
  const harness = makeHarness({});
  const viaIp = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: '127.0.0.1:56675' });
  assert.equal(viaIp.status, 200, '127.0.0.1 Host + loopback peer needs no Origin');
  const viaName = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: 'localhost:56675' });
  assert.equal(viaName.status, 200, 'localhost Host + loopback peer needs no Origin');
  const alias = await harness.callPost(
    '/dsh-budget/config/save',
    { warnRatio: 0.8 },
    { host: 'localhost:56675', origin: 'http://127.0.0.1:56675' },
  );
  assert.equal(alias.status, 200, 'loopback Host aliases are the same listener');
  const upper = await harness.callPost(
    '/dsh-budget/config/save',
    { warnRatio: 0.8 },
    { host: 'LOCALHOST:56675', origin: 'http://localhost:56675' },
  );
  assert.equal(upper.status, 200, 'Host comparison is case-insensitive');

  // The browser may send an Origin on a POST; it is accepted as long as it
  // names the loopback listener (or its alias).
  const withOrigin = await harness.callPost(
    '/dsh-budget/config/save',
    { warnRatio: 0.8 },
    { host: '127.0.0.1:56675', origin: 'http://127.0.0.1:56675' },
  );
  assert.equal(withOrigin.status, 200);

  const remote = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: '127.0.0.1:56675' }, '192.168.1.9');
  assert.equal(remote.status, 403, 'a LAN peer cannot ride the local-Host rule');
  const lastReject = (await harness.callGet('/dsh-budget/config')).body.config.server.lastReject;
  assert.equal(lastReject.reason, 'not-loopback', '/config/save records why it refused');

  const rebind = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: 'evil.example:56675' });
  assert.equal(rebind.status, 403, 'a foreign Host is refused even from loopback');
  await tick();
  harness.dispose();
}

// ── 2. a host without getOrigin() still accepts local Host + loopback ─────
{
  const harness = makeHarness({}, 0, { bindOrigin: null });
  const viaIp = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: '127.0.0.1:56675' });
  assert.equal(viaIp.status, 200, 'bind address unknown must not break a local save');
  const viaName = await harness.callPost('/dsh-budget/config/save', { warnRatio: 0.8 }, { host: 'localhost:56675' });
  assert.equal(viaName.status, 200);
  await tick();
  harness.dispose();
}

// ── 3. validation names the offending field ───────────────────────────────
{
  const harness = makeHarness({});
  const negative = await harness.callPost('/dsh-budget/config/save', { budgetAmount: -1 });
  assert.equal(negative.status, 400);
  assert.equal(negative.body.error, 'invalid');
  assert.equal(negative.body.issues[0].path[0], 'budgetAmount');

  const tokens = await harness.callPost('/dsh-budget/config/save', { tokenBudget: 'abc' });
  assert.equal(tokens.status, 400);
  assert.equal(tokens.body.issues[0].path[0], 'tokenBudget');

  const unknown = await harness.callPost('/dsh-budget/config/save', { bogus: 1 });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error, 'unknown-key');

  const saved = await harness.callPost('/dsh-budget/config/save', { budgetAmount: 0.5 });
  assert.equal(saved.status, 200);
  await tick();
  assert.equal(harness.configEdits.at(-1).values.budgetAmount, 0.5);

  const zeros = await harness.callPost('/dsh-budget/config/save', { budgetAmount: 0, tokenBudget: 0 });
  assert.equal(zeros.status, 200, '0 is a valid default budget');
  harness.dispose();
}

// ── 4. a saved default budget applies to a new session immediately ────────
{
  const harness = makeHarness({ budgetAmount: 0.5 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  const state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0.5);
  assert.equal(state.configured, true);
  harness.dispose();
}

// ── 5. pricing formula: 1000 miss + 500 hit + 2000 output @ 2 / .04 / 8 ───
{
  const peakTime = Date.parse('2026-10-28T10:00:00+08:00');
  const receipt = priceMessage({
    usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 2000, totalTokens: 3500 },
    model: 'deepseek-flash',
    timestamp: peakTime,
    holidays: new Set(),
    book: {
      models: {
        'deepseek-flash': {
          peak: { input_miss: 2, input_hit: 0.04, output: 8 },
          offpeak: { input_miss: 1, input_hit: 0.02, output: 4 },
        },
      },
    },
  });
  assert.equal(receipt.skipped, false);
  // (2000 + 20 + 16000) / 1e6 = 0.01802.
  assert.equal(receipt.inputMissTokens, 1000, 'inputTokens is the miss count');
  assert.equal(receipt.inputHitTokens, 500, 'cacheReadTokens is the hit count');
  assert.equal(receipt.outputTokens, 2000);
  const expected = (1000 * 2 + 500 * 0.04 + 2000 * 8) / 1000000;
  assert.ok(Math.abs(receipt.cost - expected) < 1e-12, `expected ${expected}, got ${receipt.cost}`);

  // The same usage through the Host must update the state the UI reads.
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant(
    { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 2000, totalTokens: 3500 },
    'usage',
    'deepseek-flash',
  );
  const state = (await harness.callGet()).body.state;
  assert.ok(Math.abs(state.used.cost - 0.01802) < 1e-9, `host cost ${state.used.cost}`);
  assert.equal(state.used.breakdown.inputMiss, 0.002);
  assert.ok(Math.abs(state.used.breakdown.inputHit - 0.00002) < 1e-12);
  assert.equal(state.used.breakdown.output, 0.016);
  assert.equal(state.used.inputMissTokens, 1000);
  assert.equal(state.used.cacheReadTokens, 500);
  assert.equal(state.used.outputTokens, 2000);
  harness.dispose();
}

// ── 6. auto intercept, unlock, lock and a re-set budget re-arm the guard ──
{
  const harness = makeHarness({
    budgetAmount: 0.01,
    interceptMode: 'auto',
    interceptRatio: 0.95,
    turnEstimateMinInterval: 0,
  });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 5000, outputTokens: 0, totalTokens: 5000 }, 'spend');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'auto mode cancels at the threshold');
  const stopped = (await harness.callGet()).body.state;
  assert.equal(stopped.guard.stopped, true);
  assert.equal(stopped.guard.lastStopKind, 'auto');

  const preStepBlocked = await harness.preStep();
  assert.equal(preStepBlocked.kind, 'reject', 'pre-step refuses after the threshold');

  const unlock = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'unlock' });
  assert.equal(unlock.status, 200);
  const lifted = (await harness.callGet()).body.state;
  assert.equal(lifted.guard.disabled, true);
  assert.equal(lifted.guard.stopped, false);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, 'unlock stops further cancels');
  assert.equal((await harness.preStep()).kind, 'enter', 'unlock also disables the pre-step guard');

  // /budget lock re-arms and clears the stale recovery banner.
  const lock = await harness.command('lock');
  assert.equal(lock.kind, 'success');
  const locked = (await harness.callGet()).body.state;
  assert.equal(locked.guard.disabled, false);
  assert.equal(locked.guard.stopped, false, 'lock must not resurrect the previous STOP banner');
  harness.emit('turn/start', { turn: 2 });
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 2, 'lock restores interception');

  // A grant from 继续 must not survive a smaller re-set budget: otherwise the
  // old grant line (10% of the old budget) is above the new limit and the
  // guard silently never fires.
  const resume = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'resume' });
  assert.equal(resume.status, 200);
  assert.equal((await harness.callGet()).body.state.manual.continues, 1);
  harness.emit('turn/start', { turn: 3 });
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 2, 'the grant moves the line');
  const reset = await harness.command('0.005');
  assert.equal(reset.kind, 'success');
  const afterReset = (await harness.callGet()).body.state;
  assert.equal(afterReset.budget.amount, 0.005);
  assert.equal(afterReset.manual.continues, 0, 're-setting the budget clears old grants');
  assert.equal(afterReset.guard.stopped, false);
  harness.emit('turn/start', { turn: 4 });
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 3, 'the new, smaller budget intercepts again');
  harness.dispose();
}

// ── 6b. /budget 0.01 is enough to stop a long conversation ────────────────
{
  const harness = makeHarness({ turnEstimateMinInterval: 0 });
  const set = await harness.command('0.01');
  assert.equal(set.kind, 'success');
  assert.equal((await harness.callGet()).body.state.budget.amount, 0.01);
  harness.emit('turn/start', { turn: 1 });
  for (let step = 1; step <= 5; step += 1) {
    harness.emit('step/start', { turn: 1, step });
    harness.assistant({ inputTokens: 1000, outputTokens: 0, totalTokens: 1000 }, `s${step}`, 'deepseek-chat', undefined, step);
  }
  const spent = (await harness.callGet()).body.state;
  assert.equal(spent.used.cost, 0.01);
  assert.equal(spent.used.percent, 100);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, '/budget 0.01 auto-cancels after the budget is exhausted');
  harness.dispose();
}

// ── 6c. an explicit 0/0 set-budget clears the session override ────────────
{
  const harness = makeHarness({ budgetAmount: 2, turnEstimateMinInterval: 0 });
  const set = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'set-budget', amount: 5, tokens: 0 });
  assert.equal(set.status, 200);
  assert.equal((await harness.callGet()).body.state.budget.amount, 5);
  const cleared = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'set-budget', amount: 0, tokens: 0 });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.cleared, true);
  const state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 2, '0/0 falls back to the Config default');
  assert.match(cleared.body.message, /恢复默认预算/);
  harness.dispose();
}

// ── 7. manual prompt actions are wired, and lock clears grants ────────────
{
  const harness = makeHarness({
    budgetAmount: 0.01,
    interceptMode: 'manual',
    interceptRatio: 0.95,
    turnEstimateMinInterval: 0,
  });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 5000, outputTokens: 0, totalTokens: 5000 }, 'manual');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, 'manual mode prompts instead of cancelling');
  const prompted = (await harness.callGet()).body.state;
  assert.equal(prompted.manual.pending, true);
  assert.equal(prompted.manual.canContinue, true);

  const continued = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'continue' });
  assert.equal(continued.status, 200);
  const after = (await harness.callGet()).body.state;
  assert.equal(after.manual.continues, 1);
  assert.equal(after.manual.pending, false);

  const unlocked = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'unlock' });
  assert.equal(unlocked.status, 200);
  const locked = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'lock' });
  assert.equal(locked.status, 200);
  const relocked = (await harness.callGet()).body.state;
  assert.equal(relocked.manual.continues, 0, 'lock re-arms from a clean grant line');
  assert.equal(relocked.guard.stopped, false);

  const suppressed = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'suppress' });
  assert.equal(suppressed.status, 200);
  assert.equal((await harness.callGet()).body.state.manual.suppressed, true);

  const aborted = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'abort' });
  assert.equal(aborted.status, 200);
  assert.equal(harness.cancels.at(-1).cause.kind, 'user');
  harness.dispose();
}

// ── 8. every /budget command works (status, set, off, prices, debug) ──────
{
  const harness = makeHarness({ budgetAmount: 2, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 1000, outputTokens: 50, totalTokens: 1050 }, 'first');

  const status = await harness.command('');
  assert.equal(status.kind, 'success');
  assert.match(status.text, /预算：¥2\.00/);
  assert.match(status.text, /已用：/);

  const set = await harness.command('1');
  assert.equal(set.kind, 'success');
  assert.equal((await harness.callGet()).body.state.budget.amount, 1);

  const off = await harness.command('off');
  assert.equal(off.kind, 'success');
  const restored = (await harness.callGet()).body.state;
  assert.equal(restored.budget.amount, 2, 'off restores the Config default');
  assert.match(off.text, /恢复默认预算/);

  const prices = await harness.command('prices');
  assert.equal(prices.kind, 'success');
  assert.match(prices.text, /计费口径/);
  assert.match(prices.text, /未定价模型/);

  const debug = await harness.command('debug');
  assert.equal(debug.kind, 'success');
  assert.match(debug.text, /原始 usage/);
  assert.match(debug.text, /"inputTokens":1000/);
  assert.match(debug.text, /合计 ¥/);
  assert.doesNotMatch(debug.text, /缓存写入/, 'debug has no cache-write line');
  assert.match(debug.text, /输出 50×¥8\/1M/, 'debug prints the settlement unit price');
  harness.dispose();
}

// ── 8b. /budget 0 and /budget both 0 0 are /budget off ───────────────────
{
  const harness = makeHarness({ budgetAmount: 0, turnEstimateMinInterval: 0 });
  const set = await harness.command('1');
  assert.equal(set.kind, 'success');
  assert.equal((await harness.callGet()).body.state.budget.amount, 1);
  const zero = await harness.command('0');
  assert.equal(zero.kind, 'success');
  let state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0);
  assert.equal(state.configured, false);

  const both = await harness.command('both 2 20000');
  assert.equal(both.kind, 'success');
  state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 2);
  assert.equal(state.budget.tokens, 20000);
  const bothZero = await harness.command('both 0 0');
  assert.equal(bothZero.kind, 'success');
  state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0);
  assert.equal(state.budget.tokens, 0);
  assert.equal(state.configured, false);
  harness.dispose();
}

// ── 8c. a zero amount line never disables (or duplicates) the token line ──
{
  const harness = makeHarness({ budgetAmount: 0, tokenBudget: 0, interceptMode: 'auto', turnEstimateMinInterval: 0 });
  const both = await harness.command('both 0 5000');
  assert.equal(both.kind, 'success');
  let state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0, 'the amount line is explicitly off');
  assert.equal(state.budget.tokens, 5000);
  assert.equal(state.configured, true, 'the token line alone still enforces');

  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 4000, outputTokens: 0, totalTokens: 4000 }, 'under');
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 0, '4000 < 95% of 5000 tokens');

  harness.emit('step/start', { turn: 1, step: 2 });
  harness.assistant({ inputTokens: 2000, outputTokens: 0, totalTokens: 2000 }, 'over', 'deepseek-chat', undefined, 2);
  await harness.turnStopping();
  assert.equal(harness.cancels.length, 1, '6000 tokens crosses the token line');

  // `/budget 0` clears the whole override, so both Config zeros apply again.
  const zero = await harness.command('0');
  assert.equal(zero.kind, 'success');
  state = (await harness.callGet()).body.state;
  assert.equal(state.budget.amount, 0);
  assert.equal(state.budget.tokens, 0);
  assert.equal(state.configured, false);
  assert.equal(state.warning, null);
  harness.dispose();
}

// ── 8d. 放行/不再提示 with no budget are explicit no-ops ─────────────────
{
  const harness = makeHarness({ budgetAmount: 0, tokenBudget: 0, turnEstimateMinInterval: 0 });
  const cont = await harness.command('continue');
  assert.equal(cont.kind, 'success');
  assert.match(cont.text, /未设置预算/);
  const sup = await harness.command('suppress');
  assert.equal(sup.kind, 'success');
  assert.match(sup.text, /未设置预算/);
  const state = (await harness.callGet()).body.state;
  assert.equal(state.manual.continues, 0, 'no grant is invented without a line');
  assert.equal(state.manual.suppressed, false, 'nothing is marked suppressed without a line');
  assert.equal(state.warning, null);
  harness.dispose();
}

// ── 9. unknownWarnRatio=0 is honored (not replaced by the 0.2 default) ────
{
  const harness = makeHarness({ budgetAmount: 1, unknownWarnRatio: 0, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 900, outputTokens: 0, totalTokens: 900 }, 'known');
  harness.assistant({ inputTokens: 100, outputTokens: 0, totalTokens: 100 }, 'mystery', 'mystery-model', undefined, 2);
  const state = (await harness.callGet()).body.state;
  assert.equal(state.pricing.unknownTokens, 100);
  assert.equal(state.pricing.protectionAtRisk, true, '0 means warn on any unpriced token');
  assert.match(state.warning.text, /未定价模型占 10%/);
  harness.dispose();

  // A zero threshold must not invent a warning when there are no unpriced
  // tokens at all (0 / total >= 0 is mathematically true).
  const clean = makeHarness({ budgetAmount: 1, unknownWarnRatio: 0, turnEstimateMinInterval: 0 });
  clean.emit('turn/start', { turn: 1 });
  clean.emit('step/start', { turn: 1, step: 1 });
  clean.assistant({ inputTokens: 900, outputTokens: 0, totalTokens: 900 }, 'known');
  const cleanState = (await clean.callGet()).body.state;
  assert.equal(cleanState.pricing.unknownTokens, 0);
  assert.equal(cleanState.pricing.protectionAtRisk, false, 'no unknown tokens means no protection warning');
  assert.equal(cleanState.warning, null);
  clean.dispose();
}

// ── 10. cold start: snapshot -> stale -> corrected by the log ─────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-regression-snapshot');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  const config = { enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0, budgetAmount: 0 };

  const first = makeHarness(config);
  first.emit('turn/start', { turn: 1 });
  first.emit('step/start', { turn: 1, step: 1 });
  first.assistant({ inputTokens: 1000, outputTokens: 100, totalTokens: 1100 }, 'cold');
  first.emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const before = (await first.callGet()).body.state;
  assert.ok(before.used.cost > 0);
  first.dispose(); // flushes the snapshot synchronously

  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0, 'a snapshot file was written');
  const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
  assert.equal(saved.sessions['session-1'].cost, before.used.cost);

  const second = makeHarness(config, first.sequence);
  second.session.snapshotEvents = () => first.events.slice();
  const cold = (await second.callGet()).body.state;
  assert.equal(cold.stale, true, 'cold start reports a snapshot as 待校正');
  assert.ok(cold.used.cost > 0, 'history is restored from the snapshot');
  assert.equal(cold.counters.snapshotLastSeq > 0, true);
  assert.equal(cold.estimate.source, 'recent');
  assert.equal(cold.estimate.remainingCost, null);
  assert.equal(cold.estimate.recentUnit, 'turn', 'turnSummaries survive the snapshot');

  second.emit('user/message', { text: 'continue' });
  const corrected = (await second.callGet()).body.state;
  assert.equal(corrected.stale, false, 'a newer log event corrects the snapshot');
  second.dispose();
  rmSync(dir, { recursive: true, force: true });
}

// ── 10b. a 0.3.x (version 1) snapshot is ignored, not parsed ──────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-old-snapshot');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  writeFileSync(join(dir, 'snapshots.999.999.json'), JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    sessions: {
      'session-1': {
        sessionId: 'session-1',
        lastSeq: 5,
        cost: 9,
        // A 16-field 0.3.x summary: the loader must reject the whole file
        // before chargeFromSummary ever sees this layout.
        settledCharges: [['session-1:1:1', [1, 0, 9, 0, 1000, 1000, 1000, 0, 0, 0, 9, 0, 0, 0, 'deepseek-chat', 5]]],
      },
    },
  }));
  try {
    const harness = makeHarness({ enableSnapshot: true, snapshotPath, turnEstimateMinInterval: 0 });
    const state = (await harness.callGet()).body.state;
    assert.equal(state.used.cost, 0, 'the old snapshot is not used');
    assert.equal(state.stale, false, 'nothing is marked stale');
    assert.ok(
      harness.warnings.some((warning) => warning.includes('snapshot version mismatch')),
      'the loader warns instead of crashing',
    );
    harness.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── 11. an /action decision is persisted immediately ──────────────────────
{
  const dir = join(process.cwd(), 'test', '.tmp-regression-action');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const snapshotPath = join(dir, 'snapshots.json');
  const harness = makeHarness({ enableSnapshot: true, snapshotPath, budgetAmount: 0.01, turnEstimateMinInterval: 0 });
  harness.emit('turn/start', { turn: 1 });
  harness.emit('step/start', { turn: 1, step: 1 });
  harness.assistant({ inputTokens: 5000, outputTokens: 0, totalTokens: 5000 }, 'persist');
  await harness.turnStopping();
  const unlock = await harness.callPost('/dsh-budget/action', { sessionId: 'session-1', action: 'unlock' });
  assert.equal(unlock.status, 200);
  const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
  assert.ok(files.length > 0, 'snapshot exists before the action');
  const stored = JSON.parse(readFileSync(join(dir, files.at(-1)), 'utf8'));
  assert.equal(stored.sessions['session-1'].guardDisabled, true, 'unlock is flushed without waiting for the next event');
  harness.dispose();
  rmSync(dir, { recursive: true, force: true });
}

// ── 12. component key / registered command names are the live ones ────────
assert.equal(name, 'budget-guard');

rmSync(TEST_DSH_HOME, { recursive: true, force: true });

console.log('regression tests passed');
