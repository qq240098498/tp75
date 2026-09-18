const crypto = require('crypto');
const { load, save, MAX_TRANSLATION_LENGTH, MAX_NOTE_LENGTH, MAX_OPERATOR_LENGTH, UNNAMED } = require('./store');
const { ApiError, pickText } = require('./errors');

const MODULE_PATTERN = /^[a-z][a-z0-9-]{0,29}$/;
const KEY_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)+$/;
const MAX_KEY_LENGTH = 120;

const DEFAULT_SIMILAR_LIMIT = 5;
const MAX_SIMILAR_LIMIT = 20;

function validateModule(value) {
  const module = pickText(value);
  if (!module) throw new ApiError(400, 'MODULE_REQUIRED', '请填写模块名', 'module');
  if (!MODULE_PATTERN.test(module)) {
    throw new ApiError(400, 'MODULE_INVALID', '模块名要小写字母起头，后面可以跟数字与短横线，最长 30 个字符', 'module');
  }
  return module;
}

function validateKey(value) {
  const key = pickText(value);
  if (!key) throw new ApiError(400, 'KEY_REQUIRED', '请填写文案键', 'key');
  if (key.length > MAX_KEY_LENGTH) {
    throw new ApiError(400, 'KEY_TOO_LONG', `文案键不能超过 ${MAX_KEY_LENGTH} 个字符`, 'key');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new ApiError(400, 'KEY_INVALID', '文案键要写成 home.banner.title 这样的形式，由小写字母、数字、下划线与短横线组成，并用点号至少分成两段', 'key');
  }
  return key;
}

// 译文逐条校验：语言必须是登记过的，取值必须是文本，长度不能超过上限
function validateTranslations(raw, languages) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ApiError(400, 'TRANSLATIONS_INVALID', '译文需要按语言逐条填写', 'translations');
  }
  const known = new Map();
  languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));

  const result = {};
  Object.keys(raw).forEach((code) => {
    const value = raw[code];
    const actual = known.get(String(code).toLowerCase());
    if (!actual) {
      throw new ApiError(400, 'LANGUAGE_UNKNOWN', `语言 ${code} 没有登记过，请先在语言区登记这种语言`, `translations.${code}`);
    }
    if (typeof value !== 'string') {
      throw new ApiError(400, 'TRANSLATION_INVALID', `${actual} 的译文需要是文本`, `translations.${actual}`);
    }
    if (value.length > MAX_TRANSLATION_LENGTH) {
      throw new ApiError(400, 'TRANSLATION_TOO_LONG', `${actual} 的译文不能超过 ${MAX_TRANSLATION_LENGTH} 个字符，当前 ${value.length} 个字符`, `translations.${actual}`);
    }
    // 留空表示这条还没翻译，原样保留一个空串，方便页面上看出是空的还是根本没这一项
    result[actual] = value;
  });
  return result;
}

function validateNote(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new ApiError(400, 'NOTE_INVALID', '备注需要是文本', 'note');
  }
  if (value.length > MAX_NOTE_LENGTH) {
    throw new ApiError(400, 'NOTE_TOO_LONG', `备注不能超过 ${MAX_NOTE_LENGTH} 个字符`, 'note');
  }
  return value.trim();
}

// 操作者：页面顶栏填的名字，留空按未署名记录，只做长度检查
function validateOperator(value, fallback) {
  if (value === undefined || value === null) return fallback || UNNAMED;
  if (typeof value !== 'string') {
    throw new ApiError(400, 'OPERATOR_INVALID', '操作者需要是文本', 'operator');
  }
  const name = value.trim();
  if (!name) return UNNAMED;
  if (name.length > MAX_OPERATOR_LENGTH) {
    throw new ApiError(400, 'OPERATOR_TOO_LONG', `操作者名字不能超过 ${MAX_OPERATOR_LENGTH} 个字符`, 'operator');
  }
  return name;
}

