export const DEFAULT_PRESET = 'codex-pure-white';
const THEME_PRESETS = [DEFAULT_PRESET, 'codex-dark', 'claude', 'vscode', 'typora'];
export const MAX_WALLPAPER_BYTES = 3 * 1024 * 1024;
export const MIN_SURFACE_OPACITY = 60;
export const DEFAULT_APPEARANCE = Object.freeze({
  wallpaper: '',
  surfaceOpacity: 85,
  composerMotion: false
});

export function normalizeThemePreset(value, fallback = DEFAULT_PRESET) {
  const preset = typeof value === 'string' ? value.trim() : '';
  if (preset === 'onyx-dark') return 'codex-dark';
  return THEME_PRESETS.includes(preset) ? preset : fallback;
}

function validateWallpaper(value) {
  if (value === '') return value;
  if (typeof value !== 'string' || value.length > Math.ceil(MAX_WALLPAPER_BYTES / 3) * 4 + 32) return null;
  const header = /^data:image\/(png|jpeg|webp);base64,/.exec(value);
  if (!header) return null;
  const encoded = value.slice(header[0].length);
  if (!encoded || encoded.length % 4 !== 0) return null;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_WALLPAPER_BYTES || bytes.toString('base64') !== encoded) return null;

  const type = header[1];
  const valid =
    (type === 'png' && bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') ||
    (type === 'jpeg' && bytes.subarray(0, 3).toString('hex') === 'ffd8ff') ||
    (type === 'webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  return valid ? value : null;
}

export function normalizeAppearanceConfig(raw = {}, { strictWallpaper = false, previous = DEFAULT_APPEARANCE } = {}) {
  const wallpaper = validateWallpaper(raw?.wallpaper);
  if (strictWallpaper && raw?.wallpaper !== undefined && wallpaper === null) {
    throw new TypeError(`Wallpaper must be a PNG, JPEG, or WebP image up to ${MAX_WALLPAPER_BYTES / 1024 ** 2} MiB`);
  }
  return {
    wallpaper: wallpaper ?? previous.wallpaper,
    surfaceOpacity: Number.isFinite(raw?.surfaceOpacity)
      ? Math.min(100, Math.max(MIN_SURFACE_OPACITY, Math.round(raw.surfaceOpacity)))
      : previous.surfaceOpacity,
    composerMotion: typeof raw?.composerMotion === 'boolean' ? raw.composerMotion : previous.composerMotion
  };
}
