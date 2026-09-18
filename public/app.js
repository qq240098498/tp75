// 页面交互：语言清单与文案清单都从服务端拉取，任何一步失败都把说明显示在顶部并标到对应输入项上

const state = {
  languages: [],
  entries: [],
  modules: [],
  editingId: '',
  // 参考区当前跟随的译文输入框：language 为语言代码，controller 用来作废上一次还没回来的查询
  reference: {
    language: '',
    items: [],
    controller: null,
    timer: null,
    seq: 0,
  },
};

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
  renderReferenceLanguages();
}

function collectTranslations() {
  const result = {};
  document.querySelectorAll('.translation-input').forEach((input) => {
    result[input.dataset.code] = input.value;
  });
  return result;
}

// ===== 编辑表单旁的参考区 =====

// 语言范围勾选框跟随语言清单一起生成；“全部”勾选时不再向下传语言条件
function renderReferenceLanguages() {
  const box = el('ref-language-list');
  box.innerHTML = state.languages.map((item) =>
    `<label class="check"><input type="checkbox" data-ref-language="${escapeHtml(item.code)}" checked> ${escapeHtml(item.code)}</label>`
  ).join('');
}

function referenceLanguageName(code) {
  const found = state.languages.find((item) => item.code === code);
  return found ? `${code}（${found.name}）` : code;
}

function selectedReferenceLanguages() {
  if (el('ref-all-languages').checked) return [];
  return Array.from(document.querySelectorAll('[data-ref-language]:checked'))
    .map((input) => input.dataset.refLanguage);
}

function activeTranslationInput() {
  const code = state.reference.language;
  if (!code) return null;
  return document.querySelector(`.translation-input[data-code="${code}"]`);
}

function scheduleReferenceQuery(delay) {
  const ref = state.reference;
  if (ref.timer) clearTimeout(ref.timer);
  ref.timer = setTimeout(runReferenceQuery, delay == null ? 200 : delay);
}

// 把当前译文格的文本与收窄条件发给服务端；新查询发出前作废旧查询，避免先回来的旧结果覆盖新结果
function runReferenceQuery() {
  const ref = state.reference;
  const code = ref.language;
  const input = activeTranslationInput();
  if (!code || !input) return;

  const params = new URLSearchParams();
  params.set('text', input.value);
  params.set('selfLanguage', code);
  if (state.editingId) params.set('entryId', state.editingId);
  if (el('ref-same-module').checked) {
    const module = el('entry-module').value.trim();
    if (module) params.set('module', module);
  }
  const languages = selectedReferenceLanguages();
  if (languages.length) params.set('languages', languages.join(','));
  const limit = el('ref-limit').value.trim();
  if (limit) params.set('limit', limit);

  if (ref.controller) ref.controller.abort();
  const controller = new AbortController();
  ref.controller = controller;
  const seq = ++ref.seq;
  el('reference-list').innerHTML = '<p class="reference-tip">正在查找…</p>';

  request(`/api/entries/similar?${params.toString()}`, { signal: controller.signal })
    .then((payload) => {
      if (seq !== ref.seq) return;
      ref.items = payload.items || [];
      renderReferenceItems(ref.items);
    })
    .catch((err) => {
      if (seq !== ref.seq || err.name === 'AbortError') return;
      el('reference-list').innerHTML = `<p class="reference-tip">${escapeHtml(err.message)}</p>`;
    });
}

function renderReferenceItems(items) {
  const box = el('reference-list');
  if (!items.length) {
    box.innerHTML = '<p class="reference-tip">没有找到可参考的已填译文</p>';
    return;
  }
  box.innerHTML = items.map((item, index) => {
    const score = item.exact
      ? '<span class="ref-score exact">完全一致</span>'
      : `<span class="ref-score">接近 ${Math.round(item.score * 100)}%</span>`;
    return `<div class="reference-item${item.exact ? ' exact' : ''}">
      <div class="reference-meta">
        <span class="mono ref-key">${escapeHtml(item.key)}</span>
        <span class="ref-lang">${escapeHtml(item.language)}</span>
        ${score}
      </div>
      <div class="reference-text" title="${escapeHtml(item.text)}">${escapeHtml(item.text)}</div>
      <div class="reference-actions">
        <button type="button" class="link" data-ref-adopt="${index}">采用</button>
      </div>
    </div>`;
  }).join('');
}