// 同一个模块下不允许出现重复的键，比较时忽略大小写
function assertKeyFree(data, module, key, selfId) {
  const hit = data.entries.find((item) => item.module === module
    && item.id !== selfId
    && item.key.toLowerCase() === key.toLowerCase());
  if (hit) {
    throw new ApiError(409, 'KEY_DUPLICATED', `模块 ${module} 下已经有 ${hit.key} 这条文案了`, 'key');
  }
}

function sortEntries(list) {
  return list.slice().sort((a, b) => {
    if (a.module !== b.module) return a.module < b.module ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
}

// 相似度只比较正文：去掉所有空白后做大小写折叠，首尾空格与全半角差异都不影响结果
function normalizeForCompare(value) {
  return String(value == null ? '' : value).replace(/\s+/g, '').toLowerCase();
}

// 莱文斯坦编辑距离：把一个串改成另一个串所需的最少增删改次数，按码元逐个比较
function editDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_unused, index) => index);
  let next = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    next[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[j] = Math.min(prev[j] + 1, next[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, next] = [next, prev];
  }
  return prev[b.length];
}

// 归一化到 0~1：完全一致为 1，毫无关系时趋近 0，结果保留四位小数便于页面上稳定展示
function similarityScore(text, candidate) {
  if (text === candidate) return 1;
  const longest = Math.max(text.length, candidate.length);
  if (longest === 0) return 1;
  return Number((1 - editDistance(text, candidate) / longest).toFixed(4));
}

// 候选条数：缺省给默认值，必须是正整数且不超过上限，取不满时由调用方按实际条数返回
function readSimilarLimit(value) {
  const text = pickText(value);
  if (!text) return DEFAULT_SIMILAR_LIMIT;
  if (!/^\d+$/.test(text)) {
    throw new ApiError(400, 'LIMIT_INVALID', '候选条数需要是正整数', 'limit');
  }
  const limit = Number(text);
  if (limit < 1 || limit > MAX_SIMILAR_LIMIT) {
    throw new ApiError(400, 'LIMIT_INVALID', `候选条数要在 1 到 ${MAX_SIMILAR_LIMIT} 之间`, 'limit');
  }
  return limit;
}

// 按模块与关键词筛选：关键词同时匹配文案键与任意一种语言的译文
function listEntries(options) {
  const input = options && typeof options === 'object' ? options : {};
  const module = pickText(input.module);
  const keyword = pickText(input.keyword).toLowerCase();
  const data = load();

  let list = data.entries;
  if (module) list = list.filter((item) => item.module === module);
  if (keyword) {
    list = list.filter((item) => {
      if (item.key.toLowerCase().includes(keyword)) return true;
      return Object.keys(item.translations).some((code) => item.translations[code].toLowerCase().includes(keyword));
    });
  }

  const counts = {};
  data.entries.forEach((item) => {
    counts[item.module] = (counts[item.module] || 0) + 1;
  });
  const modules = Object.keys(counts).sort().map((name) => ({ module: name, count: counts[name] }));

  return { entries: sortEntries(list), modules };
}

function getEntry(id) {
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  return found;
}

