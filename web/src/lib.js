// 서버 통신(api) + 이야기 엔진(engine)을 한 파일로 합친 "공용 도구함".
//
// [1] api  — 백엔드(api/index.js, 즉 src/bundle.js의 createWebRouter)에 요청을 보내는 도우미.
//     운영에서는 /api가 같은 Vercel 배포에 있어서 같은 출처(same-origin)이고,
//     개발에서는 vite.config.js의 proxy가 /api를 로컬 Express 서버(3000번)로 넘겨준다.
// [2] engine — src/bundle.js 의 engine 부분을 그대로 복사한 "클라이언트용 사본"이다.
//     디스코드/Firestore를 모르는 순수 함수라서 그대로 브라우저에서 돈다.
//     ⚠️ 서버(src/bundle.js)의 엔진 로직을 고치면 이 파일의 [2] 부분도 손으로 같이 맞춰야 한다.

/* ═════════════════════════ [1] api ═════════════════════════ */

const CSRF_HEADER = 'x-requested-with';
const CSRF_VALUE = 'haejung'; // src/bundle.js WEB.CSRF_VALUE 와 반드시 같아야 한다

async function request(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && method !== 'HEAD') headers[CSRF_HEADER] = CSRF_VALUE;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error || `요청 실패 (HTTP ${res.status})`);
    err.status = res.status;
    err.details = data?.details;
    err.validation = data?.validation;
    err.currentUpdatedAt = data?.currentUpdatedAt;
    throw err;
  }
  return data;
}

