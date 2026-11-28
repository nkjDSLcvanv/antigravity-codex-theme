/**
 * Part 60: DOM Localization Engine (WeakMap-backed safe text & attribute translator)
 */
  // ============================================================================
  // 4. 高性能界面汉化引擎（无原型词典 + WeakMap O(1) 隔离缓存 + 单遍扫描 + 首字符分流）
  // ============================================================================
  if (window.__ag_i18n_observer) {
    try {
      window.__ag_i18n_observer.disconnect();
    } catch (e) {}
    window.__ag_i18n_observer = null;
  }

  const DICT = Object.assign(Object.create(null), boot.i18nDict || {});
  const LOWER_DICT = Object.create(null);
  for (const k in DICT) {
    const v = DICT[k];
    if (typeof v !== 'string' || !v || v === k) continue;
    if (!/\s/.test(k)) continue;
    const low = k.toLowerCase();
    if (LOWER_DICT[low] === undefined) {
      LOWER_DICT[low] = v;
    }
  }
  window.__ag_i18n_dict = DICT;

  let scanBodyFn = null;
  let i18nInitialScanDone = false;
  const I18N_OBS_OPTS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'placeholder']
  };

  const restoreNativeArrayMap = () => {
    if (window.__ag_orig_array_map && Array.prototype.map !== window.__ag_orig_array_map) {
      try {
        Object.defineProperty(Array.prototype, 'map', {
          value: window.__ag_orig_array_map,
          writable: true,
          configurable: true,
          enumerable: false
        });
      } catch (e) {}
    }
  };

  if (MODULES.i18n) {
    function splitTopLevelSelectors(selStr) {
      const parts = [];
      let cur = '';
      let bracketDepth = 0;
      let parenDepth = 0;
      let quote = '';
      const s = String(selStr || '');
      for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (quote) {
          cur += ch;
          if (ch === quote && s[i - 1] !== '\\') quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          cur += ch;
        } else if (ch === '[') {
          bracketDepth++;
          cur += ch;
        } else if (ch === ']') {
          if (bracketDepth > 0) bracketDepth--;
          cur += ch;
        } else if (ch === '(') {
          parenDepth++;
          cur += ch;
        } else if (ch === ')') {
          if (parenDepth > 0) parenDepth--;
          cur += ch;
        } else if (ch === ',' && bracketDepth === 0 && parenDepth === 0) {
          if (cur.trim()) parts.push(cur.trim());
          cur = '';
        } else {
          cur += ch;
        }
      }
      if (cur.trim()) parts.push(cur.trim());
      return parts;
    }

    const CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR =
      'code, pre, kbd, samp, style, script, noscript, [data-markdown-root], [data-testid="user-message-content"], .agy-user-bubble, .monaco-editor, .monaco-diff-editor, .xterm, #ag-live-metrics-pill, .ag-live-metrics-pill, #ag-live-metrics-tooltip, #ag-turn-metrics-tooltip, .ag-turn-metrics';
    const TEXT_IMMUTABLE_EXCLUDE_SELECTOR = 'textarea, input, ' + CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR;

    const mergedExcludeParts = splitTopLevelSelectors(DEFAULT_EXCLUDE_I18N);
    const userExcludeParts = splitTopLevelSelectors(SELECTORS.excludeI18n);
    for (let i = 0; i < userExcludeParts.length; i++) {
      if (!mergedExcludeParts.includes(userExcludeParts[i])) {
        mergedExcludeParts.push(userExcludeParts[i]);
      }
    }
    const EXCLUDE_SELECTOR = mergedExcludeParts.join(', ');
    const FORM_ATTR_EXCLUDE_SELECTOR = mergedExcludeParts
      .filter((tok) => {
        const low = tok.toLowerCase();
        return low !== 'input' && low !== 'textarea';
      })
      .join(', ');

    const immutableTextExclCache = new WeakMap();
    const immutableContainerExclCache = new WeakMap();

    // 预编译模块级正则常量，消除热路径重复编译与二次匹配
    const RE_HAS_CJK = /[\u4e00-\u9fa5]/;
    const RE_PURE_ALPHA = /^\s*[a-zA-Z]+\s*$/;
    const RE_HAS_ALPHA = /[a-zA-Z]/;
    const RE_REL_TIME = /^(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|mo|y|yr|yrs)\s+ago$/i;
    const REL_UNIT_MAP = {
      s: '秒',
      sec: '秒',
      secs: '秒',
      m: '分钟',
      min: '分钟',
      mins: '分钟',
      h: '小时',
      hr: '小时',
      hrs: '小时',
      d: '天',
      w: '周',
      mo: '个月',
      y: '年',
      yr: '年',
      yrs: '年'
    };
    const UNIT_MAP_SHORT = { s: '秒', m: '分钟', h: '小时', d: '天', w: '周', mo: '个月', y: '年', yr: '年' };
    const NAMED_PERIOD_MAP = { weekly: '每周', daily: '每日', monthly: '每月' };
    const MONTH_SHORT_MAP = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12
    };
    // 客户端 main.js ($Q 权限编辑器) 在 onBlur 中硬编码判断 relatedTarget.getAttribute("aria-label") === "Cancel"
    const SKIP_ARIA_LABEL_VALUES = new Set(['Cancel']);

    const RE_PCT_LEFT = /^(\d+(?:\.\d+)?)%\s*left$/i;
    const RE_WINDOW_LIMIT_COMBINED = /^(\d+)\s*([smhd])\s+limit,\s*resets in\s+(.+)$/i;
    const RE_WINDOW_LIMIT = /^(\d+)\s*([smhd])\s+limit$/i;
    const RE_NAMED_LIMIT_RESETS = /^(Weekly|Daily|Monthly)\s+limit,\s*resets in\s+(.+)$/i;
    const RE_MODEL_NAMED_LIMIT = /^(.+?)\s+(Weekly|Daily|Monthly)\s+limit$/i;
    const RE_RESETS_IN = /^Resets in\s+(.+)$/i;
    const RE_SEARCH_GOOGLE = /^Search Google for "(.+)"$/;
    const RE_UPDATED_AT =
      /^Updated\s+(?:((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}|\d{1,2}月\d{1,2}日),\s*)?((?:上午|下午)?\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)$/;

    const RE_FILES_CHANGED = /^(\d+)\s+files?\s+changed$/i;
    const RE_STEPS_CHIP = /^(\d+(?:\/\d+)?)\s+steps?$/i;
    const RE_DAYS_COUNT = /^(\d+)\s+days?$/i;
    const RE_SECONDS_COUNT = /^(\d+)\s+seconds?$/i;
    const RE_MOVE_TO_GROUP_NAMED = /^Move to Group:\s*(.+)$/i;
    const RE_REMOVE_FROM_RECENT = /^Remove\s+(.+?)\s+from\s+Recent$/i;
    const RE_SYSTEM_DEFAULT_APP = /^System default\s*\((.+)\)$/i;
    const RE_DELETE_ENTITY = /^Delete\s+(project|workspace|group|conversation)$/i;
    const RE_TOOLS = /^(\d+)\s+tools?$/i;
    const RE_DEMOTED = /^(\d+)\s+demoted$/i;
    const RE_EXCLUDED = /^(\d+)\s+excluded$/i;
    const RE_TOOLS_EXCLUDED = /^(\d+)\s+tools?\s+excluded$/i;
    const RE_ACTIVE_CONVS = /^(\d+)\s+active\s+conversations$/i;
    const RE_UPDATES_COUNT = /^(\d+)\s+updates?$/i;
    const RE_PROJECTS_COUNT = /^(\d+)\s+projects?$/i;
    const RE_CALLS_MB = /^(\d+)\s+calls?\s*·\s*([\d.]+\s*MB)$/i;
    const RE_SEE_ALL = /^See all\s*\((\d+)\)$/i;
    const RE_SHOW_BREAKDOWNS = /^Show\s+(\d+)\s+breakdowns?$/i;
    const RE_SHOW_MORE_SUBAGENTS = /^Show\s+(\d+)\s+more\s+subagents?$/i;
    const RE_ZIPPING_FOLDER = /^Zipping\s+(.+?)(?:…|\.\.\.)$/i;
    const RE_PERM_DELETE = /^Permanently delete\s+(.*)\s+including\s+(\d+)\s+active\s+conversations\.?$/i;
    const RE_WORKED_FOR_UPDATES = /^Worked for\s+([<0-9smhd\s]+?)\s*·\s*(\d+)\s+updates?$/i;
    const RE_WORKED_FOR = /^Worked for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_THOUGHT_FOR = /^Thought for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_THINKING_FOR = /^Thinking for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_RUNNING_FOR = /^Running\s+for\s+([<0-9smhd]+(?:\s+\d+[smhd])*)$/i;
    const RE_EPHEMERAL_SUMMARY =
      /^(Explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|Ran\s+(?:\d+\s+)?commands?|Edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?)(?:,\s*(explored(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?|ran\s+(?:\d+\s+)?commands?|edited(?:\s+(?:\d+\s+)?(?:files?|artifacts?)(?:\s+and\s+(?:\d+\s+)?(?:files?|artifacts?))?)?))*$/i;
    const EPHEMERAL_CLAUSE_MAP = {
      explored: '已探索',
      'explored file': '已探索文件',
      'explored files': '已探索文件',
      'explored artifact': '已探索交付工件',
      'explored artifacts': '已探索交付工件',
      'explored file and artifact': '已探索文件与交付工件',
      'explored files and artifact': '已探索文件与交付工件',
      'explored file and artifacts': '已探索文件与交付工件',
      'explored files and artifacts': '已探索文件与交付工件',
      'ran command': '已运行命令',
      'ran commands': '已运行命令',
      edited: '已编辑',
      'edited file': '已编辑文件',
      'edited files': '已编辑文件',
      'edited artifact': '已编辑交付工件',
      'edited artifacts': '已编辑交付工件',
      'edited file and artifact': '已编辑文件与交付工件',
      'edited files and artifact': '已编辑文件与交付工件',
      'edited file and artifacts': '已编辑文件与交付工件',
      'edited files and artifacts': '已编辑文件与交付工件'
    };
    const RE_EPHEMERAL_DUAL_OR_COUNT_CLAUSE =
      /^(explored|edited|ran)\s+(?:(\d+)\s+)?(files?|artifacts?|commands?)(?:\s+and\s+(?:(\d+)\s+)?(files?|artifacts?|commands?))?$/i;
    function formatEphemeralObjectZh(count, noun) {
      const lowNoun = noun.toLowerCase();
      if (count) {
        const countedMap = {
          file: '个文件',
          files: '个文件',
          artifact: '个交付工件',
          artifacts: '个交付工件',
          command: '条命令',
          commands: '条命令'
        };
        return count + ' ' + (countedMap[lowNoun] || noun);
      }
      const bareMap = {
        file: '文件',
        files: '文件',
        artifact: '交付工件',
        artifacts: '交付工件',
        command: '命令',
        commands: '命令'
      };
      return bareMap[lowNoun] || noun;
    }
    function translateEphemeralClause(clause) {
      const low = clause.trim().toLowerCase();
      if (EPHEMERAL_CLAUSE_MAP[low]) return EPHEMERAL_CLAUSE_MAP[low];
      const mCount = low.match(RE_EPHEMERAL_DUAL_OR_COUNT_CLAUSE);
      if (mCount) {
        const vMap = { explored: '已探索', edited: '已编辑', ran: '已运行' };
        const verb = vMap[mCount[1]] || mCount[1];
        const firstObj = formatEphemeralObjectZh(mCount[2], mCount[3]);
        const head = mCount[2] ? verb + ' ' + firstObj : verb + firstObj;
        if (!mCount[5]) {
          return head;
        }
        const secondObj = formatEphemeralObjectZh(mCount[4], mCount[5]);
        return head + (mCount[4] ? '和 ' : '与') + secondObj;
      }
      return clause.trim();
    }
    const RE_EPHEMERAL_ACTIVE = /^(Editing|Reading|Listing|Searching)\s+(.+)$/;
    const EPHEMERAL_VERB_MAP = {
      Editing: '正在编辑',
      Reading: '正在读取',
      Listing: '正在列出',
      Searching: '正在搜索'
    };
    const EPHEMERAL_NOUN_MAP = {
      file: '文件',
      files: '文件',
      artifact: '交付工件',
      artifacts: '交付工件',
      'file and artifact': '文件与交付工件',
      'files and artifact': '文件与交付工件',
      'file and artifacts': '文件与交付工件',
      'files and artifacts': '文件与交付工件'
    };
    const RE_EPHEMERAL_PATH_OR_CODE = /[\/\\_`"'~*@#<>[\]{}=+$]|\.\w|\.\*/;
    const RE_EPHEMERAL_SINGLE_IDENT = /^(?:[A-Z0-9_]{2,}|[a-z]+[A-Z][a-zA-Z0-9]*|[a-z0-9]+[-_][a-z0-9_-]+)$/;
    function isEphemeralCodeOrPathTarget(obj) {
      if (!obj) return false;
      if (RE_EPHEMERAL_PATH_OR_CODE.test(obj)) return true;
      if (!/\s/.test(obj) && RE_EPHEMERAL_SINGLE_IDENT.test(obj)) return true;
      return false;
    }
    function translateEphemeralActive(trimmed, contextEl) {
      if (isInHeaderOrBreadcrumb(contextEl)) return null;
      const mActive = trimmed.match(RE_EPHEMERAL_ACTIVE);
      if (!mActive) return null;
      const obj = mActive[2].trim();
      const noun = EPHEMERAL_NOUN_MAP[obj.toLowerCase()];
      if (noun) return EPHEMERAL_VERB_MAP[mActive[1]] + noun;
      if (isEphemeralCodeOrPathTarget(obj)) {
        return EPHEMERAL_VERB_MAP[mActive[1]] + ' ' + obj;
      }
      return null;
    }
    const RE_RUNNING_CMD = /^Running\s+(?!commands?\b|processes\b|for\b|\(Dev\b)(.+)$/;
    const RE_DELETED_RECORDINGS = /^Deleted\s+(\d+)\s+recordings?\s*\(([\d.]+\s*MB)\)$/i;
    const RE_DELETE_RECORDINGS_CONFIRM =
      /^This deletes\s+(\d+)\s+call recordings?\s*\(([\d.]+\s*MB)\)\s+from your machine\.\s*You can't undo this\.$/i;
    const RE_USED_LIMIT = /^You have used (some|all|most) of your (weekly|5-hour|five-hour|daily) limit,?\s*it will fully refresh in (.*)\.?$/i;
    const RE_NOT_USED_LIMIT = /^You have not used any of your (weekly|5-hour|five-hour|daily) limit\.?$/i;
    const RE_QUOTA_RESET_SWITCH =
      /^Your quota for (.+?) will reset on (.+?)\.\s*Switch to another available model to continue\.?$/i;
    const RE_QUOTA_REACHED_SWITCH =
      /^Your quota for (.+?) has been reached\.\s*Switch to another available model to continue\.?$/i;
    const RE_QUOTA_NEED_CREDITS =
      /^You need (?:at least (\d+)|more) AI Credits to send messages\.\s*To continue using (.+?) now, purchase more AI Credits\.?\s*/i;
    const RE_QUOTA_BASELINE_REFRESH =
      /^Your plan['’]s baseline quota will refresh on (.+?)\.(?=\s|$)\s*/i;
    const RE_QUOTA_ENABLE_OVERAGES =
      /^To continue using (.+?) now, enable AI Credit overages\.(?=\s|$)\s*/i;
    const RE_QUOTA_UPGRADE_PLAN =
      /^You can upgrade to a (higher )?Google AI (Ultra|Pro) plan to receive (higher|the highest) rate limits\.?$/i;

    function formatQuotaModelZh(rawModel) {
      const m = String(rawModel || '').trim();
      return !m || /^this model$/i.test(m) ? '该模型' : m;
    }

    function formatQuotaUpgradeZh(mUp) {
      const higherPrefix = mUp[1] ? '更高的 ' : ' ';
      const limitDesc = mUp[3].toLowerCase() === 'the highest' ? '最高速率配额' : '更高的配额速率限制';
      return '您可以升级到' + higherPrefix + 'Google AI ' + mUp[2] + ' 方案以获得' + limitDesc + '。';
    }

    function translateQuotaExhaustedZh(trimmed) {
      if (
        !trimmed ||
        (!trimmed.includes('quota') && !trimmed.includes('AI Credit') && !trimmed.includes('Google AI '))
      ) {
        return null;
      }
      const mUpStandalone = trimmed.match(RE_QUOTA_UPGRADE_PLAN);
      if (mUpStandalone) {
        return formatQuotaUpgradeZh(mUpStandalone);
      }
      const mReset = trimmed.match(RE_QUOTA_RESET_SWITCH);
      if (mReset) {
        const mod = formatQuotaModelZh(mReset[1]);
        return (mod === '该模型' ? '该模型' : mod + ' ') + '的配额将于 ' + mReset[2].trim() + ' 重置。请切换至其他可用模型继续。';
      }
      const mReached = trimmed.match(RE_QUOTA_REACHED_SWITCH);
      if (mReached) {
        const mod = formatQuotaModelZh(mReached[1]);
        return (mod === '该模型' ? '该模型' : mod + ' ') + '的配额已用尽。请切换至其他可用模型继续。';
      }

      let rest = trimmed;
      const parts = [];

      const mCredits = rest.match(RE_QUOTA_NEED_CREDITS);
      if (mCredits) {
        const needPart = mCredits[1] ? '至少 ' + mCredits[1] + ' ' : '更多 ';
        const mod = formatQuotaModelZh(mCredits[2]);
        parts.push(
          '发送消息需要' + needPart + 'AI 点数。如需立即继续使用' + (mod === '该模型' ? '该模型' : ' ' + mod) + '，请购买更多 AI 点数。'
        );
        rest = rest.slice(mCredits[0].length);
      }

      const mRefresh = rest.match(RE_QUOTA_BASELINE_REFRESH);
      if (mRefresh) {
        parts.push('当前方案的基础配额将于 ' + mRefresh[1].trim() + ' 刷新。');
        rest = rest.slice(mRefresh[0].length);
      }

      const mOver = rest.match(RE_QUOTA_ENABLE_OVERAGES);
      if (mOver) {
        const mod = formatQuotaModelZh(mOver[1]);
        parts.push('如需立即继续使用' + (mod === '该模型' ? '该模型' : ' ' + mod) + '，请开启 AI 点数超额抵扣。');
        rest = rest.slice(mOver[0].length);
      }

      if (parts.length === 0) return null;

      rest = rest.trim();
      if (rest) {
        const exactRest = lookupRawDict(rest) ?? (rest.endsWith('.') ? lookupRawDict(rest.slice(0, -1)) : undefined);
        if (typeof exactRest === 'string') {
          parts.push(exactRest.endsWith('。') ? exactRest : exactRest + '。');
        } else {
          const mUp = rest.match(RE_QUOTA_UPGRADE_PLAN);
          if (mUp) {
            parts.push(formatQuotaUpgradeZh(mUp));
          } else {
            parts.push(rest);
          }
        }
      }
      return parts.join('');
    }
    const RE_SWARM_FROM = /^From\s+(@?[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})$/;
    const RE_SWARM_TO = /^To\s+(@?[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})$/;
    const RE_SWARM_OF_TASKS_DONE = /^(\d+)\s+of\s+(\d+)\s+tasks?\s+done$/i;
    const RE_SWARM_OF_DONE = /^(\d+)\s+of\s+(\d+)\s+done$/i;
    const RE_SWARM_THREADS_OPEN = /^(\d+)\s+threads?\s+open$/i;
    const RE_SWARM_WAITING_ON = /^Waiting on\s+(@[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})$/i;
    const RE_SWARM_WORKING_FOR = /^Working for\s+(@[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})$/i;
    const RE_SWARM_UP_NEXT = /^Up next\s*·\s*(.+)$/i;
    const RE_SWARM_EXPORTING_PCT = /^Exporting\s+(\d+(?:\.\d+)?)%$/i;
    const RE_SWARM_RENDERING_FILE = /^Rendering\s+([^\r\n/\\]+\.[a-z0-9]{1,10})(?:…|\.\.\.)$/i;
    const RE_SWARM_DOWNLOAD_FILE = /^Download\s+([^\r\n/\\]+\.[a-z0-9]{1,10})$/i;
    const RE_SWARM_SHOW_EARLIER_POSTS = /^Show\s+(\d+)\s+earlier\s+posts?\s*\((\d+)\s+older\)$/i;
    const RE_SWARM_LOADING_EARLIER_POSTS = /^Loading earlier posts(?:…|\.\.\.)\s*\((\d+)\s+older\)$/i;
    const RE_SWARM_OPEN_HANDLE = /^Open\s+(@[a-zA-Z0-9][a-zA-Z0-9._-]{0,31})$/i;
    const RE_SWARM_GOTO_SEQ = /^Go to #(\d+) on the Board$/i;
    const RE_SUFFIX_DEFAULT = / \(default\)$/i;
    const RE_SUFFIX_EXPERIMENTAL = / \(experimental\)$/i;
    const RE_ARIA_BRANCH = /^Branch, current:\s*(.*)$/i;
    const RE_ARIA_PROJECT = /^Select project(?:, current)?:\s*(.*)$/i;
    const RE_ARIA_LOCATION = /^(?:Where the agent runs, current|Select location(?:, current)?):\s*(.*)$/i;
    const RE_ARIA_VERSION = /^Version\s+([\d.]+(?:\s*·\s*\S+)?)$/i;
    const RE_ARIA_MODEL = /^(?:Select model|Model(?:\s+selector)?)(?:,\s*current)?:\s*(.*)$/i;
    const RE_ARIA_PERM_SEL =
      /^(?:(?:Permission mode|Agent permissions preset)\s+selector(?:,\s*current)?|(?:Permission mode|Agent permissions preset),\s*current):\s*(.*)$/i;
    const RE_ARIA_PERM_FIXED = /^(?:Permission mode|Agent permissions preset):\s*([^,(]+?)(?:\s*(?:,\s*(.+?)|\(([^)]+)\)))?$/i;
    const RE_ARIA_TURN = /^(?:Conversation turn\s+(\d+)\s+by\s+(User|Agent|Assistant)|Turn\s+(\d+)\s+of\s+(\d+))$/i;
    const RE_ARIA_LOAD_OLDER = /^(?:Load\s+(\d+)\s+older\s+turns?.*|Load older messages,\s*showing\s+(\d+)\s+of\s+(\d+))$/i;
    const RE_YOUR_PLAN = /^Your Plan:\s*([^\r\n]{1,80})$/i;
    const RE_AVAILABLE_AI_CREDITS = /^Available AI Credits:\s*([^\r\n]{1,40})$/i;
    const RE_EXITED_CODE_ONLY = /^Exited with code\s+(-?\d+)(\.)?$/i;
    const RE_SUMMARY_EXITED_CODE = /^([^\r\n]{1,220}?)\s*·\s*Exited with code\s+(-?\d+)$/;
    const RE_STARTED_SIDE_QUOTE = /^Started\s+(from|during)\s+[“"](.+)[”"]$/;

    function formatCompactDurationZh(str) {
      const s = String(str || '').trim();
      if (s === '<1m' || s === '< 1m') return '不到 1 分钟';
      return s
        .replace(/(\d+)\s*d\b/gi, '$1 天')
        .replace(/(\d+)\s*h\b/gi, '$1 小时')
        .replace(/(\d+)\s*m\b/gi, '$1 分钟')
        .replace(/(\d+)\s*s\b/gi, '$1 秒')
        .replace(/\s+/g, ' ')
        .trim();
    }

    function formatUpdatedAtZh(datePart, timePart) {
      if (!datePart) return '更新于 ' + timePart.trim();
      const mEnDate = datePart.trim().match(/^([A-Za-z]{3})\s+(\d{1,2})$/);
      if (mEnDate) {
        const mNum = MONTH_SHORT_MAP[mEnDate[1].toLowerCase()];
        if (mNum) {
          return '更新于 ' + mNum + '月' + mEnDate[2] + '日 ' + timePart.trim();
        }
      }
      return '更新于 ' + datePart.trim() + ' ' + timePart.trim();
    }

    function isExcludedElement(el, batchSafeSet) {
      if (!el || el.nodeType !== 1) return true;
      if (immutableTextExclCache.get(el) === true) return true;
      if (batchSafeSet && batchSafeSet.has(el)) return false;
      if (el.closest(TEXT_IMMUTABLE_EXCLUDE_SELECTOR)) {
        if (el.isConnected) immutableTextExclCache.set(el, true);
        return true;
      }
      if (el.closest(EXCLUDE_SELECTOR)) {
        return true;
      }
      if (batchSafeSet) batchSafeSet.add(el);
      return false;
    }

    function canTranslateElementAttrs(el, batchSafeSet) {
      if (!el || el.nodeType !== 1) return false;
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (immutableContainerExclCache.get(el) === true) return false;
        if (el.closest(CONTAINER_IMMUTABLE_EXCLUDE_SELECTOR)) {
          if (el.isConnected) immutableContainerExclCache.set(el, true);
          return false;
        }
        return FORM_ATTR_EXCLUDE_SELECTOR ? !el.closest(FORM_ATTR_EXCLUDE_SELECTOR) : true;
      }
      return !isExcludedElement(el, batchSafeSet);
    }

    function isInHeaderOrBreadcrumb(el) {
      return !!(el && el.closest && el.closest('header, [data-testid="breadcrumb-segment"]'));
    }

    const BUILTIN_PROJECT_HEADER_LABELS = new Set(['Standalone', 'Archived']);
    const BUILTIN_BREADCRUMB_LABELS = new Set(['Standalone', 'Archived', 'New Conversation', 'New conversation']);

    function resolveContextualDictTranslation(trimmed, contextEl, baseVal, isAttr) {
      if (!contextEl || !contextEl.closest) return baseVal;
      const isTruncatedTooltipMirror =
        Boolean(isAttr) &&
        typeof contextEl.textContent === 'string' &&
        contextEl.textContent.trim() === trimmed;
      if (!isAttr || isTruncatedTooltipMirror) {
        if (
          !BUILTIN_PROJECT_HEADER_LABELS.has(trimmed) &&
          contextEl.closest('[data-testid="project-header"]:not([data-project-icon="archived"])')
        ) {
          return null;
        }
        if (contextEl.closest('[data-testid="conversation-group-header"]')) {
          return null;
        }
        if (
          !BUILTIN_BREADCRUMB_LABELS.has(trimmed) &&
          contextEl.closest('a[data-testid="breadcrumb-segment"][href*="project="], span[data-testid="breadcrumb-segment"]')
        ) {
          return null;
        }
      }
      if (baseVal !== undefined && !/\s/.test(trimmed)) {
        if (
          contextEl.closest(
            '[data-testid="branch-pill-trigger"], [data-testid="project-branch-picker"], [data-testid="project-selector-trigger"]'
          )
        ) {
          return null;
        }
      }
      if (trimmed === 'Plan' && baseVal === '计划' && contextEl.closest('[role="dialog"]')) {
        return '方案套餐';
      }
      if (trimmed === 'Pin' && contextEl.closest('[data-testid="conversation-pin-menu-item"]')) {
        return '置顶';
      }
      if (trimmed === 'Unpin' && contextEl.closest('[data-testid="conversation-pin-menu-item"]')) {
        return '取消置顶';
      }
      if (trimmed === 'Default') {
        if (contextEl.closest('[data-testid="permissions-default-tag"]')) {
          return '全局默认';
        }
        if (contextEl.closest('[data-testid="permissions-preset-option-default"], [data-testid="permissions-selector-trigger"]')) {
          return '敏感确认 (Default)';
        }
        const permOpt = contextEl.closest('[role="option"], [role="menuitem"]');
        const optTxt = permOpt ? permOpt.textContent || '' : '';
        if (optTxt.includes('Ask before sensitive operations') || optTxt.includes('执行敏感操作前进行确认')) {
          return '敏感确认 (Default)';
        }
      }
      if (
        trimmed === 'View' &&
        baseVal === '视图' &&
        contextEl.closest('button') &&
        !contextEl.closest('[aria-haspopup], [role="menuitem"], [role="menu"], header')
      ) {
        return '查看';
      }
      if (trimmed === 'Type' && baseVal === '类型') {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (/\band select\b|\/plan\b/i.test(pTxt)) return '键入';
      }
      if (trimmed === 'Actions' && baseVal === '操作') {
        const menuContainer = contextEl.closest('[role="menu"], [data-radix-popper-content-wrapper]');
        if (menuContainer && !contextEl.closest('[role="dialog"], [cmdk-list]')) {
          const mTxt = menuContainer.textContent || '';
          if (mTxt.includes('Mentions') || mTxt.includes('提及引用') || mTxt.includes('Add Context') || mTxt.includes('添加上下文')) {
            return '快捷指令 (/)';
          }
        }
      }
      if (trimmed === 'Machine' && baseVal === '整机') {
        const rowContainer = contextEl.closest('div') && contextEl.closest('div').parentElement;
        if (rowContainer && rowContainer.querySelector('[data-testid="new-sidecar-cloud-environment"]')) {
          return '运行主机';
        }
      }
      if (trimmed === 'Blocked' && baseVal === '已阻塞' && !contextEl.closest('[data-testid="conversation-row-sidebar"]')) {
        const aria = contextEl.getAttribute ? contextEl.getAttribute('aria-label') || '' : '';
        if (aria.startsWith('Blocked') || contextEl.closest('[class*="destructive"]')) {
          return '已受限';
        }
      }
      if (trimmed === 'when working') {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (pTxt.includes('Global Permissions') || pTxt.includes('全局权限')) return '，适用于';
      }
      if ((trimmed === 'in this project' || trimmed === 'in this workspace') && baseVal === undefined) {
        const pTxt = contextEl.parentElement ? contextEl.parentElement.textContent || '' : '';
        if (pTxt.includes('Global Permissions') || pTxt.includes('全局权限') || pTxt.includes('when working') || pTxt.includes('适用于')) {
          return trimmed === 'in this project' ? '当前项目' : '当前工作区';
        }
      }
      return baseVal;
    }

    function lookupRawDict(trimmed) {
      if (Object.prototype.hasOwnProperty.call(DICT, trimmed)) {
        return DICT[trimmed];
      }
      if (trimmed.indexOf(' ') !== -1) {
        return LOWER_DICT[trimmed.toLowerCase()];
      }
      return undefined;
    }

    function replaceTrimmed(raw, trimmed, replacement) {
      return raw.replace(trimmed, () => replacement);
    }

    function computeTextTranslation(raw, contextEl) {
      if (!raw) return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;

      // 1. 无原型静态词典 O(1) 精确匹配（多词附 Sentence/Title Case 大小写回退）+ 上下文消歧（附句尾句号自动回退；函数式 replace 防止 $&/$1 二次展开）
      let replacement = resolveContextualDictTranslation(trimmed, contextEl, lookupRawDict(trimmed), false);
      if (replacement === null) return null;
      if (typeof replacement !== 'string' && trimmed.endsWith('.')) {
        const stem = trimmed.slice(0, -1);
        const withoutDot = resolveContextualDictTranslation(stem, contextEl, lookupRawDict(stem), false);
        if (withoutDot === null) return null;
        if (typeof withoutDot === 'string') {
          replacement = withoutDot.endsWith('。') ? withoutDot : withoutDot + '。';
        }
      }
      if (typeof replacement === 'string') {
        if (RE_HAS_CJK.test(replacement) && RE_PURE_ALPHA.test(raw)) {
          return replacement;
        }
        return replaceTrimmed(raw, trimmed, replacement);
      }

      // 2. 快速短路：不含任何英文字母直接跳过动态正则
      if (!RE_HAS_ALPHA.test(trimmed)) return null;

      const isSwarmFrame = typeof IS_SWARM_PLUGIN_FRAME !== 'undefined' && IS_SWARM_PLUGIN_FRAME;

      // 3. 首字符 O(1) 分流动态正则匹配
      const c0 = trimmed.charCodeAt(0);
      if (c0 >= 48 && c0 <= 57) {
        // 以数字 '0'-'9' 开头
        const mPct = trimmed.match(RE_PCT_LEFT);
        if (mPct) return replaceTrimmed(raw, trimmed, mPct[1] + '% 剩余');
        const mWinComb = trimmed.match(RE_WINDOW_LIMIT_COMBINED);
        if (mWinComb) {
          const u = UNIT_MAP_SHORT[mWinComb[2].toLowerCase()] || mWinComb[2];
          return replaceTrimmed(raw, trimmed, mWinComb[1] + ' ' + u + '限额，' + formatCompactDurationZh(mWinComb[3]) + '后重置');
        }
        const mWin = trimmed.match(RE_WINDOW_LIMIT);
        if (mWin) {
          const u = UNIT_MAP_SHORT[mWin[2].toLowerCase()] || mWin[2];
          return replaceTrimmed(raw, trimmed, mWin[1] + ' ' + u + '限额');
        }
        const mRel = trimmed.match(RE_REL_TIME);
        if (mRel) {
          const unit = REL_UNIT_MAP[mRel[2].toLowerCase()] || mRel[2];
          return replaceTrimmed(raw, trimmed, mRel[1] + ' ' + unit + '前');
        }
        const mTasksDone = trimmed.match(RE_SWARM_OF_TASKS_DONE);
        if (mTasksDone) return replaceTrimmed(raw, trimmed, '已完成 ' + mTasksDone[1] + ' / ' + mTasksDone[2] + ' 项任务');
        const mOfDone = trimmed.match(RE_SWARM_OF_DONE);
        if (mOfDone) return replaceTrimmed(raw, trimmed, '已完成 ' + mOfDone[1] + ' / ' + mOfDone[2]);
        const mThreadsOpen = trimmed.match(RE_SWARM_THREADS_OPEN);
        if (mThreadsOpen) return replaceTrimmed(raw, trimmed, mThreadsOpen[1] + ' 个进行中的话题');
        const mUpdCnt = trimmed.match(RE_UPDATES_COUNT);
        if (mUpdCnt) return replaceTrimmed(raw, trimmed, mUpdCnt[1] + ' 条进展');
        const mSteps = trimmed.match(RE_STEPS_CHIP);
        if (mSteps) return replaceTrimmed(raw, trimmed, mSteps[1] + ' 步');
        const mDays = trimmed.match(RE_DAYS_COUNT);
        if (mDays) return replaceTrimmed(raw, trimmed, mDays[1] + ' 天');
        const mSecs = trimmed.match(RE_SECONDS_COUNT);
        if (mSecs) return replaceTrimmed(raw, trimmed, mSecs[1] + ' 秒');
        const mFilesChg = trimmed.match(RE_FILES_CHANGED);
        if (mFilesChg) return replaceTrimmed(raw, trimmed, mFilesChg[1] + ' 个文件变更');
        const mTools = trimmed.match(RE_TOOLS);
        if (mTools) return replaceTrimmed(raw, trimmed, mTools[1] + ' 个工具');
        const mDemoted = trimmed.match(RE_DEMOTED);
        if (mDemoted) return replaceTrimmed(raw, trimmed, mDemoted[1] + ' 项已降级');
        const mExcluded = trimmed.match(RE_EXCLUDED);
        if (mExcluded) return replaceTrimmed(raw, trimmed, mExcluded[1] + ' 项已排除');
        const mToolsExcl = trimmed.match(RE_TOOLS_EXCLUDED);
        if (mToolsExcl) return replaceTrimmed(raw, trimmed, mToolsExcl[1] + ' 个工具已排除');
        const mActiveConvs = trimmed.match(RE_ACTIVE_CONVS);
        if (mActiveConvs) return replaceTrimmed(raw, trimmed, mActiveConvs[1] + ' 个进行中的会话');
        const mProjects = trimmed.match(RE_PROJECTS_COUNT);
        if (mProjects) return replaceTrimmed(raw, trimmed, mProjects[1] + ' 个项目');
        const mCallsMb = trimmed.match(RE_CALLS_MB);
        if (mCallsMb) return replaceTrimmed(raw, trimmed, mCallsMb[1] + ' 次通话 · ' + mCallsMb[2]);
        return null;
      }

      const firstUpper = trimmed[0].toUpperCase();
      if (firstUpper === 'S') {
        const mSeeAll = trimmed.match(RE_SEE_ALL);
        if (mSeeAll) return replaceTrimmed(raw, trimmed, '查看全部 (' + mSeeAll[1] + ')');
        const mBreakdowns = trimmed.match(RE_SHOW_BREAKDOWNS);
        if (mBreakdowns) return replaceTrimmed(raw, trimmed, '展开明细 (' + mBreakdowns[1] + ' 项)');
        const mMoreSub = trimmed.match(RE_SHOW_MORE_SUBAGENTS);
        if (mMoreSub) return replaceTrimmed(raw, trimmed, '显示另外 ' + mMoreSub[1] + ' 个子智能体');
        const mEarlierPosts = trimmed.match(RE_SWARM_SHOW_EARLIER_POSTS);
        if (mEarlierPosts) {
          return replaceTrimmed(raw, trimmed, '显示更早的 ' + mEarlierPosts[1] + ' 条发言（还有 ' + mEarlierPosts[2] + ' 条更早）');
        }
        const mSearchGoogle = trimmed.match(RE_SEARCH_GOOGLE);
        if (mSearchGoogle) return replaceTrimmed(raw, trimmed, '使用 Google 搜索“' + mSearchGoogle[1] + '”');
        const mSysDef = trimmed.match(RE_SYSTEM_DEFAULT_APP);
        if (mSysDef) return replaceTrimmed(raw, trimmed, '系统默认（' + mSysDef[1].trim() + '）');
        const activeSearch = translateEphemeralActive(trimmed, contextEl);
        if (activeSearch) return replaceTrimmed(raw, trimmed, activeSearch);
      } else if (firstUpper === 'P') {
        const mPermDel = trimmed.match(RE_PERM_DELETE);
        if (mPermDel) {
          return replaceTrimmed(raw, trimmed, '永久删除 ' + mPermDel[1] + ' 及 ' + mPermDel[2] + ' 个进行中的会话。');
        }
      } else if (firstUpper === 'W' || firstUpper === 'M') {
        if (firstUpper === 'M') {
          const mMoveGrp = trimmed.match(RE_MOVE_TO_GROUP_NAMED);
          if (mMoveGrp) return replaceTrimmed(raw, trimmed, '移至分组：' + mMoveGrp[1].trim());
        }
        const mNamed = trimmed.match(RE_NAMED_LIMIT_RESETS);
        if (mNamed) {
          const pZh = NAMED_PERIOD_MAP[mNamed[1].toLowerCase()] || mNamed[1];
          return replaceTrimmed(raw, trimmed, pZh + '限额，' + formatCompactDurationZh(mNamed[2]) + '后重置');
        }
        if (firstUpper === 'W') {
          const mWaitingOn = trimmed.match(RE_SWARM_WAITING_ON);
          if (mWaitingOn) return replaceTrimmed(raw, trimmed, '等待 ' + mWaitingOn[1]);
          const mWorkingFor = trimmed.match(RE_SWARM_WORKING_FOR);
          if (mWorkingFor) return replaceTrimmed(raw, trimmed, '正在为 ' + mWorkingFor[1] + ' 工作');
          const mWorkedUpd = trimmed.match(RE_WORKED_FOR_UPDATES);
          if (mWorkedUpd) {
            return replaceTrimmed(raw, trimmed, '已工作 ' + mWorkedUpd[1].trim() + ' · ' + mWorkedUpd[2] + ' 条进展');
          }
          const mWorked = trimmed.match(RE_WORKED_FOR);
          if (mWorked) return replaceTrimmed(raw, trimmed, '已工作 ' + mWorked[1]);
        }
      } else if (firstUpper === 'T') {
        const mThought = trimmed.match(RE_THOUGHT_FOR);
        if (mThought) return replaceTrimmed(raw, trimmed, '已思考 ' + mThought[1]);
        const mThinking = trimmed.match(RE_THINKING_FOR);
        if (mThinking) return replaceTrimmed(raw, trimmed, '正在思考 ' + mThinking[1]);
        const mSwarmTo = trimmed.match(RE_SWARM_TO);
        if (mSwarmTo && (isSwarmFrame || mSwarmTo[1].startsWith('@'))) {
          return replaceTrimmed(raw, trimmed, '发给 ' + mSwarmTo[1]);
        }
        const mDelRec = trimmed.match(RE_DELETE_RECORDINGS_CONFIRM);
        if (mDelRec) {
          return replaceTrimmed(raw, trimmed, '这将从您的设备中删除 ' + mDelRec[1] + ' 条通话录音（' + mDelRec[2] + '），此操作无法撤销。');
        }
        const mQuotaT = translateQuotaExhaustedZh(trimmed);
        if (mQuotaT) return replaceTrimmed(raw, trimmed, mQuotaT);
      } else if (firstUpper === 'F') {
        const mSwarmFrom = trimmed.match(RE_SWARM_FROM);
        if (mSwarmFrom && (isSwarmFrame || mSwarmFrom[1].startsWith('@'))) {
          return replaceTrimmed(raw, trimmed, '来自 ' + mSwarmFrom[1]);
        }
      } else if (firstUpper === 'O') {
        const mOpenHandle = trimmed.match(RE_SWARM_OPEN_HANDLE);
        if (mOpenHandle) return replaceTrimmed(raw, trimmed, '打开 ' + mOpenHandle[1]);
      } else if (firstUpper === 'G') {
        const mGoBoard = trimmed.match(RE_SWARM_GOTO_SEQ);
        if (mGoBoard) return replaceTrimmed(raw, trimmed, '跳转到看板中的 #' + mGoBoard[1]);
      } else if (firstUpper === 'E' || firstUpper === 'R' || firstUpper === 'L') {
        if (firstUpper === 'E') {
          const mExportPct = trimmed.match(RE_SWARM_EXPORTING_PCT);
          if (mExportPct) return replaceTrimmed(raw, trimmed, '正在导出 ' + mExportPct[1] + '%');
        }
        if (firstUpper === 'L') {
          const mLoadEarlier = trimmed.match(RE_SWARM_LOADING_EARLIER_POSTS);
          if (mLoadEarlier) return replaceTrimmed(raw, trimmed, '正在加载更早的发言…（还有 ' + mLoadEarlier[1] + ' 条更早）');
        }
        if (firstUpper === 'R') {
          const mRenderFile = trimmed.match(RE_SWARM_RENDERING_FILE);
          if (mRenderFile) return replaceTrimmed(raw, trimmed, '正在渲染 ' + mRenderFile[1] + '…');
          const mRemRecent = trimmed.match(RE_REMOVE_FROM_RECENT);
          if (mRemRecent) {
            return replaceTrimmed(raw, trimmed, '从最近记录移除 ' + mRemRecent[1].trim());
          }
          const mResets = trimmed.match(RE_RESETS_IN);
          if (mResets) {
            return replaceTrimmed(raw, trimmed, formatCompactDurationZh(mResets[1]) + '后重置');
          }
        }
        if (RE_EPHEMERAL_SUMMARY.test(trimmed)) {
          const translatedSummary = trimmed
            .split(/,\s*/)
            .map((part) => translateEphemeralClause(part))
            .join('、');
          return replaceTrimmed(raw, trimmed, translatedSummary);
        }
        const activeEphemeral = translateEphemeralActive(trimmed, contextEl);
        if (activeEphemeral) {
          return replaceTrimmed(raw, trimmed, activeEphemeral);
        }
        if (firstUpper === 'R') {
          const mRunFor = trimmed.match(RE_RUNNING_FOR);
          if (mRunFor) {
            return replaceTrimmed(raw, trimmed, '已运行 ' + mRunFor[1]);
          }
          if (!isInHeaderOrBreadcrumb(contextEl)) {
            const mRunCmd = trimmed.match(RE_RUNNING_CMD);
            if (mRunCmd) return replaceTrimmed(raw, trimmed, '正在运行 ' + mRunCmd[1]);
          }
        }
      } else if (firstUpper === 'D') {
        const mDelEnt = trimmed.match(RE_DELETE_ENTITY);
        if (mDelEnt) {
          const entMap = { project: '项目', workspace: '工作区', group: '分组', conversation: '对话' };
          return replaceTrimmed(raw, trimmed, '删除' + (entMap[mDelEnt[1].toLowerCase()] || mDelEnt[1]));
        }
        const mNamedD = trimmed.match(RE_NAMED_LIMIT_RESETS);
        if (mNamedD) {
          const pZh = NAMED_PERIOD_MAP[mNamedD[1].toLowerCase()] || mNamedD[1];
          return replaceTrimmed(raw, trimmed, pZh + '限额，' + formatCompactDurationZh(mNamedD[2]) + '后重置');
        }
        const mDelRecs = trimmed.match(RE_DELETED_RECORDINGS);
        if (mDelRecs) {
          return replaceTrimmed(raw, trimmed, '已删除 ' + mDelRecs[1] + ' 条录音 (' + mDelRecs[2] + ')');
        }
        const mDlFile = trimmed.match(RE_SWARM_DOWNLOAD_FILE);
        if (mDlFile) {
          return replaceTrimmed(raw, trimmed, '下载 ' + mDlFile[1]);
        }
      } else if (firstUpper === 'V') {
        const mVerTxt = trimmed.match(RE_ARIA_VERSION);
        if (mVerTxt) {
          return replaceTrimmed(raw, trimmed, '版本 ' + mVerTxt[1].trim());
        }
      } else if (firstUpper === 'U') {
        const mUpNext = trimmed.match(RE_SWARM_UP_NEXT);
        if (mUpNext) {
          return replaceTrimmed(raw, trimmed, '接下来 · ' + mUpNext[1].trim());
        }
        const mUpd = trimmed.match(RE_UPDATED_AT);
        if (mUpd) {
          return replaceTrimmed(raw, trimmed, formatUpdatedAtZh(mUpd[1], mUpd[2]));
        }
      } else if (firstUpper === 'Z') {
        const mZip = trimmed.match(RE_ZIPPING_FOLDER);
        if (mZip) {
          return replaceTrimmed(raw, trimmed, '正在打包 ' + mZip[1] + '…');
        }
      } else if (firstUpper === 'Y') {
        const mPlan = trimmed.match(RE_YOUR_PLAN);
        if (mPlan) {
          return replaceTrimmed(raw, trimmed, '当前套餐：' + mPlan[1].trim());
        }
        const mUsed = trimmed.match(RE_USED_LIMIT);
        if (mUsed) {
          const degreeMap = { some: '部分', all: '全部', most: '大部分' };
          const typeMap = { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' };
          const degree = degreeMap[mUsed[1].toLowerCase()] || mUsed[1];
          const type = typeMap[mUsed[2].toLowerCase()] || mUsed[2];
          const timeStr = mUsed[3]
            .replace(/\.$/, '')
            .replace(/(\d+)\s*days?/gi, '$1 天')
            .replace(/(\d+)\s*hours?/gi, '$1 小时')
            .replace(/(\d+)\s*minutes?/gi, '$1 分钟')
            .replace(/(\d+)\s*seconds?/gi, '$1 秒')
            .replace(/,\s*/g, ' ')
            .trim();
          return replaceTrimmed(raw, trimmed, '您已消耗' + degree + type + '额度，将在 ' + timeStr + ' 后完全重置。');
        }
        const mNotUsed = trimmed.match(RE_NOT_USED_LIMIT);
        if (mNotUsed) {
          const typeMap = { weekly: '每周', '5-hour': '5 小时', 'five-hour': '5 小时', daily: '每日' };
          const type = typeMap[mNotUsed[1].toLowerCase()] || mNotUsed[1];
          return replaceTrimmed(raw, trimmed, '您尚未消耗任何' + type + '额度。');
        }
        const mQuotaY = translateQuotaExhaustedZh(trimmed);
        if (mQuotaY) return replaceTrimmed(raw, trimmed, mQuotaY);
      } else if (firstUpper === 'A') {
        const mCred = trimmed.match(RE_AVAILABLE_AI_CREDITS);
        if (mCred) {
          return replaceTrimmed(raw, trimmed, '可用 AI 点数：' + mCred[1].trim());
        }
      }

      if (firstUpper === 'S' && trimmed.length < 240) {
        const mSideStart = trimmed.match(RE_STARTED_SIDE_QUOTE);
        if (mSideStart) {
          const quote = mSideStart[2].trim();
          const zh = mSideStart[1] === 'during' ? '发起于「' + quote + '」期间' : '发起自「' + quote + '」';
          return replaceTrimmed(raw, trimmed, zh);
        }
      }

      if (trimmed.length < 40 && firstUpper === 'E') {
        const mExit = trimmed.match(RE_EXITED_CODE_ONLY);
        if (mExit) {
          return replaceTrimmed(raw, trimmed, '退出码 ' + mExit[1] + (mExit[2] ? '。' : ''));
        }
      }
      if (trimmed.length < 240 && trimmed.includes('Exited with code')) {
        const mSumExit = trimmed.match(RE_SUMMARY_EXITED_CODE);
        if (mSumExit) {
          return replaceTrimmed(raw, trimmed, mSumExit[1].trim() + ' · 退出码 ' + mSumExit[2]);
        }
      }

      const lastCh = trimmed.charCodeAt(trimmed.length - 1);
      if (lastCh === 41) {
        if (RE_SUFFIX_DEFAULT.test(trimmed)) {
          const base = trimmed.replace(RE_SUFFIX_DEFAULT, '').trim();
          if (base) {
            const baseZh = resolveContextualDictTranslation(base, contextEl, lookupRawDict(base), false) || base;
            return replaceTrimmed(raw, trimmed, baseZh + '（默认）');
          }
        }
        if (RE_SUFFIX_EXPERIMENTAL.test(trimmed)) {
          const base = trimmed.replace(RE_SUFFIX_EXPERIMENTAL, '').trim();
          if (base) {
            const baseZh = resolveContextualDictTranslation(base, contextEl, lookupRawDict(base), false) || base;
            return replaceTrimmed(raw, trimmed, baseZh + '（实验性）');
          }
        }
      }
      if (lastCh === 116 || lastCh === 84) {
        const mModLim = trimmed.match(RE_MODEL_NAMED_LIMIT);
        if (mModLim) {
          const pZh = NAMED_PERIOD_MAP[mModLim[2].toLowerCase()] || mModLim[2];
          return replaceTrimmed(raw, trimmed, mModLim[1].trim() + ' ' + pZh + '限额');
        }
      }

      return null;
    }

    // 拦截翻译 Electron 原生右键菜单（window.electronNative.showContextMenu 传入前由 ogb/mgb .map 构造的菜单描述符）
    const origArrayMap =
      typeof window.__ag_orig_array_map === 'function' && !window.__ag_orig_array_map.__agPatchedArrayMap
        ? window.__ag_orig_array_map
        : !Array.prototype.map.__agPatchedArrayMap
        ? Array.prototype.map
        : null;
    if (origArrayMap) {
      window.__ag_orig_array_map = origArrayMap;
    }
    const hasOwn = Object.prototype.hasOwnProperty;
    const SKIP_NATIVE_MENU_ID_RE =
      /^(?:project-(?!new$|remove$)|workspace-(?!new$|remove$)|worktree-(?!new$|remove$)|group-(?!new$|remove$)|message-timestamp$)/;

    function isNativeContextMenuEntry(item) {
      if (!item || typeof item !== 'object' || item.constructor !== Object) return false;
      if (item.type === 'separator') return true;
      return (
        (typeof item.label === 'string' || item.label === undefined) &&
        hasOwn.call(item, 'accelerator') &&
        ((hasOwn.call(item, 'checked') && hasOwn.call(item, 'disabled') && !('onClick' in item)) ||
          (hasOwn.call(item, 'click') && hasOwn.call(item, 'enabled') && typeof item.click === 'function'))
      );
    }

    function translateNativeMenuItemLabel(rawLabel, itemId) {
      if (!rawLabel || typeof rawLabel !== 'string') return rawLabel;
      if (itemId && SKIP_NATIVE_MENU_ID_RE.test(String(itemId))) return rawLabel;
      if (itemId === 'pin' && rawLabel === 'Pin') return '置顶';
      if (itemId === 'pin' && rawLabel === 'Unpin') return '取消置顶';
      const next = computeTextTranslation(rawLabel, null);
      return typeof next === 'string' ? next : rawLabel;
    }

    const patchedArrayMap = function map(callback) {
      const res =
        arguments.length > 1 ? origArrayMap.call(this, callback, arguments[1]) : origArrayMap.call(this, callback);
      if (!Array.isArray(res)) return res;
      const len = res.length;
      if (len === 0 || len > 64) return res;
      let probe = null;
      for (let i = 0; i < len; i++) {
        const cand = res[i];
        if (!cand || typeof cand !== 'object' || cand.constructor !== Object) return res;
        if (cand.type === 'separator') continue;
        probe = cand;
        break;
      }
      if (!probe || !hasOwn.call(probe, 'accelerator') || !isNativeContextMenuEntry(probe)) {
        return res;
      }
      try {
        for (let i = 0; i < len; i++) {
          const entry = res[i];
          if (entry && isNativeContextMenuEntry(entry) && typeof entry.label === 'string' && entry.label) {
            entry.label = translateNativeMenuItemLabel(entry.label, entry.id);
          }
        }
      } catch (e) {}
      return res;
    };
    patchedArrayMap.__agPatchedArrayMap = true;

    if (origArrayMap) {
      Object.defineProperty(Array.prototype, 'map', {
        value: patchedArrayMap,
        writable: true,
        configurable: true,
        enumerable: false
      });
    }
    if (Array.isArray(window.__ag_cleanup_fns)) {
      window.__ag_cleanup_fns.push(restoreNativeArrayMap);
    }

    function translateTextNode(node) {
      const currentVal = node.nodeValue;
      if (!currentVal) return;

      const rec = origTextMap.get(node);
      if (rec && rec.lastVal === currentVal && rec.ver === PATCH_VERSION) {
        return;
      }
      const origRaw = rec && rec.lastVal === currentVal ? rec.origRaw : currentVal;

      const nextVal = computeTextTranslation(origRaw, node.parentElement);
      if (nextVal !== null) {
        origTextMap.set(node, { origRaw, lastVal: nextVal, ver: PATCH_VERSION });
        if (node.nodeValue !== nextVal) {
          node.nodeValue = nextVal;
        }
      } else if (rec && rec.lastVal === currentVal) {
        node.nodeValue = origRaw;
        origTextMap.delete(node);
      }
    }

    function translateSingleAttr(el, attrName, origDataAttr, customResolver) {
      const verProp = '__ag_attr_ver_' + attrName;
      const lastDataAttr = origDataAttr + '-last';
      const cur = el.getAttribute(attrName);
      if (!cur) {
        if (el.hasAttribute(origDataAttr)) el.removeAttribute(origDataAttr);
        if (el.hasAttribute(lastDataAttr)) el.removeAttribute(lastDataAttr);
        delete el[verProp];
        return;
      }
      const savedOrig = el.getAttribute(origDataAttr);
      const savedLast = el.getAttribute(lastDataAttr);
      if (savedOrig !== null && savedLast === cur && el[verProp] === PATCH_VERSION) {
        return;
      }
      const origVal = savedOrig !== null && savedLast === cur ? savedOrig : cur;
      const trimmed = origVal.trim();
      const shouldSkipAttr = attrName === 'aria-label' && SKIP_ARIA_LABEL_VALUES.has(trimmed);
      const nextVal = shouldSkipAttr
        ? null
        : customResolver
        ? customResolver(trimmed, el)
        : typeof DICT[trimmed] === 'string'
        ? DICT[trimmed]
        : null;
      if (typeof nextVal === 'string') {
        if (savedOrig !== origVal) el.setAttribute(origDataAttr, origVal);
        if (savedLast !== nextVal) el.setAttribute(lastDataAttr, nextVal);
        el[verProp] = PATCH_VERSION;
        if (cur !== nextVal) {
          el.setAttribute(attrName, nextVal);
        }
      } else {
        if (savedOrig !== null && savedLast === cur) {
          el.setAttribute(attrName, savedOrig);
        }
        if (savedOrig !== null) el.removeAttribute(origDataAttr);
        if (savedLast !== null) el.removeAttribute(lastDataAttr);
        el[verProp] = PATCH_VERSION;
      }
    }

    function resolveAttrTranslation(atrim, el) {
      const directHit = lookupRawDict(atrim);
      if (typeof directHit === 'string') {
        const resolved = resolveContextualDictTranslation(atrim, el, directHit, true);
        return typeof resolved === 'string' ? resolved : null;
      }
      const mModel = atrim.match(RE_ARIA_MODEL);
      if (mModel) {
        let mName = mModel[1].trim();
        let noteZh = '';
        const sepMatch = mName.match(/(?:,\s+|\.\s+)/);
        if (sepMatch && sepMatch.index > 0) {
          const maybeNote = mName.slice(sepMatch.index + sepMatch[0].length).trim();
          const noteStem = maybeNote.endsWith('.') ? maybeNote.slice(0, -1).trim() : maybeNote;
          const noteHit = lookupRawDict(maybeNote) || (noteStem !== maybeNote ? lookupRawDict(noteStem) : undefined);
          if (typeof noteHit === 'string' && noteHit) {
            mName = mName.slice(0, sepMatch.index).trim();
            noteZh = '（' + noteHit + '）';
          }
        }
        if (mName === 'Select model') return '模型，当前：选择模型' + noteZh;
        return '模型，当前：' + mName + noteZh;
      }
      const lookupPerm = (s) => {
        if (s && s.toLowerCase() === 'default') return '敏感确认 (Default)';
        return lookupRawDict(s) || DICT[s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()] || s;
      };
      const mPermSel = atrim.match(RE_ARIA_PERM_SEL);
      if (mPermSel) {
        const pMode = mPermSel[1].trim();
        return '权限模式，当前：' + lookupPerm(pMode);
      }
      const mPermFixed = atrim.match(RE_ARIA_PERM_FIXED);
      if (mPermFixed) {
        const pMode = mPermFixed[1].trim();
        const rawNote = (mPermFixed[2] || mPermFixed[3] || '').trim();
        if (!rawNote) {
          return '权限模式：' + lookupPerm(pMode);
        }
        const mappedNote =
          rawNote.toLowerCase() === 'cannot be changed mid-conversation'
            ? '会话中途无法更改'
            : lookupRawDict(rawNote) || computeTextTranslation(rawNote, el) || rawNote;
        return '权限模式：' + lookupPerm(pMode) + '（' + mappedNote + '）';
      }
      const mTurn = atrim.match(RE_ARIA_TURN);
      if (mTurn) {
        if (mTurn[3] && mTurn[4]) {
          return '第 ' + mTurn[3] + ' / ' + mTurn[4] + ' 轮对话';
        }
        const roleZh = mTurn[2].toLowerCase() === 'user' ? '用户' : '智能体';
        return '第 ' + mTurn[1] + ' 轮对话（' + roleZh + '）';
      }
      const mOlder = atrim.match(RE_ARIA_LOAD_OLDER);
      if (mOlder) {
        if (mOlder[2] && mOlder[3]) {
          return '加载更早的消息（当前显示 ' + mOlder[2] + ' / ' + mOlder[3] + '）';
        }
        return '加载更早的 ' + mOlder[1] + ' 轮对话';
      }
      const mBranch = atrim.match(RE_ARIA_BRANCH);
      if (mBranch) {
        const bName = mBranch[1].trim();
        return '分支，当前：' + (bName === 'Select branch' ? '选择分支' : bName);
      }
      const mProj = atrim.match(RE_ARIA_PROJECT);
      if (mProj) {
        const pName = mProj[1].trim();
        return '选择项目，当前：' + (pName === 'No project' || pName === 'No Project' ? '未关联项目' : pName);
      }
      const mLoc = atrim.match(RE_ARIA_LOCATION);
      if (mLoc) {
        const locName = mLoc[1].trim();
        const mappedLoc =
          locName.toLowerCase() === 'this computer' ? '本机' : locName.toLowerCase() === 'remote' ? '远程' : lookupRawDict(locName) || locName;
        return '智能体运行位置，当前：' + mappedLoc;
      }
      const mVer = atrim.match(RE_ARIA_VERSION);
      if (mVer) {
        return '版本 ' + mVer[1].trim();
      }
      return computeTextTranslation(atrim, el);
    }

    function translateElementAttrs(el) {
      if (!el || el.nodeType !== 1) return;
      translateSingleAttr(el, 'title', 'data-ag-orig-title', resolveAttrTranslation);
      translateSingleAttr(el, 'placeholder', 'data-ag-orig-placeholder', resolveAttrTranslation);
      translateSingleAttr(el, 'aria-label', 'data-ag-orig-aria-label', resolveAttrTranslation);
    }

    const walkerFilter = {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node.matches && node.matches(EXCLUDE_SELECTOR)) {
            if (node.isConnected && node.matches(TEXT_IMMUTABLE_EXCLUDE_SELECTOR)) {
              immutableTextExclCache.set(node, true);
            }
            if (
              (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') &&
              canTranslateElementAttrs(node) &&
              (node.hasAttribute('title') || node.hasAttribute('aria-label') || node.hasAttribute('placeholder'))
            ) {
              translateElementAttrs(node);
            }
            return NodeFilter.FILTER_REJECT;
          }
          if (
            node.hasAttribute &&
            (node.hasAttribute('title') || node.hasAttribute('aria-label') || node.hasAttribute('placeholder'))
          ) {
            translateElementAttrs(node);
          }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    };

    function scanAndTranslate(root = document.body) {
      if (!root) return;
      if (root.nodeType === 3) {
        if (root.parentElement && !isExcludedElement(root.parentElement)) {
          translateTextNode(root);
        }
        return;
      }
      if (root.nodeType !== 1) return;
      if (isExcludedElement(root)) {
        if (
          (root.tagName === 'INPUT' || root.tagName === 'TEXTAREA') &&
          canTranslateElementAttrs(root) &&
          (root.hasAttribute('title') || root.hasAttribute('aria-label') || root.hasAttribute('placeholder'))
        ) {
          translateElementAttrs(root);
        }
        return;
      }

      if (
        root.hasAttribute &&
        (root.hasAttribute('title') || root.hasAttribute('aria-label') || root.hasAttribute('placeholder'))
      ) {
        translateElementAttrs(root);
      }

      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
        walkerFilter
      );
      while (walker.nextNode()) {
        translateTextNode(walker.currentNode);
      }
    }

    scanBodyFn = scanAndTranslate;
    if (document.body) {
      scanAndTranslate(document.body);
      i18nInitialScanDone = true;
    }

    const dirtyRoots = new Set();
    let disposed = false;
    let pending = false;
    let rafId = null;
    let fallbackTimer = null;

    function clearScheduledFlush() {
      pending = false;
      if (rafId !== null) {
        if (typeof cancelAnimationFrame === 'function') {
          try {
            cancelAnimationFrame(rafId);
          } catch (e) {}
        }
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    }

    function flushTranslations() {
      clearScheduledFlush();
      if (disposed) return;
      if (dirtyRoots.size === 0) return;

      if (dirtyRoots.size > 200) {
        dirtyRoots.clear();
        try {
          scanAndTranslate(document.body);
        } catch (e) {}
        return;
      }

      const roots = Array.from(dirtyRoots);
      const rootSet = new Set(roots);
      dirtyRoots.clear();

      for (let i = 0; i < roots.length; i++) {
        const r = roots[i];
        if (!r || !r.isConnected) continue;
        let covered = false;
        for (let p = r.parentNode; p; p = p.parentNode) {
          if (rootSet.has(p)) {
            covered = true;
            break;
          }
        }
        if (!covered) {
          try {
            scanAndTranslate(r);
          } catch (e) {}
        }
      }
    }

    function scheduleFlush() {
      if (disposed || pending) return;
      pending = true;
      if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(flushTranslations);
      }
      fallbackTimer = setTimeout(flushTranslations, 80);
    }

    window.__ag_i18n_observer = new MutationObserver((mutations) => {
      if (disposed) return;
      const batchSafeSet = new Set();
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'characterData') {
          const t = m.target;
          if (t && t.parentElement && !isExcludedElement(t.parentElement, batchSafeSet)) {
            dirtyRoots.add(t);
          }
        } else if (m.type === 'attributes') {
          const el = m.target;
          if (el && el.nodeType === 1 && canTranslateElementAttrs(el, batchSafeSet)) {
            try {
              translateElementAttrs(el);
            } catch (e) {}
          }
        } else if (m.type === 'childList' && m.addedNodes.length > 0) {
          if (m.target && m.target.nodeType === 1 && isExcludedElement(m.target, batchSafeSet)) {
            continue;
          }
          for (let j = 0; j < m.addedNodes.length; j++) {
            const n = m.addedNodes[j];
            if (n.nodeType === 1 || n.nodeType === 3) {
              dirtyRoots.add(n);
            }
          }
        }
      }
      if (dirtyRoots.size > 0) {
        scheduleFlush();
      }
    });

    if (document.body) {
      window.__ag_i18n_observer.observe(document.body, I18N_OBS_OPTS);
    }
    if (Array.isArray(window.__ag_cleanup_fns)) {
      window.__ag_cleanup_fns.push(() => {
        disposed = true;
        clearScheduledFlush();
        dirtyRoots.clear();
        if (window.__ag_i18n_observer) {
          try {
            window.__ag_i18n_observer.disconnect();
          } catch (e) {}
          window.__ag_i18n_observer = null;
        }
      });
    }
  } else {
    restoreNativeArrayMap();
    if (document.body) {
      // 若用户在配置中关闭了 i18n 模块，实时将已翻译的文本与属性还原为原始英文
      restoreAllTranslations(document.body);
      i18nInitialScanDone = true;
    }
  }
