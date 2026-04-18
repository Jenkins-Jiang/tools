// ==UserScript==
// @name         CNKI 指定期刊 + SWUFE 可视化筛选
// @namespace    http://tampermonkey.net/
// @version      2.1.1
// @description  在中国知网页面中按指定期刊白名单筛选结果，并可一键切换是否仅显示带 SWUFE 标记的文献；不影响分页按钮
// @author       Jenkins Jiang
// @match        *://kns.cnki.net/*
// @match        *://*.cnki.net/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
// TODO：现在依赖于easyScholar的统计，名单可能存在滞后，后期可以通过json配置，导入一个自己维护的名单

(function () {
  'use strict';

  const HIDE_CLASS = '__tm_hide_non_target_row__';
  const PANEL_ID = '__tm_cnki_filter_panel__';
  const STYLE_ID = '__tm_cnki_filter_style__';
  const STORAGE_KEY = '__tm_cnki_filter_panel_state_v211__';
  const DEBUG = false;

  // ==============================
  // 默认配置：长期只需要改这里。  比如：只想看 农经四大刊，
  // ==============================
  const DEFAULT_CONFIG = {
    enabled: true,
    journalWhitelist: [
       '中国农村经济',
       '中国农村观察',
      // '农业经济问题',
      // '农业技术经济'
    ],
      // 所有期刊都通过
    journalWhitelist:[],
    journalMatchMode: 'contains', // contains | exact
    caseInsensitive: true,
    persistLocalChanges: true,
    panelCollapsed: false,
    showPanel: true,
    swufeOnly: false
  };

  // SWUFE 识别规则
  const SWUFE_PATTERNS = [
    /\bSWUFE\b/i,
    /SWUFE\s*[A-Z]/i
    // 如果后续发现 easyScholar 显示为中文，可自行放开：
    // /西南财经大学/,
    // /西财/
  ];

  let config = loadConfig();
  let lastStats = { total: 0, kept: 0, hidden: 0 };
  let processTimer = null;
  let observer = null;

  function log(...args) {
    if (DEBUG) console.log('[CNKI-FILTER]', ...args);
  }

  function normalizeText(text) {
    return (text || '')
      .replace(/\u00A0/g, ' ')
      .replace(/[\t\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[【】\[\]（）()]/g, ' ')
      .trim();
  }

  function normalizeForCompare(text) {
    const t = normalizeText(text);
    return config.caseInsensitive ? t.toLowerCase() : t;
  }

  function splitJournalList(text) {
    return String(text || '')
      .split(/[\n,，;；、]+/)
      .map(item => normalizeText(item))
      .filter(Boolean);
  }

  function listToTextareaValue(list) {
    return (list || []).join('\n');
  }

  function loadConfig() {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {};
    } catch (e) {
      saved = {};
    }
    return normalizeConfig({ ...DEFAULT_CONFIG, ...saved });
  }

  function normalizeConfig(raw) {
    const next = {
      ...DEFAULT_CONFIG,
      ...(raw || {})
    };

    next.enabled = !!next.enabled;
    next.caseInsensitive = !!next.caseInsensitive;
    next.persistLocalChanges = next.persistLocalChanges !== false;
    next.panelCollapsed = !!next.panelCollapsed;
    next.showPanel = next.showPanel !== false;
    next.swufeOnly = !!next.swufeOnly;
    next.journalMatchMode = next.journalMatchMode === 'exact' ? 'exact' : 'contains';

    if (!Array.isArray(next.journalWhitelist)) {
      next.journalWhitelist = splitJournalList(String(next.journalWhitelist || ''));
    }

    next.journalWhitelist = next.journalWhitelist
      .map(item => normalizeText(item))
      .filter(Boolean);

    return next;
  }

  function saveConfig() {
    if (!config.persistLocalChanges) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      log('saveConfig failed:', e);
    }
  }

  function clearSavedConfig() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
      log('clearSavedConfig failed:', e);
    }
  }

  function hasSwufeMarkText(text) {
    const t = normalizeText(text);
    return SWUFE_PATTERNS.some(re => re.test(t));
  }

  function hasSwufeMark(tr) {
    return hasSwufeMarkText(tr.innerText || tr.textContent || '');
  }

  function isPagerText(text) {
    return /上一页|下一页|首页|末页|尾页|前页|后页|跳转|共\d+页|到第\s*\d+\s*页/.test(text);
  }

  function isHeaderText(text) {
    return /题名.*作者.*来源.*发表时间.*数据库.*被引.*下载.*操作/.test(text);
  }

  function isResultRow(tr) {
    if (!tr || tr.tagName !== 'TR') return false;

    const tds = tr.querySelectorAll('td');
    if (tds.length < 5) return false;

    const text = normalizeText(tr.innerText || tr.textContent || '');
    if (!text) return false;
    if (isPagerText(text)) return false;
    if (isHeaderText(text)) return false;

    const textLinks = Array.from(tr.querySelectorAll('a')).filter(a => {
      const t = normalizeText(a.textContent || '');
      return t.length >= 2;
    });

    if (textLinks.length === 0) return false;

    const hasDocType = /期刊|博士|硕士|会议|报纸|辑刊|年鉴/.test(text);
    const hasCheckbox = !!tr.querySelector('input[type="checkbox"]');

    if (hasDocType && textLinks.length > 0) return true;
    if (hasCheckbox && tds.length >= 6) return true;

    return false;
  }

  function collectResultRows() {
    return Array.from(document.querySelectorAll('tr')).filter(isResultRow);
  }

  function getRowText(tr) {
    return normalizeText(tr.innerText || tr.textContent || '');
  }

  function isLikelyNoiseCandidate(text) {
    const t = normalizeText(text);
    if (!t) return true;

    if (t.length > 80) return true;
    if (t.length < 2) return true;

    if (/^(题名|作者|来源|发表时间|数据库|被引|下载|操作)$/.test(t)) return true;
    if (/^(收藏|下载|导出|分享|引用|阅读|预览|相似文献|相关文献)$/.test(t)) return true;
    if (/^\d{4}[-/.]\d{1,2}([-/.\d]*)?$/.test(t)) return true;
    if (/^\d+$/.test(t)) return true;
    if (/^(期刊|博士|硕士|会议|报纸|辑刊|年鉴)$/.test(t)) return true;
    if (/^(第?\d+页|第?\d+卷|第?\d+期)$/.test(t)) return true;

    return false;
  }

  function pushCandidate(set, text) {
    const t = normalizeText(text);
    if (!t) return;
    if (!isLikelyNoiseCandidate(t)) set.add(t);

    const parts = t.split(/[|｜\/\\,，;；]+/).map(s => normalizeText(s)).filter(Boolean);
    parts.forEach(part => {
      if (!isLikelyNoiseCandidate(part)) set.add(part);
    });
  }

  function extractJournalCandidates(tr) {
    const set = new Set();
    const rowText = getRowText(tr);

    // 1) 先从整行文本中抓“来源：xxx”
    const sourceRegexes = [
      /来源[:：]\s*([^\n]+?)(?=\s+(?:发表时间|关键词|摘要|被引|下载|在线公开时间|页数|基金|分类号|DOI|专辑|专题|ISSN|CN号)[:：]|\s{2,}|$)/i,
      /来源\s+([^\n]+?)(?=\s+(?:发表时间|关键词|摘要|被引|下载|在线公开时间|页数|基金|分类号|DOI|专辑|专题|ISSN|CN号)|$)/i
    ];

    sourceRegexes.forEach(re => {
      const m = rowText.match(re);
      if (m && m[1]) pushCandidate(set, m[1]);
    });

    // 2) 从各个 td 文本中抓候选值
    Array.from(tr.querySelectorAll('td')).forEach(td => {
      const text = normalizeText(td.innerText || td.textContent || '');
      if (!text) return;

      const m = text.match(/^来源[:：]?\s*(.+)$/i);
      if (m && m[1]) {
        pushCandidate(set, m[1]);
      }

      pushCandidate(set, text);
    });

    // 3) 从链接与 span 中抓短文本
    Array.from(tr.querySelectorAll('a, span')).forEach(el => {
      const text = normalizeText(el.textContent || '');
      if (!text) return;
      if (text.length <= 40) pushCandidate(set, text);
    });

    // 4) 如果没有候选，兜底整行
    if (set.size === 0) {
      pushCandidate(set, rowText);
    }

    return Array.from(set);
  }

  function buildJournalMatcher() {
    const whitelist = (config.journalWhitelist || [])
      .map(normalizeForCompare)
      .filter(Boolean);

    return function matchJournal(tr) {
      if (!whitelist.length) return true;

      const rowText = normalizeForCompare(getRowText(tr));
      const candidates = extractJournalCandidates(tr).map(normalizeForCompare);

      if (config.journalMatchMode === 'exact') {
        return whitelist.some(name => candidates.some(candidate => candidate === name));
      }

      return whitelist.some(name => {
        return candidates.some(candidate => candidate.includes(name)) || rowText.includes(name);
      });
    };
  }

  function extraCustomRule(_tr, _ctx) {
    return true;
  }

  function shouldKeepRow(tr, matchJournal) {
    if (!config.enabled) return true;

    if (!matchJournal(tr)) return false;
    if (config.swufeOnly && !hasSwufeMark(tr)) return false;

    const ctx = {
      rowText: getRowText(tr),
      journalCandidates: extractJournalCandidates(tr)
    };

    return extraCustomRule(tr, ctx);
  }

  function addStyle() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      .${HIDE_CLASS} {
        display: none !important;
      }

      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 380px;
        max-width: calc(100vw - 24px);
        background: #00000073;
        color: #fff;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.28);
        overflow: hidden;
        font-size: 13px;
        line-height: 1.45;
        backdrop-filter: blur(4px);
      }

      #${PANEL_ID} * {
        box-sizing: border-box;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
      }

      #${PANEL_ID} .tm-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.06);
        cursor: pointer;
      }

      #${PANEL_ID} .tm-title {
        font-weight: 700;
        font-size: 14px;
      }

      #${PANEL_ID} .tm-subtitle {
        font-size: 11px;
        opacity: 0.82;
        margin-top: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 260px;
      }

      #${PANEL_ID} .tm-toggle-btn {
        border: 0;
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        padding: 4px 10px;
        cursor: pointer;
        flex-shrink: 0;
      }

      #${PANEL_ID} .tm-body {
        padding: 12px;
      }

      #${PANEL_ID}.tm-collapsed .tm-body {
        display: none;
      }

      #${PANEL_ID} .tm-section + .tm-section {
        margin-top: 10px;
      }

      #${PANEL_ID} .tm-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }

      #${PANEL_ID} .tm-row:last-child {
        margin-bottom: 0;
      }

      #${PANEL_ID} label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }

      #${PANEL_ID} select,
      #${PANEL_ID} textarea,
      #${PANEL_ID} input[type="text"] {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        padding: 8px 10px;
        outline: none;
      }

      #${PANEL_ID} select {
        width: 132px;
      }

      #${PANEL_ID} textarea {
        min-height: 132px;
        resize: vertical;
      }

      #${PANEL_ID} textarea::placeholder,
      #${PANEL_ID} input[type="text"]::placeholder {
        color: rgba(255, 255, 255, 0.48);
      }

      #${PANEL_ID} .tm-label {
        margin-bottom: 6px;
        font-weight: 600;
      }

      #${PANEL_ID} .tm-help {
        margin-top: 6px;
        font-size: 11px;
        opacity: 0.72;
      }

      #${PANEL_ID} .tm-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }

      #${PANEL_ID} button.tm-btn {
        border: 0;
        border-radius: 8px;
        padding: 8px 10px;
        cursor: pointer;
        color: #fff;
        background: rgba(255, 255, 255, 0.12);
      }

      #${PANEL_ID} button.tm-btn.tm-primary {
        background: #2f7df6;
      }

      #${PANEL_ID} button.tm-btn.tm-danger {
        background: #8b3d3d;
      }

      #${PANEL_ID} button.tm-btn.tm-swufe-on {
        background: #1d8f58;
      }

      #${PANEL_ID} button.tm-btn.tm-swufe-off {
        background: #555;
      }

      #${PANEL_ID} .tm-stats {
        border-radius: 8px;
        padding: 8px 10px;
        background: rgba(255, 255, 255, 0.06);
        font-size: 12px;
        white-space: pre-line;
      }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if (!config.showPanel) return null;

    let panel = document.getElementById(PANEL_ID);
    if (panel) return panel;

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    if (config.panelCollapsed) panel.classList.add('tm-collapsed');

    panel.innerHTML = `
      <div class="tm-header">
        <div>
          <div class="tm-title">CNKI 期刊筛选</div>
          <div class="tm-subtitle" data-role="headerStats">保留 0 / 隐藏 0 / 总计 0</div>
        </div>
        <button type="button" class="tm-toggle-btn">${config.panelCollapsed ? '展开' : '收起'}</button>
      </div>
      <div class="tm-body">
        <div class="tm-section">
          <div class="tm-row">
            <label><input type="checkbox" data-role="enabled"> 启用筛选</label>
            <label><input type="checkbox" data-role="caseInsensitive"> 忽略大小写</label>
          </div>
          <div class="tm-row">
            <label><input type="checkbox" data-role="persistLocalChanges"> 记住本地修改</label>
            <label>
              <span>匹配方式</span>
              <select data-role="matchMode">
                <option value="contains">包含匹配</option>
                <option value="exact">精确匹配</option>
              </select>
            </label>
          </div>
        </div>

        <div class="tm-section">
          <div class="tm-label">期刊白名单</div>
          <textarea data-role="journalList" placeholder="一行一个期刊名，也支持逗号/顿号/分号分隔&#10;例如：&#10;经济研究&#10;管理世界&#10;中国工业经济"></textarea>
          <div class="tm-help">只有命中白名单的结果会保留；若开启 SWUFE，则还必须带 SWUFE 标记。</div>
        </div>

        <div class="tm-section">
          <div class="tm-actions">
            <button type="button" class="tm-btn tm-primary" data-action="apply">应用并筛选</button>
            <button type="button" class="tm-btn" data-action="toggleSwufe">仅显示 SWUFE：关</button>
            <button type="button" class="tm-btn" data-action="showAll">显示全部</button>
            <button type="button" class="tm-btn tm-danger" data-action="reset">恢复默认</button>
          </div>
        </div>

        <div class="tm-section">
          <div class="tm-stats" data-role="stats">正在统计...</div>
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    bindPanelEvents(panel);
    syncPanelFromConfig();
    return panel;
  }

  function bindPanelEvents(panel) {
    const header = panel.querySelector('.tm-header');
    const toggleBtn = panel.querySelector('.tm-toggle-btn');

    const toggleCollapsed = (event) => {
      if (event) event.stopPropagation();
      config.panelCollapsed = !config.panelCollapsed;
      panel.classList.toggle('tm-collapsed', config.panelCollapsed);
      toggleBtn.textContent = config.panelCollapsed ? '展开' : '收起';
      saveConfig();
    };

    header.addEventListener('click', toggleCollapsed);
    toggleBtn.addEventListener('click', toggleCollapsed);

    panel.querySelector('[data-action="apply"]').addEventListener('click', (event) => {
      event.stopPropagation();
      readConfigFromPanel();
      config.enabled = true;
      saveConfig();
      processResults();
    });

    panel.querySelector('[data-action="toggleSwufe"]').addEventListener('click', (event) => {
      event.stopPropagation();
      readConfigFromPanel();
      config.swufeOnly = !config.swufeOnly;
      saveConfig();
      syncPanelFromConfig();
      processResults();
    });

    panel.querySelector('[data-action="showAll"]').addEventListener('click', (event) => {
      event.stopPropagation();
      config.enabled = false;
      saveConfig();
      syncPanelFromConfig();
      processResults();
    });

    panel.querySelector('[data-action="reset"]').addEventListener('click', (event) => {
      event.stopPropagation();
      clearSavedConfig();
      config = normalizeConfig(DEFAULT_CONFIG);
      syncPanelFromConfig();
      processResults();
    });

    const controls = panel.querySelectorAll('input, select, textarea');
    controls.forEach(el => {
      el.addEventListener('keydown', (event) => event.stopPropagation());
      el.addEventListener('click', (event) => event.stopPropagation());
    });
  }

  function syncPanelFromConfig() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const enabled = panel.querySelector('[data-role="enabled"]');
    const caseInsensitive = panel.querySelector('[data-role="caseInsensitive"]');
    const persistLocalChanges = panel.querySelector('[data-role="persistLocalChanges"]');
    const matchMode = panel.querySelector('[data-role="matchMode"]');
    const journalList = panel.querySelector('[data-role="journalList"]');
    const swufeBtn = panel.querySelector('[data-action="toggleSwufe"]');

    if (enabled) enabled.checked = !!config.enabled;
    if (caseInsensitive) caseInsensitive.checked = !!config.caseInsensitive;
    if (persistLocalChanges) persistLocalChanges.checked = !!config.persistLocalChanges;
    if (matchMode) matchMode.value = config.journalMatchMode;
    if (journalList) journalList.value = listToTextareaValue(config.journalWhitelist);

    if (swufeBtn) {
      swufeBtn.textContent = `仅显示 SWUFE：${config.swufeOnly ? '开' : '关'}`;
      swufeBtn.classList.toggle('tm-swufe-on', !!config.swufeOnly);
      swufeBtn.classList.toggle('tm-swufe-off', !config.swufeOnly);
    }

    updateStatsPanel();
  }

  function readConfigFromPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    config = normalizeConfig({
      ...config,
      enabled: !!panel.querySelector('[data-role="enabled"]').checked,
      caseInsensitive: !!panel.querySelector('[data-role="caseInsensitive"]').checked,
      persistLocalChanges: !!panel.querySelector('[data-role="persistLocalChanges"]').checked,
      journalMatchMode: panel.querySelector('[data-role="matchMode"]').value,
      journalWhitelist: splitJournalList(panel.querySelector('[data-role="journalList"]').value),
      swufeOnly: !!config.swufeOnly
    });
  }

  function updateStatsPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;

    const statsEl = panel.querySelector('[data-role="stats"]');
    const headerStatsEl = panel.querySelector('[data-role="headerStats"]');
    if (!statsEl) return;

    const count = config.journalWhitelist.length;
    const preview = count
      ? config.journalWhitelist.slice(0, 5).join('、') + (count > 5 ? ' ...' : '')
      : '未设置白名单（此时仅由 SWUFE 开关决定是否筛选）';

    const statusText = config.enabled ? '已启用' : '未启用';
    const swufeText = config.swufeOnly ? '开启' : '关闭';

    if (headerStatsEl) {
      headerStatsEl.textContent = `统计：保留 ${lastStats.kept} / 隐藏 ${lastStats.hidden} / 总计 ${lastStats.total}`;
      headerStatsEl.title = `状态：${statusText}｜SWUFE：${swufeText}`;
    }

    statsEl.textContent = [
      `状态：${statusText}`,
      `SWUFE：${swufeText}`,
//      `统计：保留 ${lastStats.kept} / 隐藏 ${lastStats.hidden} / 总计 ${lastStats.total}`,
      `白名单数量：${count}`,
      `预览：${preview}`
    ].join('\n');
  }

  function processResults() {
    const rows = collectResultRows();
    const matchJournal = buildJournalMatcher();

    let total = 0;
    let kept = 0;
    let hidden = 0;

    rows.forEach(tr => {
      const keep = shouldKeepRow(tr, matchJournal);
      tr.classList.toggle(HIDE_CLASS, !keep);
      total++;
      if (keep) kept++;
      else hidden++;
    });

    lastStats = { total, kept, hidden };
    updateStatsPanel();
    log({ total, kept, hidden, rows });
  }

  function scheduleProcess(delay = 500) {
    clearTimeout(processTimer);
    processTimer = setTimeout(processResults, delay);
  }

  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      const hasRelevantMutation = mutations.some(mutation => {
        const target = mutation.target;
        if (target && target.closest && target.closest('#' + PANEL_ID)) return false;

        if (mutation.addedNodes && mutation.addedNodes.length) {
          const nodes = Array.from(mutation.addedNodes);
          const allInsidePanel = nodes.every(node => {
            return node.nodeType === 1 && node.closest && node.closest('#' + PANEL_ID);
          });
          if (allInsidePanel) return false;
        }

        return true;
      });

      if (hasRelevantMutation) scheduleProcess(600);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function init() {
    addStyle();
    ensurePanel();
    syncPanelFromConfig();
    processResults();
    startObserver();

    // CNKI / easyScholar 标记常延迟注入，多跑几次
    setTimeout(processResults, 1200);
    setTimeout(processResults, 2500);
    setTimeout(processResults, 4000);
    setTimeout(processResults, 6000);
  }

  init();
})();