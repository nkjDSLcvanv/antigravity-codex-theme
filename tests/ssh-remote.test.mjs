/**
 * tests/ssh-remote.test.mjs — Unit Tests for Opt-In SSH Remote Conversation Metrics Sync
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateSshHost,
  normalizeSshHosts,
  parseRemoteStatOutput,
  pruneStaleCacheFiles,
  createSshRemoteController
} from '../core/daemon/ssh-remote.mjs';

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

test('parseRemoteStatOutput parses GNU and BSD stat output lines', () => {
  const cid = '5459f7c3-37ab-4473-bf4c-a9977834e627';
  const stdout = [
    `/home/alice/.gemini/antigravity/conversations/${cid}.db|1795310757:14024704`,
    `/home/alice/.gemini/antigravity/conversations/${cid}.db-wal|1795310784:196784`,
    `/home/alice/.gemini/antigravity/conversations/${cid}.db-shm|1795310784:32768`
  ].join('\n');

  assert.deepEqual(parseRemoteStatOutput(stdout, cid), {
    db: '1795310757:14024704',
    wal: '1795310784:196784',
    shm: '1795310784:32768'
  });
});

test('pruneStaleCacheFiles enforces maxAgeMs, maxConversations, and stale staging cleanup', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ssh-prune-test-'));
  try {
    const nowMs = Date.now();
    const cidOld = '11111111-1111-1111-1111-111111111111';
    const cidMid = '22222222-2222-2222-2222-222222222222';
    const cidNew = '33333333-3333-3333-3333-333333333333';

    for (const [cid, ageSec] of [
      [cidOld, 5 * 86400],
      [cidMid, 120],
      [cidNew, 10]
    ]) {
      const dbFile = path.join(tmpDir, `${cid}.db`);
      const walFile = path.join(tmpDir, `${cid}.db-wal`);
      fs.writeFileSync(dbFile, 'db');
      fs.writeFileSync(walFile, 'wal');
      const mtime = new Date(nowMs - ageSec * 1000);
      fs.utimesSync(dbFile, mtime, mtime);
      fs.utimesSync(walFile, mtime, mtime);
    }

    const staleStage = path.join(tmpDir, `.staging-${cidOld}`);
    fs.mkdirSync(staleStage);
    const oldStageTime = new Date(nowMs - 20 * 60 * 1000);
    fs.utimesSync(staleStage, oldStageTime, oldStageTime);

    const res = pruneStaleCacheFiles(tmpDir, {
      maxAgeMs: 2 * 86400 * 1000,
      maxConversations: 1,
      nowMs
    });

    assert.equal(res.removedStaging, 1);
    assert.equal(res.removedConversations, 2);
    assert.equal(fs.existsSync(path.join(tmpDir, `${cidNew}.db`)), true);
    assert.equal(fs.existsSync(path.join(tmpDir, `${cidMid}.db`)), false);
    assert.equal(fs.existsSync(path.join(tmpDir, `${cidOld}.db`)), false);
    assert.equal(fs.existsSync(staleStage), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createSshRemoteController is strictly opt-in, uses -- separator, and syncs incrementally', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-ssh-ctrl-test-'));
  const calls = [];
  const cid = '5459f7c3-37ab-4473-bf4c-a9977834e627';

  const execFileImpl = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'ssh') {
      assert.ok(args.includes('--'), 'ssh args must include -- option terminator');
      return {
        stdout: `/home/user/.gemini/antigravity/conversations/${cid}.db|1700000001:4096\n/home/user/.gemini/antigravity/conversations/${cid}.db-wal|1700000002:512\n`,
        stderr: ''
      };
    }
    if (cmd === 'scp') {
      assert.ok(args.includes('--'), 'scp args must include -- option terminator');
      const destDir = args[args.length - 1];
      fs.writeFileSync(path.join(destDir, `${cid}.db`), 'sqlite-db-bytes');
      fs.writeFileSync(path.join(destDir, `${cid}.db-wal`), 'sqlite-wal-bytes');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Unexpected command: ${cmd}`);
  };

  try {
    const ctrl = createSshRemoteController({ cacheDir: tmpDir, execFileImpl });

    // No sshHosts configured -> strictly no SSH calls (never auto-scans ~/.ssh/config)
    assert.equal(ctrl.getRemoteMetricsSource(cid, { sshHosts: [] }), null);
    assert.equal(calls.length, 0);

    // Invalid option-like host -> ignored, no SSH calls
    assert.equal(ctrl.getRemoteMetricsSource(cid, { sshHosts: ['-oProxyCommand=evil'] }), null);
    assert.equal(calls.length, 0);

    // Valid host -> triggers async sync
    const first = ctrl.getRemoteMetricsSource(cid, { sshHosts: ['node032'], force: true });
    assert.ok(first?.syncPromise);
    await first.syncPromise;

    assert.equal(calls.filter((c) => c.cmd === 'ssh').length, 1);
    assert.equal(calls.filter((c) => c.cmd === 'scp').length, 1);
    assert.equal(fs.existsSync(path.join(tmpDir, `${cid}.db`)), true);
    assert.equal(fs.existsSync(path.join(tmpDir, `${cid}.db-wal`)), true);

    // Subsequent poll with unchanged remote stat -> checks stat via ssh, skips scp
    const second = ctrl.getRemoteMetricsSource(cid, { sshHosts: ['node032'], force: true });
    assert.equal(second?.dir, tmpDir);
    assert.equal(second?.host, 'node032');
    if (second?.syncPromise) await second.syncPromise;
    assert.equal(calls.filter((c) => c.cmd === 'scp').length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
