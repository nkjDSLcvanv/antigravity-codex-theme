/**
 * tests/features-bundle.test.mjs — Selective Feature Selection & Bundle Isolation Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  parseFeatureSelection,
  getSparseCheckoutPaths,
  getExcludedCoreRelPaths
} from '../core/installer/features.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

test('parseFeatureSelection resolves --only and --without flags cleanly', () => {
  const defaultSel = parseFeatureSelection();
  assert.equal(defaultSel.explicit, false);
  assert.deepEqual(defaultSel.selected, {
    theme: true,
    i18n: true,
    metrics: true,
    fixes: true,
    suggest: false
  });

  const onlyI18n = parseFeatureSelection({ onlyArg: 'i18n,metrics' });
  assert.equal(onlyI18n.explicit, true);
  assert.deepEqual(onlyI18n.selected, {
    theme: false,
    i18n: true,
    metrics: true,
    fixes: false,
    suggest: false
  });
  assert.deepEqual(onlyI18n.modulesPatch, {
    theme: false,
    i18n: true,
    metrics: true,
    deadlockHealer: false,
    zoomShortcuts: false,
    promptSuggestions: false
  });

  const onlySuggest = parseFeatureSelection({ onlyArg: 'i18n,suggest' });
  assert.equal(onlySuggest.selected.suggest, true);
  assert.equal(onlySuggest.modulesPatch.promptSuggestions, true);

  const withoutMetrics = parseFeatureSelection({ withoutArg: 'metrics,fixes' });
  assert.equal(withoutMetrics.explicit, true);
  assert.deepEqual(withoutMetrics.selected, {
    theme: true,
    i18n: true,
    metrics: false,
    fixes: false,
    suggest: false
  });

  assert.throws(() => parseFeatureSelection({ onlyArg: 'nonexistent' }), /Unknown feature/);
});

test('getSparseCheckoutPaths and getExcludedCoreRelPaths partition modules accurately', () => {
  const onlyI18n = parseFeatureSelection({ onlyArg: 'i18n' });
  const paths = getSparseCheckoutPaths(onlyI18n.selected);
  assert.ok(paths.includes('/core/i18n.json'));
  assert.ok(paths.includes('/core/runtime/60-i18n-engine.js'));
  assert.ok(paths.includes('/core/styles/45-settings-ui.css'));
  assert.ok(paths.includes('/core/runtime/75-settings-ui.js'));
  assert.ok(paths.includes('/core/daemon/updater.mjs'));
  assert.ok(paths.includes('/core/appearance.mjs'));
  assert.ok(!paths.includes('/core/styles/10-light-codex.css'));
  assert.ok(!paths.includes('/core/styles/25-appearance.css'));
  assert.ok(!paths.includes('/core/runtime/50-telemetry-ui.js'));

  const themePaths = getSparseCheckoutPaths(parseFeatureSelection({ onlyArg: 'theme' }).selected);
  assert.ok(themePaths.includes('/core/styles/25-appearance.css'));

  const excluded = getExcludedCoreRelPaths(onlyI18n.selected);
  assert.ok(excluded.includes('styles/10-light-codex.css'));
  assert.ok(excluded.includes('styles/25-appearance.css'));
  assert.ok(excluded.includes('runtime/50-telemetry-ui.js'));
  assert.ok(!excluded.includes('i18n.json'));
});

test('Assembled partial runtime bundles execute without ReferenceError when optional parts are omitted', () => {
  const runtimeDir = path.join(ROOT_DIR, 'core', 'runtime');
  const readPart = (name) => fs.readFileSync(path.join(runtimeDir, name), 'utf8');

  const scenarios = [
    {
      name: 'i18n-only',
      parts: ['00-head.js', '60-i18n-engine.js', '90-tail.js'],
      modules: { theme: false, i18n: true, metrics: false, deadlockHealer: false, zoomShortcuts: false }
    },
    {
      name: 'theme-only',
      parts: ['00-head.js', '20-theme-sync.js', '90-tail.js'],
      modules: { theme: true, i18n: false, metrics: false, deadlockHealer: false, zoomShortcuts: false }
    },
    {
      name: 'metrics-only',
      parts: ['00-head.js', '30-antigravity-probe.js', '40-status-machine.js', '50-telemetry-ui.js', '90-tail.js'],
      modules: { theme: false, i18n: false, metrics: true, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false }
    },
    {
      name: 'suggest-only',
      parts: ['00-head.js', '70-prompt-suggestions.js', '90-tail.js'],
      modules: { theme: false, i18n: false, metrics: false, promptSuggestions: true, deadlockHealer: false, zoomShortcuts: false }
    },
    {
      name: 'settings-ui',
      parts: ['00-head.js', '75-settings-ui.js', '90-tail.js'],
      modules: { theme: false, i18n: true, metrics: false, promptSuggestions: false, deadlockHealer: false, zoomShortcuts: false }
    }
  ];

  for (const sc of scenarios) {
    const styleEl = { id: 'ag-codex-theme', textContent: '', parentNode: null, remove() {} };
    const docAttrs = new Map();
    const headChildren = [];
    const headEl = {
      appendChild(el) {
        el.parentNode = headEl;
        headChildren.push(el);
      }
    };
    const bodyEl = {
      classList: { contains: () => false },
      style: { removeProperty() {} }
    };
    const fakeDocument = {
      head: headEl,
      body: bodyEl,
      hidden: false,
      documentElement: {
        style: { colorScheme: 'light', removeProperty() {} },
        setAttribute: (k, v) => docAttrs.set(k, v),
        getAttribute: (k) => docAttrs.get(k) ?? null,
        removeAttribute: (k) => docAttrs.delete(k)
      },
      getElementById(id) {
        return headChildren.find((el) => el.id === id) || null;
      },
      createElement(tag) {
        const el = {
          tagName: tag.toUpperCase(),
          id: '',
          textContent: '',
          style: {},
          setAttribute() {},
          getAttribute() { return null; },
          removeAttribute() {},
          hasAttribute() { return false; },
          addEventListener() {},
          querySelector: () => null,
          remove() {
            const idx = headChildren.indexOf(el);
            if (idx !== -1) headChildren.splice(idx, 1);
            el.parentNode = null;
          }
        };
        return el;
      },
      getElementsByTagName: (t) => (t === 'head' ? [headEl] : []),
      querySelector: () => null,
      querySelectorAll: () => [],
      createTreeWalker: () => ({ nextNode: () => false }),
      addEventListener() {},
      removeEventListener() {}
    };

    const fakeWindow = {
      location: { pathname: '/', href: 'http://127.0.0.1/', search: '' },
      navigator: { platform: 'MacIntel', onLine: true },
      history: { pushState() {}, replaceState() {} },
      addEventListener() {},
      removeEventListener() {},
      setInterval: () => 1,
      clearInterval() {},
      setTimeout: () => 1,
      clearTimeout() {},
      requestAnimationFrame: () => 1
    };
    fakeWindow.top = fakeWindow;
    fakeWindow.window = fakeWindow;
    fakeWindow.document = fakeDocument;
    fakeWindow.localStorage = { getItem: () => null, setItem() {} };
    fakeWindow.Storage = { prototype: fakeWindow.localStorage };
    fakeWindow.NodeFilter = { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 };
    fakeWindow.MutationObserver = class {
      observe() {}
      disconnect() {}
    };

    const code = sc.parts.map(readPart).join('\n');
    const boot = {
      version: '1.0.0-test',
      platform: 'darwin',
      enabled: true,
      preset: 'codex-pure-white',
      cssText: sc.modules.theme ? 'body { color: #000; }' : '',
      customCss: '',
      themeVars: {},
      i18nDict: sc.modules.i18n ? { Settings: '设置' } : {},
      modules: sc.modules,
      selectors: {},
      userConfig: { modules: sc.modules },
      customJs: ''
    };
    const sandbox = {
      ...fakeWindow,
      __AG_BOOT_PAYLOAD__: boot
    };
    sandbox.window = sandbox;
    sandbox.top = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(`const __AG_BOOT_PAYLOAD__ = globalThis.__AG_BOOT_PAYLOAD__;\n${code}`, sandbox);
    assert.equal(sandbox.__ag_patch_version, '1.0.0-test', `${sc.name} should finish booting cleanly`);
    const mountedStyle = headChildren.find((el) => el.id === 'ag-codex-theme');
    assert.ok(mountedStyle && mountedStyle.textContent.length > 0, `${sc.name} should mount #ag-codex-theme style`);
    if (!sc.modules.theme) {
      assert.equal(docAttrs.get('data-ag-preset'), undefined, `${sc.name} must not set theme preset attr`);
    } else {
      assert.equal(docAttrs.get('data-ag-preset'), 'codex-pure-white');
    }
  }
});

test('core/daemon.mjs loads cleanly in a minimal sparse copy without metrics files', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-sparse-test-'));
  try {
    const coreDst = path.join(tmpDir, 'core');
    fs.mkdirSync(path.join(coreDst, 'daemon'), { recursive: true });
    fs.mkdirSync(path.join(coreDst, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'user'), { recursive: true });
    for (const rel of [
      'core/daemon.mjs',
      'core/appearance.mjs',
      'core/shared.mjs',
      'core/daemon/paths.mjs',
      'core/daemon/cdp-bridge.mjs',
      'core/daemon/cdp-relaunch.mjs',
      'core/i18n.json',
      'core/runtime/00-head.js',
      'core/runtime/60-i18n-engine.js',
      'core/runtime/90-tail.js',
      'user/config.json'
    ]) {
      fs.copyFileSync(path.join(ROOT_DIR, rel), path.join(tmpDir, rel));
    }
    const { execFileSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `process.env.AG_DAEMON_LIBRARY = '1'; const m = await import(${JSON.stringify(
          pathToFileURL(path.join(coreDst, 'daemon.mjs')).href
        )}); console.log(JSON.stringify({ ok: true, emptyParse: m.parseConversationMetrics('x', '.') }));`
      ],
      { encoding: 'utf8' }
    );
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.emptyParse, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
