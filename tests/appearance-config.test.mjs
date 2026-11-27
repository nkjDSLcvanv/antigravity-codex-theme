import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_APPEARANCE, MAX_WALLPAPER_BYTES, normalizeAppearanceConfig, normalizeThemePreset } from '../core/appearance.mjs';
import { sanitizeConfigPatch } from '../core/daemon/paths.mjs';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8hQAAAAASUVORK5CYII=';

test('Appearance settings retain legacy presets and merge independent updates', () => {
  assert.equal(normalizeThemePreset('onyx-dark'), 'codex-dark');
  assert.equal(normalizeThemePreset('unknown'), 'codex-pure-white');
  assert.deepEqual(normalizeAppearanceConfig(), DEFAULT_APPEARANCE);

  const config = { preset: 'claude', appearance: { wallpaper: png, surfaceOpacity: 72, composerMotion: false } };
  const motion = sanitizeConfigPatch(config, { preset: 'unknown', appearance: { composerMotion: true } });
  assert.equal(motion.preset, 'claude');
  assert.deepEqual(motion.appearance, { ...config.appearance, composerMotion: true });
  assert.equal(config.appearance.composerMotion, false);

  const result = sanitizeConfigPatch(motion, { preset: 'typora', appearance: { wallpaper: '', surfaceOpacity: 2 } });
  assert.equal(result.preset, 'typora');
  assert.deepEqual(result.appearance, { wallpaper: '', surfaceOpacity: 60, composerMotion: true });
  assert.equal(normalizeAppearanceConfig({ surfaceOpacity: 100.5 }).surfaceOpacity, 100);
});

test('Wallpaper preferences accept only bounded raster image data', () => {
  assert.equal(normalizeAppearanceConfig({ wallpaper: png }).wallpaper, png);
  for (const wallpaper of [
    'https://example.test/background.png',
    'file:///tmp/background.png',
    'data:image/svg+xml;base64,PHN2Zz4=',
    png.replace('/png;', '/jpeg;'),
    png + '"',
    'data:image/png;base64,' + Buffer.alloc(MAX_WALLPAPER_BYTES + 1).toString('base64')
  ]) {
    assert.equal(normalizeAppearanceConfig({ wallpaper }).wallpaper, '');
    assert.throws(() => sanitizeConfigPatch({}, { appearance: { wallpaper } }), /Wallpaper must be/);
  }
});

test('The bundle hot-reloads appearance state and safe mode uses the default appearance', async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-appearance-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  fs.cpSync(new URL('../core', import.meta.url), path.join(tmpDir, 'core'), { recursive: true });
  const { createBundleController } = await import(pathToFileURL(path.join(tmpDir, 'core/daemon/paths.mjs')).href);

  const ctrl = createBundleController();
  ctrl.rebuildBundleIfNeeded();
  const original = ctrl.getState();
  const patch = { preset: 'vscode', appearance: { wallpaper: png, surfaceOpacity: 70, composerMotion: true } };
  assert.equal(ctrl.updateUserConfig(patch).ok, true);
  const updated = ctrl.getState();
  assert.notEqual(updated.cachedPatchVersion, original.cachedPatchVersion);
  assert.equal(updated.activeConfig.preset, 'vscode');
  assert.deepEqual(updated.activeConfig.appearance, { wallpaperSet: true, surfaceOpacity: 70, composerMotion: true });
  assert.ok(updated.cachedInjectScript.includes(png));

  assert.equal(ctrl.updateUserConfig({ appearance: { wallpaper: 'file:///tmp/image.png' } }).ok, false);
  assert.equal(ctrl.getState().cachedPatchVersion, updated.cachedPatchVersion);
  assert.equal(ctrl.updateUserConfig({ modules: { theme: false } }).ok, true);
  assert.ok(!ctrl.getState().cachedInjectScript.includes(png));
  assert.equal(ctrl.getState().activeConfig.appearance.wallpaperSet, true);

  const safe = createBundleController({ safeMode: true });
  safe.rebuildBundleIfNeeded();
  assert.equal(safe.getState().activeConfig.preset, 'codex-pure-white');
  assert.deepEqual(safe.getState().activeConfig.appearance, { wallpaperSet: false, surfaceOpacity: 85, composerMotion: false });
  assert.ok(!safe.getState().cachedInjectScript.includes(png));

  await t.test('A delayed wallpaper import preserves an out-of-band wallpaper edit', () => {
    const expectedWallpaperRevision = ctrl.readWallpaperRevision();
    assert.ok(expectedWallpaperRevision);
    assert.equal(ctrl.updateUserConfig({ preset: 'typora' }).ok, true);
    assert.equal(ctrl.readWallpaperRevision(), expectedWallpaperRevision);

    const configPath = path.join(tmpDir, 'user', 'config.json');
    const manual = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    manual.appearance.wallpaper = '';
    fs.writeFileSync(configPath, JSON.stringify(manual));
    assert.deepEqual(ctrl.updateUserConfig({ appearance: { wallpaper: png } }, { expectedWallpaperRevision }), {
      ok: false, error: 'wallpaper_import_superseded'
    });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).appearance.wallpaper, '');
  });
});
