// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
};

// 参考译文区的运行时状态：activeCode 是当前正在编辑的语言，languages 为空表示不按语言收窄，
// seq 用来丢弃过期的查询结果，timer 负责输入时的防抖
const reference = {
  activeCode: '',
  languages: new Set(),
  seq: 0,
  timer: 0,
};
const REFERENCE_DEBOUNCE_MS = 250;

const el = (id) => document.getElementById(id);

// 统一的请求入口：出错时把服务端给的错误码、说明与出错位置一起抛出去
async function request(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch (err) {
    payload = null;
  }
  if (!res.ok) {
    const error = (payload && payload.error) || {};
    const failure = new Error(error.message || `请求失败（状态码 ${res.status}）`);
    failure.code = error.code || '';
    failure.field = error.field || '';
    throw failure;
  }
  return payload;
}

function notify(message, kind) {
  const box = el('notice');
  box.textContent = message;
  box.className = `notice ${kind === 'ok' ? 'ok' : 'error'}`;
}

function clearNotice() {
  const box = el('notice');
  box.className = 'notice hidden';
  box.textContent = '';
}

function clearFieldMarks() {
  document.querySelectorAll('.invalid').forEach((node) => node.classList.remove('invalid'));
}

// 把出错位置标到具体输入项上：语言区与文案区共用一套标记
function markField(field) {
  if (!field) return;
  const target = document.querySelector(`[data-field="${field}"]`);
  if (!target) return;
  target.classList.add('invalid');
  const input = target.tagName === 'INPUT' || target.tagName === 'SELECT' ? target : target.querySelector('input, select');
  if (input) input.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (num) => String(num).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 操作者名字记在浏览器里，刷新之后还在，保存时随请求一起带上
const OPERATOR_KEY = 'i18n-workbench-operator';

function currentOperator() {
  return el('operator').value.trim();
}

function restoreOperator() {
  const saved = window.localStorage.getItem(OPERATOR_KEY) || '';
  el('operator').value = saved;
}

async function loadHealth() {
  try {
    await request('/api/health');
    el('health').textContent = '服务正常';
    el('health').className = 'health ok';
  } catch (err) {
    el('health').textContent = '服务连不上';
    el('health').className = 'health bad';
  }
}

async function loadLanguages() {
  const payload = await request('/api/languages');
  state.languages = payload.languages || [];
  renderLanguages();
  renderTranslationInputs();
  if (!el('entry-editor').classList.contains('hidden')) renderReferenceChips();
}

async function loadEntries() {
  const params = new URLSearchParams();
  const module = el('filter-module').value;
  const keyword = el('filter-keyword').value.trim();
  if (module) params.set('module', module);
  if (keyword) params.set('keyword', keyword);
  const query = params.toString();
  const payload = await request(`/api/entries${query ? `?${query}` : ''}`);
  state.entries = payload.entries || [];
  state.modules = payload.modules || [];
  renderModules();
  renderEntries();
}

function renderModules() {
  const select = el('filter-module');
  const current = select.value;
  const rows = ['<option value="">全部模块</option>']
    .concat(state.modules.map((item) => `<option value="${escapeHtml(item.module)}">${escapeHtml(item.module)}（${item.count}）</option>`));
  select.innerHTML = rows.join('');
  if (state.modules.some((item) => item.module === current)) select.value = current;
}

function renderLanguages() {
  const body = el('language-body');
  const rows = state.languages.map((item) => {
    const defaultTag = item.isDefault ? '<span class="tag on">默认</span>' : '';
    const enabledTag = item.enabled ? '<span class="tag on">已启用</span>' : '<span class="tag off">已停用</span>';
    const actions = [
      `<button type="button" class="link" data-language-default="${escapeHtml(item.code)}"${item.isDefault ? ' disabled' : ''}>设为默认</button>`,
      `<button type="button" class="link" data-language-toggle="${escapeHtml(item.code)}">${item.enabled ? '停用' : '启用'}</button>`,
      `<button type="button" class="link" data-language-rename="${escapeHtml(item.code)}">改名</button>`,
      `<button type="button" class="link danger" data-language-delete="${escapeHtml(item.code)}">删除</button>`,
    ];
    return `<tr${item.enabled ? '' : ' class="muted"'}>
      <td class="mono">${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td>${defaultTag}</td>
      <td>${enabledTag}</td>
      <td>${item.filled} 条</td>
      <td class="actions">${actions.join('')}</td>
    </tr>`;
  });
  body.innerHTML = rows.join('');
  el('language-empty').classList.toggle('hidden', state.languages.length > 0);
}

// 新建文案的表单按当前登记的语言逐条生成译文输入框，停用的语言照样可以查看与补填
function renderTranslationInputs(values) {
  const box = el('entry-translations');
  const current = values || collectTranslations();
  box.innerHTML = state.languages.map((item) => {
    const value = current[item.code] === undefined ? '' : current[item.code];
    const suffix = item.enabled ? '' : '<span class="tag off">已停用</span>';
    return `<label class="translation" data-field="translations.${escapeHtml(item.code)}">
      <span>${escapeHtml(item.code)} ${suffix}</span>
      <input class="translation-input" data-code="${escapeHtml(item.code)}" maxlength="200" value="${escapeHtml(value)}">
    </label>`;
  }).join('');
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

function renderEntries() {
  const head = el('entry-head-row');
  head.innerHTML = ['模块', '文案键']
    .concat(state.languages.map((item) => item.code))
    .concat(['备注', '最近改动人', '更新时间', '操作'])
    .map((text) => `<th>${escapeHtml(text)}</th>`)
    .join('');

  const body = el('entry-body');
  body.innerHTML = state.entries.map((item) => {
    const cells = state.languages.map((language) => {
      const value = item.translations[language.code];
      if (value === undefined) return '<td class="missing">未登记</td>';
      if (!value.trim()) return '<td class="missing">待翻译</td>';
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    });
    return `<tr>
      <td class="mono">${escapeHtml(item.module)}</td>
      <td class="mono">${escapeHtml(item.key)}</td>
      ${cells.join('')}
      <td class="note-cell">${escapeHtml(item.note)}</td>
      <td>${escapeHtml(item.updatedBy)}</td>
      <td class="mono">${escapeHtml(formatTime(item.updatedAt))}</td>
      <td class="actions">
        <button type="button" class="link" data-entry-edit="${escapeHtml(item.id)}">编辑</button>
        <button type="button" class="link danger" data-entry-delete="${escapeHtml(item.id)}">删除</button>
      </td>
    </tr>`;
  }).join('');
  el('entry-empty').classList.toggle('hidden', state.entries.length > 0);
}

function openEntryForm(entry) {
  state.editingId = entry ? entry.id : '';
  el('entry-form-title').textContent = entry ? `编辑文案：${entry.key}` : '新建文案';
  el('entry-module').value = entry ? entry.module : '';
  el('entry-key').value = entry ? entry.key : '';
  el('entry-note').value = entry ? entry.note : '';
  el('entry-translations').innerHTML = '';
  renderTranslationInputs(entry ? entry.translations : {});
  resetReferencePanel();
  el('entry-editor').classList.remove('hidden');
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  el('entry-editor').classList.add('hidden');
  clearFieldMarks();
}

// 参考译文区：语言筛选用一组可点选的代码小签，一个都没选表示不按语言收窄；
// 在“全部”状态下取消某一种时，先把其余语言都选上再移除它，语义上仍然直观
function renderReferenceChips() {
  const box = el('ref-lang-chips');
  // 语言被删除后，收窄集合里可能还留着旧代码，先剔掉，再判断是否处于收窄状态
  const known = new Set(state.languages.map((item) => item.code));
  Array.from(reference.languages).forEach((code) => {
    if (!known.has(code)) reference.languages.delete(code);
  });
  const narrowing = reference.languages.size > 0;
  box.innerHTML = state.languages.map((item) => {
    const on = !narrowing || reference.languages.has(item.code);
    return `<label class="ref-lang-chip${on ? ' on' : ''}" title="只看这种语言的译文；一个都不勾表示全部语言">
      <input type="checkbox" data-ref-lang="${escapeHtml(item.code)}"${on ? ' checked' : ''}>
      ${escapeHtml(item.code)}
    </label>`;
  }).join('');
}

function resetReferencePanel() {
  reference.activeCode = '';
  reference.seq += 1;
  window.clearTimeout(reference.timer);
  renderReferenceChips();
  el('reference-current').innerHTML = '点任意一种语言的译文输入框，这里会按那格的内容找参考';
  el('reference-list').innerHTML = '';
  el('reference-empty').classList.add('hidden');
  el('reference-empty').textContent = '';
}

function activeTranslationInput() {
  if (!reference.activeCode) return null;
  return Array.from(document.querySelectorAll('.translation-input'))
    .find((input) => input.dataset.code === reference.activeCode) || null;
}

function scoreLabel(item) {
  if (item.exact) return { text: '完全一致', cls: 'exact' };
  const percent = Math.round(item.score * 100);
  return { text: `接近 ${percent}%`, cls: percent >= 75 ? 'high' : '' };
}

function renderReferences(items, currentCode) {
  const list = el('reference-list');
  const empty = el('reference-empty');
  list.innerHTML = items.map((item) => {
    const badge = scoreLabel(item);
    return `<li class="reference-item${item.exact ? ' exact' : ''}">
      <div class="reference-item-head">
        <span class="reference-item-key">${escapeHtml(item.key)}</span>
        <span class="score-badge ${badge.cls}">${badge.text}</span>
      </div>
      <div class="reference-item-meta">
        <span class="tag off">${escapeHtml(item.module)}</span>
        <span class="tag on">${escapeHtml(item.language)}</span>
        ${item.entryId === state.editingId ? '<span class="tag off">本条文案</span>' : ''}
      </div>
      <div class="reference-item-text">${escapeHtml(item.text)}</div>
    </li>`;
  }).join('');
  empty.classList.toggle('hidden', items.length > 0);
  if (items.length === 0) {
    empty.textContent = currentCode
      ? `没有找到与 ${currentCode} 当前内容接近的已填译文，换个范围或放宽上限试试`
      : '';
  }
}

// 按当前焦点输入框的内容发起查询；同一个时刻只认最后一次请求，返回慢的旧结果直接丢弃
async function fetchReferences() {
  const code = reference.activeCode;
  const input = activeTranslationInput();
  if (!code || !input) return;
  const text = input.value.trim();

  const current = el('reference-current');
  current.innerHTML = `<b>${escapeHtml(code)}</b>：${text ? escapeHtml(text) : '（当前为空，输入内容后开始匹配）'}`;
  el('reference-list').innerHTML = '';
  el('reference-empty').classList.add('hidden');
  if (!text) {
    // 清空后让还没返回的旧查询作废，避免旧结果晚到又填回来
    reference.seq += 1;
    return;
  }

  const params = new URLSearchParams();
  params.set('text', text);
  params.set('limit', el('ref-limit').value);
  if (state.editingId) {
    params.set('excludeEntry', state.editingId);
    params.set('excludeLanguage', code);
  }
  if (el('ref-same-module').checked && el('entry-module').value.trim()) {
    params.set('module', el('entry-module').value.trim());
  }
  reference.languages.forEach((lang) => params.append('languages', lang));

  const seq = (reference.seq += 1);
  let payload;
  try {
    payload = await request(`/api/entries/similar?${params.toString()}`);
  } catch (err) {
    if (seq === reference.seq) {
      el('reference-empty').textContent = `参考译文加载失败：${err.message}`;
      el('reference-empty').classList.remove('hidden');
    }
    return;
  }
  if (seq !== reference.seq) return;
  renderReferences(payload.references || [], code);
}

function scheduleReferenceFetch() {
  window.clearTimeout(reference.timer);
  reference.timer = window.setTimeout(fetchReferences, REFERENCE_DEBOUNCE_MS);
}

function toggleReferenceLanguage(code, checked) {
  if (checked) {
    reference.languages.add(code);
    // 又把全部语言都选回来时，恢复成“不限语言”，这样之后新增的语言也自动纳入
    const all = state.languages.length > 0
      && state.languages.every((item) => reference.languages.has(item.code));
    if (all) reference.languages.clear();
  } else if (reference.languages.size === 0) {
    state.languages.forEach((item) => reference.languages.add(item.code));
    reference.languages.delete(code);
  } else {
    reference.languages.delete(code);
  }
  renderReferenceChips();
  fetchReferences();
}

async function submitLanguage(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    code: el('language-code').value,
    name: el('language-name').value,
    enabled: el('language-enabled').checked,
    isDefault: el('language-default').checked,
  };
  try {
    await request('/api/languages', { method: 'POST', body: JSON.stringify(payload) });
    el('language-code').value = '';
    el('language-name').value = '';
    el('language-default').checked = false;
    notify('语言已新增', 'ok');
    await loadLanguages();
    await loadEntries();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

async function submitEntry(event) {
  event.preventDefault();
  clearNotice();
  clearFieldMarks();
  const payload = {
    module: el('entry-module').value,
    key: el('entry-key').value,
    note: el('entry-note').value,
    operator: currentOperator(),
    translations: collectTranslations(),
  };
  const editing = state.editingId;
  try {
    if (editing) {
      await request(`/api/entries/${encodeURIComponent(editing)}`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('文案已保存', 'ok');
    } else {
      await request('/api/entries', { method: 'POST', body: JSON.stringify(payload) });
      notify('文案已新增', 'ok');
    }
    closeEntryForm();
    await loadEntries();
    await loadLanguages();
  } catch (err) {
    notify(err.message, 'error');
    markField(err.field);
  }
}

// 语言与文案列表上的操作用事件委托统一处理，列表重绘之后不需要重新绑定
document.addEventListener('click', async (event) => {
  const node = event.target.closest('button');
  if (!node) return;

  const code = node.dataset.languageDefault || node.dataset.languageToggle
    || node.dataset.languageRename || node.dataset.languageDelete;
  if (code) {
    clearNotice();
    try {
      if (node.dataset.languageDefault) {
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ isDefault: true }) });
        notify(`${code} 已设为默认语言`, 'ok');
      } else if (node.dataset.languageToggle) {
        const target = state.languages.find((item) => item.code === code);
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ enabled: !target.enabled }) });
        notify(`${code} 已${target.enabled ? '停用' : '启用'}`, 'ok');
      } else if (node.dataset.languageRename) {
        const target = state.languages.find((item) => item.code === code);
        const next = window.prompt(`把 ${code} 的名称改成`, target ? target.name : '');
        if (next === null) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'PATCH', body: JSON.stringify({ name: next }) });
        notify(`${code} 的名称已更新`, 'ok');
      } else {
        if (!window.confirm(`确定删除语言 ${code} 吗？`)) return;
        await request(`/api/languages/${encodeURIComponent(code)}`, { method: 'DELETE' });
        notify(`${code} 已删除`, 'ok');
      }
      await loadLanguages();
      await loadEntries();
    } catch (err) {
      notify(err.message, 'error');
    }
    return;
  }

  if (node.dataset.entryEdit) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryEdit);
    if (found) openEntryForm(found);
    return;
  }

  if (node.dataset.entryDelete) {
    clearNotice();
    const found = state.entries.find((item) => item.id === node.dataset.entryDelete);
    if (!window.confirm(`确定删除文案 ${found ? found.key : ''} 吗？`)) return;
    try {
      await request(`/api/entries/${encodeURIComponent(node.dataset.entryDelete)}`, { method: 'DELETE' });
      if (state.editingId === node.dataset.entryDelete) closeEntryForm();
      notify('文案已删除', 'ok');
      await loadEntries();
      await loadLanguages();
    } catch (err) {
      notify(err.message, 'error');
    }
  }
});

