/**
 * tests/quota-card.test.mjs — Unit tests for core/runtime/55-quota-card.js quota parsing,
 * dual-window pool aggregation, bilingual formatting, and fallback handling.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

function loadQuotaHelpers(modulesOverride = { quota: true, i18n: true }) {
  const part55 = fs.readFileSync(path.join(ROOT_DIR, 'core', 'runtime', '55-quota-card.js'), 'utf8');
  const ctx = {
    MODULES: { quota: true, i18n: true, ...modulesOverride }
  };
  vm.createContext(ctx);
  vm.runInContext(
    part55 +
      '\nthis.__exports = { escapeQuotaHtml, clampQuota01, quotaLevelFromPct, normalizeQuotaModelKey, stripQuotaEffortSuffix, classifyQuotaFamily, getQuotaLocaleStrings, getQuotaGroupTitle, parseQuotaResetMs, normalizeQuotaWindowKey, getQuotaWindowLabel, getQuotaWindowTooltipLabel, extractModelsFromQuotaDescription, buildQuotaSnapshotFromUserStatus, buildSnapshotFromQuotaSummary, buildQuotaPools, formatShortQuotaReset, formatExactQuotaTime };',
    ctx
  );
  return ctx.__exports;
}

const helpers = loadQuotaHelpers();

test('Quota helpers normalize effort labels, preserve decimals in descriptions, and decode Protobuf BigInt timestamps', () => {
  const models = Array.from(
    helpers.extractModelsFromQuotaDescription(
      'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Orchestrator (Neon), Gemini 3.8 Flash.'
    )
  );
  assert.deepEqual(models, [
    'Gemini 4 Neon',
    'Gemini 4 Hydrogen',
    'Orchestrator (Neon)',
    'Gemini 3.8 Flash'
  ]);

  assert.equal(helpers.stripQuotaEffortSuffix('Gemini 4 Hydrogen Extra High'), 'Gemini 4 Hydrogen');
  assert.equal(helpers.stripQuotaEffortSuffix('Gemini 4 Neon (XHigh)'), 'Gemini 4 Neon');
  assert.equal(
    helpers.normalizeQuotaModelKey('Gemini 4 Hydrogen Extra High'),
    helpers.normalizeQuotaModelKey('Gemini 4 Hydrogen (XHigh)')
  );

  assert.equal(helpers.classifyQuotaFamily('Gemini 4 Argon'), 'argon');
  assert.equal(helpers.classifyQuotaFamily('Claude and GPT models'), 'claude_gpt');
  assert.equal(helpers.classifyQuotaFamily('Gemini Models'), 'gemini');

  assert.equal(helpers.parseQuotaResetMs({ seconds: 1795353401n, nanos: 500_000_000 }), 1795353401500);
  assert.equal(helpers.parseQuotaResetMs({ seconds: '1795940201', nanos: 0 }), 1795940201000);
});

test('buildSnapshotFromQuotaSummary extracts sorted 5h and weekly buckets in Chinese and English', () => {
  const sampleResponse = {
    response: {
      groups: [
        {
          displayName: 'Gemini Models',
          description: 'Models within this group: Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              remaining: { case: 'remainingFraction', value: 0.812 },
              disabled: false,
              resetTime: { seconds: 1795940201n, nanos: 0 }
            },
            {
              bucketId: 'gemini-5h',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              remaining: { case: 'remainingFraction', value: 0.354 },
              disabled: false,
              resetTime: { seconds: 1795353401n, nanos: 0 }
            }
          ]
        },
        {
          displayName: 'Claude and GPT models',
          description: 'Models within this group: Claude Opus 5.5, GPT-OSS 120B',
          buckets: [
            {
              bucketId: '3p-5h',
              window: '5h',
              remaining: { case: 'remainingFraction', value: 0.25 },
              disabled: false,
              resetTime: { seconds: 1795365968n, nanos: 0 }
            },
            {
              bucketId: '3p-weekly',
              window: 'weekly',
              remaining: { case: 'remainingFraction', value: 1 },
              disabled: false,
              resetTime: { seconds: 1795952768n, nanos: 0 }
            }
          ]
        },
        {
          displayName: 'Gemini 4 Argon',
          description: 'For paid Pro plans, Argon quota is separate.',
          buckets: [
            {
              bucketId: 'gemini-argon-wtu-weekly',
              window: 'weekly',
              remaining: { case: 'remainingFraction', value: 0.955 },
              disabled: false,
              resetTime: { seconds: 1795951124n, nanos: 0 }
            }
          ]
        }
      ]
    }
  };

  const snapZh = helpers.buildSnapshotFromQuotaSummary(sampleResponse, { planName: 'Google AI Pro', aiCredits: 0 }, true, 1000);
  assert.ok(snapZh);
  assert.equal(snapZh.groups.length, 3);
  assert.equal(snapZh.groups[0].name, 'Gemini 模型');
  assert.deepEqual(
    Array.from(snapZh.groups[0].buckets, (b) => [b.windowKey, b.label, b.pct, b.level]),
    [
      ['5h', '5h', 35, 'warn'],
      ['weekly', '每周', 81, 'ok']
    ]
  );

  const poolsZh = helpers.buildQuotaPools(snapZh, null, 'Claude Opus 5.5 (High)', true);
  assert.equal(poolsZh[0].id, 'claude_gpt');
  assert.equal(poolsZh[0].isActive, true);
  assert.equal(poolsZh[0].isAlert, true);

  const poolsEn = helpers.buildQuotaPools(snapZh, null, 'Gemini 4 Hydrogen Extra High', false);
  assert.equal(poolsEn[0].name, 'Gemini Models');
  assert.equal(poolsEn[0].buckets[1].label, 'Weekly');
  assert.equal(poolsEn[1].name, 'Claude & GPT Models');
  assert.equal(poolsEn[1].buckets[1].compactLabel, 'Wk');
  assert.equal(poolsEn[1].isAlert, true);
});

test('buildQuotaPools falls back cleanly to userStatus when quota summary is unavailable', () => {
  const userStatusSnap = helpers.buildQuotaSnapshotFromUserStatus(
    {
      userTier: {
        name: 'Google AI Pro',
        availableCredits: [{ creditAmount: '120' }]
      },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: 'Gemini 4 Hydrogen (High)',
            disabled: false,
            quotaInfo: { remainingFraction: 0.52, resetTime: '2026-11-22T15:00:00Z' }
          },
          {
            label: 'Gemini 4 Argon (Medium)',
            disabled: false,
            quotaInfo: { remainingFraction: 0.96, resetTime: '2026-11-29T12:00:00Z' }
          },
          {
            label: 'Gemini 4 Carbon',
            disabled: true,
            quotaInfo: { remainingFraction: 0 }
          }
        ]
      }
    },
    5000
  );

  assert.ok(userStatusSnap);
  assert.equal(userStatusSnap.aiCredits, 120);
  assert.equal(userStatusSnap.models.length, 2);

  const pools = helpers.buildQuotaPools(null, userStatusSnap, 'Gemini 4 Argon (Medium)', true);
  assert.equal(pools.length, 2);
  assert.equal(pools[0].id, 'argon');
  assert.equal(pools[0].isActive, true);
  assert.equal(pools[0].buckets[0].label, '每周');
  assert.equal(pools[0].buckets[0].pct, 96);
});

test('formatShortQuotaReset formats minutes, hours, days, and boundary states cleanly', () => {
  const now = 1_700_000_000_000;
  assert.equal(helpers.formatShortQuotaReset(now - 5000, now, true), '待同步');
  assert.equal(helpers.formatShortQuotaReset(now - 5000, now, false), 'Syncing');
  assert.equal(helpers.formatShortQuotaReset(now + 20_000, now, true), '<1m');
  assert.equal(helpers.formatShortQuotaReset(now + 5_400_000, now, true), '1h30m');
  assert.equal(helpers.formatShortQuotaReset(now + (6 * 86400 + 20 * 3600) * 1000, now, true), '6d20h');
});
