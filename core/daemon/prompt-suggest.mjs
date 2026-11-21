/**
 * core/daemon/prompt-suggest.mjs — Claude Code-style Background Prompt Suggestion Engine
 *
 * Uses a persistent `agy --input-format stream-json --output-format stream-json`
 * worker powered by the user's Antigravity account (zero external API key,
 * zero sidebar conversation pollution, prompt-cache accelerated).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const MAX_TURNS_PER_WORKER = 40;
const WARMUP_TIMEOUT_MS = 75000;
const TURN_TIMEOUT_MS = 30000;
const CACHE_LIMIT = 100;

export const PROMPT_SUGGEST_SYSTEM_INSTRUCTION = [
  '你是一个聊天输入框的「下一句提示词预测器」（类似 Claude Code 的 Prompt Suggestions）。',
  '我会给你一段刚结束的对话片段（用户的上一条消息 + 助手的最新回复）。',
  '请站在「用户」的视角，预测用户下一步最可能、最自然想发出的那一句简短指令或追问。',
  '严格遵守以下规则：',
  '1. 只输出预测的那一句话本身，不要任何前缀、引号、解释、编号、Markdown 标记或换行。',
  '2. 保持与用户语言一致，控制在 4~28 个字以内，具体且可直接执行。',
  '3. 如果助手的回复已经是一个完整句号、或上下文没有明显高把握的下一步动作，直接输出 NONE（不要硬编废话）。',
  '4. 绝对不要调用任何工具，直接输出文本。'
].join('\n');

export function cleanPromptSuggestionText(raw) {
  if (!raw) return '';
  let text = String(raw)
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!text) return '';
  text = text
    .replace(/^["'“”‘’`⟫>:\-\s]+/, '')
    .replace(/["'“”‘’`]+$/, '')
    .trim();
  if (!text || /^none$/i.test(text) || /^无$/i.test(text) || text.length < 2 || text.length > 60) {
    return '';
  }
  return text;
}

export function resolveAgyCliBinary({ platform = process.platform, env = process.env, homedir = os.homedir() } = {}) {
  const isWin = platform === 'win32';
  const candidates = [
    env.AGY_BIN,
    ...(isWin
      ? [
          path.join(homedir, '.local', 'bin', 'agy.exe'),
          path.join(homedir, '.local', 'bin', 'agy.cmd'),
          path.join(env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'bin', 'agy.exe')
        ]
      : [
          path.join(homedir, '.local', 'bin', 'agy'),
          '/opt/homebrew/bin/agy',
          '/usr/local/bin/agy'
        ])
  ].filter(Boolean);

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }

  try {
    const probe = spawnSync(isWin ? 'where' : 'which', ['agy'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true
    });
    if (probe.status === 0) {
      const found = String(probe.stdout || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (found) return found;
    }
  } catch {}

  return '';
}

export function createPromptSuggestionEngine({ getConfig, runOnce = false, resolveBin = resolveAgyCliBinary } = {}) {
  let agyBinCache = undefined;
  let proc = null;
  let activeModel = '';
  let ready = false;
  let warmed = false;
  let turns = 0;
  let buf = '';
  let pending = null;
  let starting = false;
  const queue = [];
  const cache = new Map();

  function getAgyBin() {
    if (agyBinCache !== undefined) return agyBinCache;
    agyBinCache = resolveBin() || '';
    return agyBinCache;
  }

  function isEnabled() {
    if (runOnce) return false;
    const cfg = typeof getConfig === 'function' ? getConfig() : null;
    return Boolean(cfg && cfg.enabled !== false && cfg.modules && cfg.modules.promptSuggestions);
  }

  function getTargetModel() {
    const cfg = typeof getConfig === 'function' ? getConfig() : null;
    const m = cfg && typeof cfg.promptSuggestionModel === 'string' ? cfg.promptSuggestionModel.trim() : '';
    return m || 'gemini-3.8-flash-low';
  }

  function stop() {
    const old = proc;
    proc = null;
    ready = false;
    warmed = false;
    turns = 0;
    if (pending) {
      const cur = pending;
      pending = null;
      clearTimeout(cur.timer);
      if (!cur.settled) {
        cur.settled = true;
        cur.resolve('');
      }
    }
    while (queue.length > 0) {
      const dropped = queue.shift();
      dropped.resolve('');
    }
    if (old) {
      try {
        old.stdin.end();
        old.kill('SIGTERM');
      } catch {}
    }
  }

  function restart() {
    stop();
    if (isEnabled()) {
      setTimeout(() => ensureStarted(), 300);
    }
  }

  function sendWarmup() {
    if (pending || warmed || !proc) return;
    const warmupPrompt = `${PROMPT_SUGGEST_SYSTEM_INSTRUCTION}\n\n收到以上规则请只回复：OK`;
    const timer = setTimeout(() => {
      if (pending && pending.isWarmup) {
        pending = null;
        restart();
      }
    }, WARMUP_TIMEOUT_MS);

    pending = {
      isWarmup: true,
      settled: true,
      chunks: [],
      resolve: () => {},
      timer
    };

    try {
      proc.stdin.write(JSON.stringify({ event: 'user', message: { content: warmupPrompt } }) + '\n');
    } catch {
      clearTimeout(timer);
      pending = null;
      restart();
    }
  }

  function drain() {
    if (pending || !warmed || queue.length === 0) return;
    if (!proc || proc.killed || proc.exitCode !== null) {
      ensureStarted();
      return;
    }
    const item = queue.shift();
    const timer = setTimeout(() => {
      if (pending && pending.resolve === item.resolve) {
        const cur = pending;
        pending = null;
        if (!cur.settled) {
          cur.settled = true;
          item.resolve('');
        }
        restart();
      }
    }, TURN_TIMEOUT_MS);

    pending = {
      isWarmup: false,
      settled: false,
      chunks: [],
      resolve: item.resolve,
      timer
    };

    try {
      proc.stdin.write(JSON.stringify({ event: 'user', message: { content: item.promptText } }) + '\n');
    } catch {
      clearTimeout(timer);
      pending = null;
      item.resolve('');
      restart();
    }
  }

  function ensureStarted() {
    const model = getTargetModel();
    if (proc && !proc.killed && proc.exitCode === null) {
      if (activeModel === model) return true;
      stop();
    }
    if (starting) return true;
    const bin = getAgyBin();
    if (!bin) return false;

    starting = true;
    activeModel = model;
    ready = false;
    warmed = false;
    turns = 0;
    buf = '';

    let child;
    try {
      const extraPath =
        process.platform === 'win32'
          ? ''
          : `${path.join(os.homedir(), '.local', 'bin')}:/opt/homebrew/bin:/usr/local/bin:`;
      child = spawn(
        bin,
        [
          '--model',
          model,
          '--effort',
          'low',
          '--disable-slash-commands',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json'
        ],
        {
          cwd: os.tmpdir(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: {
            ...process.env,
            PATH: extraPath ? `${extraPath}${process.env.PATH || ''}` : process.env.PATH
          }
        }
      );
    } catch {
      starting = false;
      return false;
    }

    proc = child;
    starting = false;

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.event === 'init') {
          ready = true;
          sendWarmup();
        } else if (evt.event === 'step_update') {
          const su = evt.step_update;
          if (su && su.step_type === 'agent_response' && pending) {
            if (su.text_delta) pending.chunks.push(String(su.text_delta));
            if (su.state === 'DONE' && !pending.settled && pending.chunks.length > 0) {
              pending.settled = true;
              pending.resolve(pending.chunks.join('').trim());
            }
          }
        } else if (evt.event === 'result') {
          const cur = pending;
          pending = null;
          if (cur) {
            clearTimeout(cur.timer);
            if (!cur.settled) {
              cur.settled = true;
              const raw = String((evt.result && evt.result.response) || cur.chunks.join('') || '').trim();
              cur.resolve(raw);
            }
          }
          if (!warmed) {
            warmed = true;
          } else {
            turns += 1;
          }
          if (turns >= MAX_TURNS_PER_WORKER) {
            restart();
          } else {
            drain();
          }
        }
      }
    });

    child.on('error', () => stop());
    child.on('exit', () => {
      ready = false;
      warmed = false;
      proc = null;
      if (pending) {
        const cur = pending;
        pending = null;
        clearTimeout(cur.timer);
        if (!cur.settled) {
          cur.settled = true;
          cur.resolve('');
        }
      }
      if (queue.length > 0 && isEnabled()) {
        setTimeout(() => ensureStarted(), 800);
      }
    });

    return true;
  }

  function syncState() {
    if (!isEnabled()) {
      stop();
      return;
    }
    ensureStarted();
  }

  async function suggest({ fingerprint = '', lastUser = '', lastAssistant = '' } = {}) {
    if (!isEnabled() || !lastAssistant) return '';
    if (fingerprint && cache.has(fingerprint)) {
      return cache.get(fingerprint);
    }
    const promptText = [
      '根据以下刚结束的对话片段，输出用户下一步最可能发的简短指令（4~28字，无解释无引号，若无高把握输出 NONE）：',
      lastUser ? `用户：${lastUser}` : '',
      `助手：${lastAssistant}`
    ]
      .filter(Boolean)
      .join('\n');

    const raw = await new Promise((resolve) => {
      if (!ensureStarted()) {
        resolve('');
        return;
      }
      while (queue.length > 0) {
        const dropped = queue.shift();
        dropped.resolve('');
      }
      queue.push({ promptText, resolve });
      if (warmed) drain();
    });

    const suggestion = cleanPromptSuggestionText(raw);
    if (fingerprint) {
      if (cache.size >= CACHE_LIMIT) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }
      cache.set(fingerprint, suggestion);
    }
    return suggestion;
  }

  return {
    syncState,
    suggest,
    stop,
    getStatus: () => ({ ready, warmed, turns, cacheSize: cache.size })
  };
}