el('language-form').addEventListener('submit', submitLanguage);
el('entry-form').addEventListener('submit', submitEntry);

// 参考区的事件：焦点落到哪种语言的输入框，就按哪种语言找参考；输入过程中防抖刷新
el('entry-translations').addEventListener('focusin', (event) => {
  const input = event.target.closest('.translation-input');
  if (!input) return;
  if (reference.activeCode !== input.dataset.code) reference.activeCode = input.dataset.code;
  fetchReferences();
});
el('entry-translations').addEventListener('input', (event) => {
  if (!event.target.classList.contains('translation-input')) return;
  reference.activeCode = event.target.dataset.code;
  scheduleReferenceFetch();
});
el('entry-module').addEventListener('input', () => {
  if (el('ref-same-module').checked) scheduleReferenceFetch();
});
el('ref-same-module').addEventListener('change', fetchReferences);
el('ref-limit').addEventListener('change', fetchReferences);
el('ref-lang-chips').addEventListener('change', (event) => {
  const checkbox = event.target.closest('[data-ref-lang]');
  if (!checkbox) return;
  toggleReferenceLanguage(checkbox.dataset.refLang, checkbox.checked);
});

el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);
el('filter-apply').addEventListener('click', () => {
  clearNotice();
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('filter-reset').addEventListener('click', () => {
  el('filter-module').value = '';
  el('filter-keyword').value = '';
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('entry-refresh').addEventListener('click', () => {
  clearNotice();
  loadLanguages()
    .then(loadEntries)
    .catch((err) => notify(err.message, 'error'));
});
el('filter-module').addEventListener('change', () => {
  loadEntries().catch((err) => notify(err.message, 'error'));
});
el('operator').addEventListener('change', () => {
  window.localStorage.setItem(OPERATOR_KEY, currentOperator());
});

// 页面打开时先把语言与文案拉一遍，语言决定文案表格里有哪些列
restoreOperator();
loadHealth();
loadLanguages()
  .then(loadEntries)
  .catch((err) => notify(err.message, 'error'));