// 把某条参考译文填回当前译文格，再立刻按新文本查一遍，完全一致的候选会置顶
function adoptReferenceText(index) {
  const items = state.reference.items || [];
  const item = items[Number(index)];
  const input = activeTranslationInput();
  if (!item || !input) return;
  input.value = item.text;
  input.focus();
  runReferenceQuery();
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
  el('entry-editor').classList.remove('hidden');
  el('entry-form').classList.remove('hidden');
  resetReferencePanel();
  el('entry-module').focus();
}

function closeEntryForm() {
  state.editingId = '';
  stopReferenceFollowing();
  el('entry-editor').classList.add('hidden');
  el('entry-form').classList.add('hidden');
  clearFieldMarks();
}

// 打开表单时把参考区复位：默认只看本模块、语言范围为全部、清掉上一条的候选
function resetReferencePanel() {
  const ref = state.reference;
  stopReferenceFollowing();
  el('ref-same-module').checked = true;
  el('ref-all-languages').checked = true;
  el('ref-limit').value = 5;
  document.querySelectorAll('[data-ref-language]').forEach((input) => { input.checked = true; });
  el('ref-current-label').textContent = '—';
  el('reference-list').innerHTML = '<p class="reference-tip">点任意一种语言的译文输入框，这里会列出最接近的已填译文</p>';
}

function stopReferenceFollowing() {
  const ref = state.reference;
  ref.language = '';
  ref.items = [];
  ref.seq += 1;
  if (ref.timer) {
    clearTimeout(ref.timer);
    ref.timer = null;
  }
  if (ref.controller) {
    ref.controller.abort();
    ref.controller = null;
  }
  document.querySelectorAll('.translation-input.active-reference').forEach((node) => node.classList.remove('active-reference'));
}

// 焦点进入某个译文格时，参考区开始跟随这一种语言；输入时防抖后重新查询
function followTranslationInput(input) {
  const ref = state.reference;
  const code = input.dataset.code;
  document.querySelectorAll('.translation-input.active-reference').forEach((node) => node.classList.remove('active-reference'));
  input.classList.add('active-reference');
  ref.language = code;
  el('ref-current-label').textContent = referenceLanguageName(code);
  runReferenceQuery();
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

  if (node.dataset.refAdopt !== undefined) {
    adoptReferenceText(node.dataset.refAdopt);
    return;
  }

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
el('entry-new').addEventListener('click', () => {
  clearNotice();
  openEntryForm(null);
});
el('entry-cancel').addEventListener('click', closeEntryForm);

// 参考区事件：焦点与输入跟随译文格，收窄条件变化时立刻按当前格重新查询
el('entry-translations').addEventListener('focusin', (event) => {
  if (event.target.classList && event.target.classList.contains('translation-input')) {
    followTranslationInput(event.target);
  }
});
el('entry-translations').addEventListener('input', (event) => {
  if (event.target.classList && event.target.classList.contains('translation-input')
    && state.reference.language === event.target.dataset.code) {
    scheduleReferenceQuery(200);
  }
});
el('ref-same-module').addEventListener('change', () => {
  if (state.reference.language) runReferenceQuery();
});
el('ref-all-languages').addEventListener('change', () => {
  const all = el('ref-all-languages').checked;
  document.querySelectorAll('[data-ref-language]').forEach((input) => { input.checked = all; });
  if (state.reference.language) runReferenceQuery();
});
el('ref-language-list').addEventListener('change', (event) => {
  const input = event.target.closest('[data-ref-language]');
  if (!input) return;
  const boxes = Array.from(document.querySelectorAll('[data-ref-language]'));
  el('ref-all-languages').checked = boxes.every((box) => box.checked);
  if (state.reference.language) runReferenceQuery();
});
el('ref-limit').addEventListener('change', () => {
  if (state.reference.language) runReferenceQuery();
});
el('entry-module').addEventListener('input', () => {
  if (state.reference.language && el('ref-same-module').checked) scheduleReferenceQuery(200);
});
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