// 在已经填过的译文里找与当前文本最接近的几条，供编辑表单旁边的参考区使用。
// 排序是确定的：原文完全一致的排最前，随后按接近程度降序；程度相同时按文案键、
// 语言代码、文案 id 依次稳定排序，因此同样的查询重复发起顺序不会变化。
function findSimilarTranslations(options) {
  const input = options && typeof options === 'object' ? options : {};
  const data = load();
  const limit = readSimilarLimit(input.limit);
  const module = pickText(input.module);
  const selfEntryId = pickText(input.entryId);
  const selfLanguage = pickText(input.selfLanguage);
  const query = normalizeForCompare(input.text);

  // 语言范围：逗号分隔的多个代码，大小写不敏感，全部映射成登记过的真实写法；
  // 一个都没对上就当作范围里没有候选，而不是悄悄放宽到所有语言
  const languageCodes = [];
  const languageParam = pickText(input.languages);
  if (languageParam) {
    const known = new Map();
    data.languages.forEach((item) => known.set(item.code.toLowerCase(), item.code));
    const wanted = new Set();
    languageParam.split(',').map((code) => code.trim().toLowerCase()).filter(Boolean).forEach((code) => wanted.add(code));
    wanted.forEach((code) => {
      const actual = known.get(code);
      if (actual) languageCodes.push(actual);
    });
  }
  // 显式给了语言范围、却一个代码都没对上时，保留空集合把候选全部过滤掉，而不是悄悄放宽成所有语言
  const languageSet = languageParam ? new Set(languageCodes) : null;

  const candidates = [];
  data.entries.forEach((entry) => {
    if (module && entry.module !== module) return;
    Object.keys(entry.translations).forEach((code) => {
      // 编辑已有文案时，正在改的这一格不算候选；同一条文案的其它语言译文照样可以拿来参考
      if (selfEntryId && entry.id === selfEntryId && (!selfLanguage || code === selfLanguage)) return;
      if (languageSet && !languageSet.has(code)) return;
      const value = entry.translations[code];
      if (typeof value !== 'string' || !value.trim()) return;
      const candidate = normalizeForCompare(value);
      const score = similarityScore(query, candidate);
      candidates.push({
        entryId: entry.id,
        module: entry.module,
        key: entry.key,
        language: code,
        text: value,
        score,
        exact: query === candidate,
      });
    });
  });

  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.score !== b.score) return a.score > b.score ? -1 : 1;
    if (a.key !== b.key) return a.key < b.key ? -1 : 1;
    if (a.language !== b.language) return a.language < b.language ? -1 : 1;
    return a.entryId < b.entryId ? -1 : 1;
  });

  const items = candidates.slice(0, limit).map((item) => ({
    entryId: item.entryId,
    module: item.module,
    key: item.key,
    language: item.language,
    text: item.text,
    score: item.score,
    exact: item.exact,
  }));
  return { text: typeof input.text === 'string' ? input.text : '', module: module || '', languages: languageCodes, limit, total: candidates.length, items };
}

function createEntry(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const module = validateModule(input.module);
  const key = validateKey(input.key);
  const translations = validateTranslations(input.translations, data.languages);
  const note = validateNote(input.note);
  const operator = validateOperator(input.operator, UNNAMED);
  assertKeyFree(data, module, key, '');

  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    module,
    key,
    translations,
    note,
    updatedBy: operator,
    createdAt: now,
    updatedAt: now,
  };
  data.entries.push(created);
  save(data);
  return created;
}

function updateEntry(id, payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const data = load();
  const found = data.entries.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');

  const module = input.module === undefined ? found.module : validateModule(input.module);
  const key = input.key === undefined ? found.key : validateKey(input.key);
  const translations = input.translations === undefined
    ? found.translations
    : validateTranslations(input.translations, data.languages);
  const note = input.note === undefined ? found.note : validateNote(input.note);
  const operator = validateOperator(input.operator, found.updatedBy);
  assertKeyFree(data, module, key, found.id);

  found.module = module;
  found.key = key;
  found.translations = translations;
  found.note = note;
  found.updatedBy = operator;
  found.updatedAt = new Date().toISOString();
  save(data);
  return found;
}

function deleteEntry(id) {
  const data = load();
  const index = data.entries.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'ENTRY_NOT_FOUND', '这条文案不存在或已被删除', '');
  const [removed] = data.entries.splice(index, 1);
  save(data);
  return { id: removed.id, key: removed.key };
}

module.exports = {
  listEntries,
  getEntry,
  findSimilarTranslations,
  createEntry,
  updateEntry,
  deleteEntry,
  validateModule,
  validateKey,
  validateTranslations,
  validateOperator,
};
