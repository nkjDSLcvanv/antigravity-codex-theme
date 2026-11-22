/**
 * tests/ssh-remote.test.mjs — Unit Tests for In-Memory SSH Remote Telemetry Reader
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSshHost,
  normalizeSshHosts,
  synthesizeCheckpointPayload,
  mergeRemoteSnapshot,
  createVirtualRemoteDb,
  createSshRemoteController
} from '../core/daemon/ssh-remote.mjs';
import { parseCheckpointStepInfo } from '../core/daemon/protobuf.mjs';
import { createMetricsReader } from '../core/daemon/sqlite-metrics.mjs';

function encodeVarint(v) {
  const out = [];
  let n = Math.max(0, Number(v) || 0);
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Buffer.from(out);
}

function pbVarintField(fn, val) {
  return Buffer.concat([encodeVarint((fn << 3) | 0), encodeVarint(val)]);
}

function pbBytesField(fn, buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8');
  return Buffer.concat([encodeVarint((fn << 3) | 2), encodeVarint(b.length), b]);
}

function buildTestGenRowProto({ inTok = 1000, outTok = 200, cacheRead = 8000, maxCtx = 256000, maxStepIdx = 5, model = 'Gemini 4 Hydrogen' } = {}) {
  const usage = Buffer.concat([
    pbVarintField(2, inTok),
    pbVarintField(3, outTok),
    pbVarintField(5, cacheRead),
    pbVarintField(9, 50),
    pbVarintField(10, 150)
  ]);
  const chatStart = pbBytesField(10, pbVarintField(4, maxCtx));
  const ttft = pbVarintField(1, 1);
  const stream = pbVarintField(1, 1);
  const chat = Buffer.concat([
    pbBytesField(4, usage),
    pbBytesField(9, chatStart),
    pbBytesField(11, ttft),
    pbBytesField(12, stream),
    pbBytesField(21, model)
  ]);
  return Buffer.concat([pbBytesField(1, chat), pbVarintField(2, maxStepIdx)]);
}

test('validateSshHost and normalizeSshHosts block leading dashes and metacharacters', () => {
  assert.equal(validateSshHost('node032'), true);
  assert.equal(validateSshHost('dev_user@10.0.0.12'), true);
  assert.equal(validateSshHost('gpu-cluster.internal.example.com'), true);

  assert.equal(validateSshHost('-oProxyCommand=sh'), false);
  assert.equal(validateSshHost('-v'), false);
  assert.equal(validateSshHost('host*'), false);
  assert.equal(validateSshHost('host;rm -rf /'), false);
  assert.equal(validateSshHost('host name'), false);
  assert.equal(validateSshHost(''), false);

  assert.deepEqual(
    normalizeSshHosts([' node032 ', '-oProxyCommand=evil', 'node032', 'user@host-2', 'bad*host']),
    ['node032', 'user@host-2']
  );
  assert.deepEqual(normalizeSshHosts([]), []);
  assert.deepEqual(normalizeSshHosts(null), []);
});

test('synthesizeCheckpointPayload preserves checkpoint summary byte length without summary text', () => {
  const payload = synthesizeCheckpointPayload(4096);
  const parsed = parseCheckpointStepInfo({
    idx: 12,
    status: 3,
    metadata: null,
    step_payload: payload
  });
  assert.equal(parsed.idx, 12);
  assert.equal(parsed.summaryBytes, 4096);
});

test('mergeRemoteSnapshot and createVirtualRemoteDb integrate with sqlite-metrics in memory', () => {
  const cid = '5459f7c3-37ab-4473-bf4c-a9977834e627';
  const row0 = buildTestGenRowProto({ inTok: 2000, outTok: 300, cacheRead: 18000, maxStepIdx: 3 }).toString('base64');
  const row1 = buildTestGenRowProto({ inTok: 1000, outTok: 400, cacheRead: 19000, maxStepIdx: 6 }).toString('base64');

  const snap1 = mergeRemoteSnapshot(null, {
    found: true,
    sig: '1700000001:4096|0:0',
    metaStat: { cnt: 1, maxIdx: 0 },
    userStepIdxs: [1],
    lastUserMetaRow: { metadata: null, plen: 42 },
    stepStat: { cnt: 4, maxIdx: 3 },
    lastCpRow: null,
    activeStepRows: [],
    lastModelStepRow: { idx: 3, step_type: 15, status: 3, error_details: null, step_payload: null, metadata: null },
    latestNonUserStep: { idx: 3, step_type: 15, status: 3, error_details: null, step_payload: null, metadata: null },
    lastGenMetaRow: { size: 64, dlen: 64 },
    turnStat: { cnt: 1 },
    startIdx: 0,
    genRows: [{ idx: 0, data: row0 }]
  });

  // Incremental delta merge from startIdx = 0 (replaces tail >= 0 and appends idx 1)
  const snap2 = mergeRemoteSnapshot(snap1, {
    found: true,
    sig: '1700000002:8192|0:0',
    metaStat: { cnt: 2, maxIdx: 1 },
    userStepIdxs: [1, 4],
    lastUserMetaRow: { metadata: null, plen: 64 },
    stepStat: { cnt: 7, maxIdx: 6 },
    lastCpRow: null,
    activeStepRows: [],
    lastModelStepRow: { idx: 6, step_type: 15, status: 3, error_details: null, step_payload: null, metadata: null },
    latestNonUserStep: { idx: 6, step_type: 15, status: 3, error_details: null, step_payload: null, metadata: null },
    lastGenMetaRow: { size: 64, dlen: 64 },
    turnStat: { cnt: 1 },
    startIdx: 1,
    genRows: [{ idx: 1, data: row1 }]
  });

  assert.equal(snap2.allGenRows.length, 2);

  // Verify sqlite-metrics parses virtual in-memory DB without touching disk or node:sqlite
  const reader = createMetricsReader({
    getDatabaseSync: () => null,
    getConfig: () => ({
      manualContextLimit: 0,
      fallbackContextLimit: 256000,
      telemetryLayout: 'compact',
      telemetryCacheMode: 'session'
    })
  });

  const metrics = reader.parseConversationMetrics(cid, '/nonexistent', {
    cacheKey: `ssh://node032/${cid}`,
    rawDbSig: snap2.sig,
    openDb: () => createVirtualRemoteDb(snap2)
  });

  assert.equal(metrics.hasData, true);
  assert.equal(metrics.stats.genIdx, 2);
  assert.equal(metrics.stats.ctx, 20000);
  assert.equal(metrics.stats.outTok, 400);
  assert.equal(metrics.turns.length, 2);
});

test('createSshRemoteController is strictly opt-in, uses -- separator, and never invokes scp', async () => {
  const calls = [];
  const cid = '5459f7c3-37ab-4473-bf4c-a9977834e627';
  const row0 = buildTestGenRowProto().toString('base64');

  let remoteCallCount = 0;
  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    assert.equal(cmd, 'ssh', 'Only ssh should be invoked (never scp)');
    assert.ok(args.includes('--'), 'ssh args must include -- option terminator');
    remoteCallCount++;
    if (remoteCallCount === 1) {
      return {
        stdout: JSON.stringify({
          found: true,
          sig: '1700000001:4096|1700000002:512',
          metaStat: { cnt: 1, maxIdx: 0 },
          userStepIdxs: [1],
          lastUserMetaRow: { metadata: null, plen: 20 },
          stepStat: { cnt: 3, maxIdx: 2 },
          lastCpRow: null,
          activeStepRows: [],
          lastModelStepRow: null,
          latestNonUserStep: null,
          lastGenMetaRow: { size: 48, dlen: 48 },
          turnStat: { cnt: 1 },
          startIdx: 0,
          genRows: [{ idx: 0, data: row0 }]
        }),
        stderr: ''
      };
    }
    return {
      stdout: JSON.stringify({
        found: true,
        unchanged: true,
        sig: '1700000001:4096|1700000002:512'
      }),
      stderr: ''
    };
  };

  const ctrl = createSshRemoteController({ execFileImpl });

  // Empty sshHosts -> zero SSH calls
  assert.equal(ctrl.getRemoteMetricsSource(cid, { sshHosts: [] }), null);
  assert.equal(calls.length, 0);

  // Invalid option-like host -> zero SSH calls
  assert.equal(ctrl.getRemoteMetricsSource(cid, { sshHosts: ['-oProxyCommand=evil'] }), null);
  assert.equal(calls.length, 0);

  // First poll -> triggers async remote metadata query
  const first = ctrl.getRemoteMetricsSource(cid, { sshHosts: ['node032'], force: true });
  assert.ok(first?.syncPromise);
  await first.syncPromise;
  assert.equal(calls.length, 1);

  // Second poll -> returns in-memory virtual DB immediately and checks unchanged sig
  const second = ctrl.getRemoteMetricsSource(cid, { sshHosts: ['node032'], force: true });
  assert.equal(second?.host, 'node032');
  assert.equal(second?.sig, '1700000001:4096|1700000002:512');
  assert.equal(typeof second?.openDb, 'function');
  if (second?.syncPromise) await second.syncPromise;
  assert.equal(calls.length, 2);
});
