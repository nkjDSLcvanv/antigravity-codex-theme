/**
 * tests/prompt-suggestions.test.mjs — Prompt Suggestions Engine & Text Cleaning Tests
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanPromptSuggestionText,
  createPromptSuggestionEngine
} from '../core/daemon/prompt-suggest.mjs';

test('cleanPromptSuggestionText strips quotes, markers, and filters NONE or empty strings', () => {
  assert.equal(cleanPromptSuggestionText('“帮我跑一下单元测试”'), '帮我跑一下单元测试');
  assert.equal(cleanPromptSuggestionText('⟫ 提交这次改动吧\n多余第二行'), '提交这次改动吧');
  assert.equal(cleanPromptSuggestionText('NONE'), '');
  assert.equal(cleanPromptSuggestionText('none'), '');
  assert.equal(cleanPromptSuggestionText('无'), '');
  assert.equal(cleanPromptSuggestionText('a'), '');
  assert.equal(cleanPromptSuggestionText('```text\ncode\n```'), '');
});

test('createPromptSuggestionEngine degrades cleanly when disabled or agy binary is missing', async () => {
  const disabledEngine = createPromptSuggestionEngine({
    getConfig: () => ({ enabled: true, modules: { promptSuggestions: false } }),
    resolveBin: () => ''
  });
  assert.equal(
    await disabledEngine.suggest({ fingerprint: 'fp-1', lastUser: 'hi', lastAssistant: 'hello' }),
    ''
  );

  const missingBinEngine = createPromptSuggestionEngine({
    getConfig: () => ({ enabled: true, modules: { promptSuggestions: true } }),
    resolveBin: () => ''
  });
  assert.equal(
    await missingBinEngine.suggest({ fingerprint: 'fp-2', lastUser: 'hi', lastAssistant: 'hello' }),
    ''
  );
  missingBinEngine.stop();
});