export const api = {
  me: () => request('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }),
  myStories: () => request('/stories/mine'),
  createStory: (body) => request('/stories', { method: 'POST', body }),
  getStory: (id) => request(`/stories/${id}`),
  updateStory: (id, body) => request(`/stories/${id}`, { method: 'PUT', body }),
  saveScenes: (id, body) => request(`/stories/${id}/scenes`, { method: 'PUT', body }),
  validateStory: (id) => request(`/stories/${id}/validate`),
  validateDraft: (body) => request('/validate', { method: 'POST', body }),
  setVisibility: (id, isPublic) => request(`/stories/${id}/visibility`, { method: 'PATCH', body: { isPublic } }),
  deleteStory: (id) => request(`/stories/${id}`, { method: 'DELETE' }),
  // 둘러보기
  browse: (params) => request(`/browse?${params}`),
  setLike: (id, liked) => request(`/stories/${id}/like`, { method: 'PUT', body: { liked } }),
  endings: (id) => request(`/stories/${id}/endings`),
  // 관리자 (서버가 ADMIN_DISCORD_IDS 로 다시 확인한다. 운영자가 아니면 404)
  adminReports: (status) => request(`/admin/reports?status=${encodeURIComponent(status)}`),
  adminResolveReport: (id, status) => request(`/admin/reports/${encodeURIComponent(id)}`, { method: 'PUT', body: { status } }),
  adminHideStory: (id, hidden, reason) => request(`/admin/stories/${encodeURIComponent(id)}/hidden`, { method: 'PUT', body: { hidden, reason } }),
  adminBlockUser: (userId, blocked, reason) => request(`/admin/users/${encodeURIComponent(userId)}/blocked`, { method: 'PUT', body: { blocked, reason } }),
  // 관리자: 전체 스토리(작성자 ID로 좁힐 수 있음) / 숨긴 스토리 / 차단한 사용자. 응답에 디스코드 프로필(author)이 들어 있다.
  // 남의 스토리 편집/삭제는 일반 getStory/updateStory/saveScenes/deleteStory 를 그대로 쓴다. (서버가 운영자는 통과시킨다)
  adminStories: (authorId) => request(`/admin/stories${authorId ? `?authorId=${encodeURIComponent(authorId)}` : ''}`),
  adminHiddenStories: () => request('/admin/hidden-stories'),
  adminBlockedUsers: () => request('/admin/blocked-users'),
};

/** 디스코드 아바타 주소. 아바타가 없으면 디스코드 기본 아바타를 쓴다. */
export function avatarUrl(user, size = 64) {
  const id = String(user?.id ?? '');
  const validId = /^\d{5,25}$/.test(id);
  if (user?.avatar && validId && /^[A-Za-z0-9_]+$/.test(user.avatar)) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${id}/${user.avatar}.${ext}?size=${size}`;
  }
  const index = validId ? Number((BigInt(id) >> 22n) % 6n) : 0;
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

/* ═════════════════════════ [2] engine ═════════════════════════ */

export const NUMERIC_BUCKETS = { stat: 'stats', resource: 'resources', faction: 'factions' };
export const HISTORY_MAX = 100;
export const ITEM_MAX = 99;

const DEFAULT_RANGE = { stats: [0, 100], resources: [0, 99], factions: [-100, 100] };
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isSafeKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 40 && !BLOCKED_KEYS.has(key);
}

export function readOwn(obj, key, fallback) {
  if (obj && typeof key === 'string' && Object.hasOwn(obj, key)) return obj[key];
  return fallback;
}

export function clampValue(value, bucket, def = {}) {
  const [defMin, defMax] = DEFAULT_RANGE[bucket] ?? [0, 99];
  const min = Number.isFinite(def.min) ? def.min : defMin;
  const max = Number.isFinite(def.max) ? def.max : defMax;
  return Math.min(max, Math.max(min, value));
}

export function createInitialState(config = {}) {
  const state = { sceneId: null, station: null, stats: {}, resources: {}, factions: {}, inventory: {}, flags: {}, history: [], turn: 0, ending: null };
  for (const bucket of Object.values(NUMERIC_BUCKETS)) {
    for (const [key, def] of Object.entries(config[bucket] ?? {})) {
      if (!isSafeKey(key)) continue;
      state[bucket][key] = clampValue(Number(def.initial) || 0, bucket, def);
    }
  }
  for (const [key, count] of Object.entries(config.startInventory ?? {})) {
    if (isSafeKey(key) && Number(count) > 0) state.inventory[key] = Math.min(ITEM_MAX, Math.trunc(Number(count)));
  }
  return state;
}

const OPS = {
  '>=': (a, b) => a >= b, '<=': (a, b) => a <= b, '>': (a, b) => a > b,
  '<': (a, b) => a < b, '==': (a, b) => a === b, '!=': (a, b) => a !== b,
};

function compare(actual, op, expected) {
  const fn = OPS[op];
  if (!fn || typeof expected !== 'number' || Number.isNaN(expected)) return false;
  return fn(actual, expected);
}

export function checkCondition(state, cond) {
  if (!cond || typeof cond !== 'object') return false;
  const { type, key } = cond;
  if (type === 'flag') return Boolean(readOwn(state.flags, key, false)) === (cond.value ?? true);
  if (type === 'item') return compare(readOwn(state.inventory, key, 0), cond.op ?? '>=', cond.value ?? 1);
  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) return compare(readOwn(state[bucket], key, 0), cond.op ?? '>=', cond.value);
  return false;
}

export function checkConditions(state, conditions) {
  if (!Array.isArray(conditions) || conditions.length === 0) return true;
  return conditions.every((cond) => checkCondition(state, cond));
}

const OP_TEXT = { '>=': '이상', '<=': '이하', '>': '초과', '<': '미만', '==': '이어야 함', '!=': '이면 안 됨' };

export function labelOf(config, type, key) {
  const bucket = NUMERIC_BUCKETS[type];
  let table = null;
  if (bucket) table = config?.[bucket];
  else if (type === 'item') table = config?.items;
  else if (type === 'flag') table = config?.flags;
  return readOwn(readOwn(table, key, null), 'label', key);
}

export function describeCondition(config, cond) {
  const name = labelOf(config, cond.type, cond.key);
  if (cond.type === 'flag') return (cond.value ?? true) ? `${name} 상태 필요` : `${name} 상태가 아니어야 함`;
  if (cond.type === 'item') {
    const op = cond.op ?? '>=';
    const value = cond.value ?? 1;
    if (op === '>=' && value === 1) return `${name} 필요`;
    return `${name} ${value}${OP_TEXT[op] ?? ''}`;
  }
  return `${name} ${cond.value}${OP_TEXT[cond.op ?? '>='] ?? ''}`;
}

export function applyEffects(config, state, effects) {
  const next = structuredClone(state);
  const changes = [];
  if (Array.isArray(effects)) {
    for (const effect of effects) {
      if (!effect || !isSafeKey(effect.key)) continue;
      const change = applyOne(config, next, effect);
      if (change) changes.push(change);
    }
  }
  return { state: next, changes };
}

function applyOne(config, next, effect) {
  const { type, key } = effect;
  const label = labelOf(config, type, key);
  const bucket = NUMERIC_BUCKETS[type];
  if (bucket) {
    const def = readOwn(config?.[bucket], key, null);
    if (!def || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next[bucket], key, 0);
    const to = clampValue(from + Math.trunc(effect.delta), bucket, def);
    next[bucket][key] = to;
    return from === to ? null : { type, key, label, from, to };
  }
  if (type === 'item') {
    if (!readOwn(config?.items, key, null) || !Number.isFinite(effect.delta)) return null;
    const from = readOwn(next.inventory, key, 0);
    const to = Math.min(ITEM_MAX, Math.max(0, from + Math.trunc(effect.delta)));
    if (to === 0) delete next.inventory[key]; else next.inventory[key] = to;
    return from === to ? null : { type, key, label, from, to };
  }
  if (type === 'flag') {
    const to = Boolean(effect.value ?? true);
    const from = Boolean(readOwn(next.flags, key, false));
    if (to) next.flags[key] = true; else delete next.flags[key];
    return from === to ? null : { type, key, label, from, to };
  }
  return null;
}

const MAX_REDIRECTS = 5;
function fail(code, message) { return { ok: false, code, message }; }

export function getAvailableChoices(config, state, scene) {
  if (!scene || scene.isEnding) return [];
  const result = [];
  (scene.choices ?? []).forEach((choice, index) => {
    const unmet = (choice.condition ?? []).filter((cond) => !checkCondition(state, cond));
    const enabled = unmet.length === 0;
    if (!enabled && choice.hideWhenLocked) return;
    result.push({ index, label: choice.label, enabled, lockedReason: enabled ? null : unmet.map((cond) => describeCondition(config, cond)).join(', ') });
  });
  return result;
}

function findZeroRedirect(config, state) {
  for (const [key, def] of Object.entries(config?.stats ?? {})) {
    if (def.onZero && readOwn(state.stats, key, 0) <= (Number.isFinite(def.min) ? def.min : 0)) return def.onZero;
  }
  return null;
}

export function enterScene(config, state, scene) {
  const { state: next, changes } = applyEffects(config, state, scene.onEnter);
  next.sceneId = scene.id;
  if (scene.station) next.station = scene.station;
  let redirectTo = null;
  if (scene.isEnding) {
    next.ending = { sceneId: scene.id, name: scene.endingName ?? scene.id, type: scene.endingType ?? null };
  } else {
    redirectTo = findZeroRedirect(config, next);
  }
  return { state: next, changes, redirectTo };
}

async function settle(config, state, scene, loadScene) {
  let current = state, currentScene = scene;
  const changes = [];
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const entered = enterScene(config, current, currentScene);
    current = entered.state;
    changes.push(...entered.changes);
    if (!entered.redirectTo) return { ok: true, state: current, scene: currentScene, changes };
    const target = await loadScene(entered.redirectTo);
    if (!target) return fail('SCENE_NOT_FOUND', `장면 '${entered.redirectTo}'을(를) 찾을 수 없습니다.`);
    currentScene = target;
  }
  return fail('REDIRECT_LOOP', '스탯 리다이렉트가 끝나지 않습니다. onZero 장면을 확인하세요.');
}

export async function startStory(config, startScene, loadScene) {
  if (!startScene) return fail('SCENE_NOT_FOUND', '시작 장면이 없습니다.');
  return settle(config, createInitialState(config), startScene, loadScene);
}

export async function advance(config, state, scene, choiceIndex, loadScene) {
  if (state.ending) return fail('ALREADY_ENDED', '이미 끝난 이야기입니다.');
  if (!scene || state.sceneId !== scene.id) return fail('SCENE_MISMATCH', '지금 장면의 선택지가 아닙니다.');
  const choice = Number.isInteger(choiceIndex) ? scene.choices?.[choiceIndex] : null;
  if (scene.isEnding || !choice) return fail('INVALID_CHOICE', '존재하지 않는 선택지입니다.');
  if (!checkConditions(state, choice.condition)) return fail('LOCKED', '조건을 만족하지 못해 선택할 수 없습니다.');
  const target = await loadScene(choice.to);
  if (!target) return fail('SCENE_NOT_FOUND', `장면 '${choice.to}'을(를) 찾을 수 없습니다.`);
  const applied = applyEffects(config, state, choice.effects);
  const moved = applied.state;
  moved.turn += 1;
  moved.history.push({ from: scene.id, choice: choiceIndex });
  if (moved.history.length > HISTORY_MAX) moved.history.splice(0, moved.history.length - HISTORY_MAX);
  const settled = await settle(config, moved, target, loadScene);
  if (!settled.ok) return settled;
  return { ok: true, state: settled.state, scene: settled.scene, changes: [...applied.changes, ...settled.changes], ending: settled.state.ending };
}
