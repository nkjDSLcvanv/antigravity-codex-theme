/**
 * tests/status-machine.test.mjs — Unit tests evaluating core/runtime/30 & 40 state machine via node:vm
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function loadPureRuntimeHelpers() {
  const part30 = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '30-antigravity-probe.js'), 'utf8');
  const part40 = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '40-status-machine.js'), 'utf8');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(
    part30 +
      '\n' +
      part40 +
      '\nthis.__exports = { cleanModelLabel, normalizeModelMatchKey, getSelectedModelLabel, isSupersededStepError, selectBestLoadingText, WAIT_DEFAULTS, fmtWaitDuration, isUserCancelError, escapeStatusHtml, computeStatusSnapshot };',
    ctx
  );
  return ctx.__exports;
}

const {
  cleanModelLabel,
  normalizeModelMatchKey,
  getSelectedModelLabel,
  isSupersededStepError,
  selectBestLoadingText,
  fmtWaitDuration,
  isUserCancelError,
  computeStatusSnapshot
} = loadPureRuntimeHelpers();

const NOW = 1_700_000_000_000;

test('Part 30 helpers normalize model labels, detect superseded step errors, and prioritize retry text', () => {
  assert.equal(normalizeModelMatchKey('Gemini 4 Hydrogen Extra'), normalizeModelMatchKey('Gemini 4 Hydrogen (XHigh)'));
  assert.equal(normalizeModelMatchKey('Gemini 4 Neon Extra High'), normalizeModelMatchKey('Gemini 4 Neon (XHigh)'));
  assert.equal(normalizeModelMatchKey('Gemini 4 Neon Extra High'), normalizeModelMatchKey('Gemini 4 Neon (Extra High)'));
  assert.equal(
    cleanModelLabel('Model, current: Gemini 4 Neon Extra High, Model cannot be changed while the agent is running'),
    'Gemini 4 Neon Extra High'
  );
  assert.equal(
    cleanModelLabel('模型，当前：Gemini 4 Neon Extra High（智能体运行期间无法切换模型）'),
    'Gemini 4 Neon Extra High'
  );
  assert.equal(
    normalizeModelMatchKey('Gemini 4 Neon Extra High, Model cannot be changed while the agent is running'),
    normalizeModelMatchKey('Gemini 4 Neon (Extra High)')
  );
  assert.equal(
    isSupersededStepError({
      lastStepType: 15,
      stepsTail: [{ type: 15, status: 3 }],
      totalStepsLen: 20,
      errorId: 'conv-uuid-12'
    }),
    true
  );
  assert.equal(
    isSupersededStepError({
      lastStepType: 17,
      stepsTail: [{ type: 17, status: 7 }],
      totalStepsLen: 13,
      errorId: 'conv-uuid-12'
    }),
    false
  );
  assert.equal(
    selectBestLoadingText(['Thinking...', 'Model unavailable, retrying in 13s (attempt 6/9)']),
    'Model unavailable, retrying in 13s (attempt 6/9)'
  );
});

test('getSelectedModelLabel prefers Antigravity 2.36.0+ data-model-label and falls back cleanly on older builds', () => {
  const mkScope = (el) => ({ querySelector: (sel) => (sel === '[data-testid="model-selector-trigger"]' ? el : null) });
  const el236 = {
    innerText: 'Gemini 4 Neon',
    getAttribute(k) {
      if (k === 'data-model-label') return 'Gemini 4 Neon Extra High';
      if (k === 'aria-label') return '模型，当前：Gemini 4 Neon Extra High（适用于 /btw 及本轮之后发送的消息）';
      return null;
    }
  };
  assert.equal(getSelectedModelLabel(mkScope(el236)), 'Gemini 4 Neon Extra High');

  // Empty/placeholder data-model-label falls back cleanly to orig/current aria-label
  const elPlaceholder = {
    innerText: 'Gemini 4 Carbon Medium',
    getAttribute(k) {
      if (k === 'data-model-label') return 'Select model';
      if (k === 'data-ag-orig-aria-label') return 'Select model, current: Gemini 4 Carbon Medium. Applies to messages sent after this turn';
      return null;
    }
  };
  assert.equal(getSelectedModelLabel(mkScope(elPlaceholder)), 'Gemini 4 Carbon Medium');

  // Legacy build without data-model-label uses aria-label / innerText
  const elLegacy = {
    innerText: 'Claude Sonnet 5.5',
    getAttribute(k) {
      if (k === 'aria-label') return 'Model, current: Claude Sonnet 5.5 Medium';
      return null;
    }
  };
  assert.equal(getSelectedModelLabel(mkScope(elLegacy)), 'Claude Sonnet 5.5 Medium');
  assert.equal(getSelectedModelLabel(mkScope(null)), '');
});

test('Idle state stays steady blue even when fullyIdle is false after DONE turn', () => {
  const snap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'llm', lastModelLabel: 'Gemini 4 Hydrogen (XHigh)' },
    live: {
      matched: true,
      hasProvider: true,
      aspStatus: 1,
      effRunStatus: 1,
      fullyIdle: false,
      hasTrajectory: true,
      execCase: '',
      loadingText: '',
      stopBtnActive: false
    },
    lastHb: NOW - 2000,
    visibleSince: NOW - 60000,
    curModel: 'Gemini 4 Hydrogen Extra'
  });
  assert.equal(snap.visualState, 'idle');
  assert.equal(snap.isExecuting, false);
  assert.equal(snap.chipText, '');
  assert.ok(snap.dotTitle.startsWith('会话状态：就绪'));
});

test('Active execution pulses blue during normal generation and compacting', () => {
  const runSnap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'llm' },
    live: { matched: true, hasProvider: true, hasTrajectory: true, effRunStatus: 2, stopBtnActive: true },
    waitSec: 12,
    lastHb: NOW - 1000
  });
  assert.equal(runSnap.visualState, 'running');
  assert.equal(runSnap.chipText, '新步执行中...');
  assert.ok(runSnap.dotTitle.startsWith('会话状态：执行中'));

  const compactSnap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'compact' },
    live: { matched: true, hasProvider: true, hasTrajectory: true, effRunStatus: 2 },
    waitSec: 25,
    lastHb: NOW - 1000
  });
  assert.equal(compactSnap.visualState, 'running');
  assert.equal(compactSnap.chipText, '正在压缩...');
});

test('Waiting >= 60s transitions to amber slow pulse and notes model switch cold prefill', () => {
  const snap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'compact', lastModelLabel: 'Gemini 4 Hydrogen (XHigh)' },
    live: { matched: true, hasProvider: true, hasTrajectory: true, effRunStatus: 2 },
    waitSec: 75,
    lastHb: NOW - 1000,
    curModel: 'Gemini 4 Carbon (Medium)'
  });
  assert.equal(snap.visualState, 'slow');
  assert.equal(snap.chipClass, 'is-slow');
  assert.equal(snap.chipText, '压缩中 · 1m15s');
  assert.ok(snap.noteHtml.includes('无法复用原 KV 缓存'));
  assert.ok(snap.noteHtml.includes('Gemini 4 Hydrogen (Extra High)'));
  assert.ok(snap.noteHtml.includes('Gemini 4 Carbon (Medium)'));

  // Same model with Extra High vs legacy (XHigh) label and Antigravity 2.35.1 running-state aria suffix must NOT trigger false model-switch warning
  const sameModelSnap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'llm', lastModelLabel: 'Gemini 4 Neon (XHigh)' },
    live: { matched: true, hasProvider: true, hasTrajectory: true, effRunStatus: 2 },
    waitSec: 120,
    lastHb: NOW - 1000,
    curModel: 'Gemini 4 Neon Extra High, Model cannot be changed while the agent is running'
  });
  assert.equal(sameModelSnap.visualState, 'slow');
  assert.ok(!sameModelSnap.noteHtml.includes('模型已切换'), 'Extra High + running-state suffix must match as the same model');
  assert.ok(!sameModelSnap.noteHtml.includes('Model cannot be changed'), 'running-state suffix must never leak into tooltip');
  assert.ok(sameModelSnap.noteHtml.includes('长上下文预填充或后端排队耗时较长'));
});

test('Model retry transitions to amber slow pulse with live countdown', () => {
  const snap = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'llm', pendingRetrying: true, retryReason: 'Model unavailable' },
    live: {
      matched: true,
      hasProvider: true,
      hasTrajectory: true,
      effRunStatus: 2,
      execCase: 'modelRequest',
      execAttempt: 6,
      execMaxAttempts: 9,
      execRetryAtMs: NOW + 13000,
      loadingText: 'Model unavailable, retrying in 13s (attempt 6/9)',
      stopBtnActive: true
    },
    lastHb: NOW - 1000
  });
  assert.equal(snap.visualState, 'slow');
  assert.equal(snap.isRetrying, true);
  assert.equal(snap.chipText, '重试连接中 · 13s');
  assert.ok(snap.noteHtml.includes('Model unavailable'));
});

test('Unconnected stream escalates blue (<3s) -> amber (3s-11s) -> red (>=12s)', () => {
  const live = { matched: true, hasProvider: true, aspStatus: 0, hasTrajectory: false };
  const s2 = computeStatusSnapshot({ now: NOW, live, unconnSec: 2, lastHb: NOW });
  assert.equal(s2.visualState, 'idle');
  assert.equal(s2.shouldStartWaitTimer, true);

  const s5 = computeStatusSnapshot({ now: NOW, live, unconnSec: 5, lastHb: NOW });
  assert.equal(s5.visualState, 'slow');
  assert.equal(s5.chipText, '重连中 · 5s');

  const s14 = computeStatusSnapshot({ now: NOW, live, unconnSec: 14, lastHb: NOW });
  assert.equal(s14.visualState, 'error');
  assert.equal(s14.chipClass, 'is-error');
  assert.equal(s14.chipText, '未连接 · 14s');

  const homeSplash = computeStatusSnapshot({ now: NOW, live, hasConversation: false, unconnSec: 14, lastHb: NOW });
  assert.equal(homeSplash.visualState, 'idle');
  assert.equal(homeSplash.isStreamUnconnected, false);
});

test('Offline, real terminal error, and daemon timeout turn red while user cancellation stays idle', () => {
  const offline = computeStatusSnapshot({ now: NOW, navigatorOnline: false, lastHb: NOW });
  assert.equal(offline.visualState, 'error');
  assert.equal(offline.chipText, '网络离线');

  const canceled = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'idle', lastErrorMsg: 'context canceled' },
    lastHb: NOW
  });
  assert.equal(canceled.visualState, 'idle');

  const xssErr = computeStatusSnapshot({
    now: NOW,
    st: { pendingKind: 'idle', lastErrorMsg: '<img src=x onerror=alert(1)>' },
    lastHb: NOW
  });
  assert.equal(xssErr.visualState, 'error');
  assert.ok(!xssErr.noteHtml.includes('<img'));
  assert.ok(xssErr.noteHtml.includes('&lt;img'));

  const wakeGrace = computeStatusSnapshot({
    now: NOW,
    lastHb: NOW - 120000,
    visibleSince: NOW - 5000,
    documentHidden: false
  });
  assert.equal(wakeGrace.visualState, 'idle');

  const daemonDead = computeStatusSnapshot({
    now: NOW,
    lastHb: NOW - 120000,
    visibleSince: NOW - 30000,
    documentHidden: false
  });
  assert.equal(daemonDead.visualState, 'error');
  assert.equal(daemonDead.chipText, '后台断连');
  assert.equal(fmtWaitDuration(65), '1m05s');
  assert.equal(isUserCancelError('Cancelled by user'), true);
});
