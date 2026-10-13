// 스토리 편집 화면 전체: 왼쪽 페이지 목록 + 가운데 장면 편집(본문, 선택지 카드)
// 설정/유효성 검사/구조도/미리보기는 모달로 열린다.
//
// 이 파일 안에 합쳐진 것들 (위에서 아래 순서):
//   1) ConfigPanel      — 스토리 설정(제목/태그/공개/스탯 등)
//   2) ValidationPanel  — 유효성 검사
//   3) SceneGraph       — 구조도(드래그 가능한 장면 카드)
//   4) PlayPreview      — 저장 전 미리보기 플레이
//   5) SceneForm        — 장면 하나 편집(본문 + 선택지 카드)
//   6) Editor (default) — 위 조각들을 조립하는 본체
import { useEffect, useMemo, useRef, useState, useCallback, memo } from 'react';
import { api, describeCondition, labelOf, startStory, advance, getAvailableChoices, enterScene, createInitialState, clampValue } from './lib.js';
import ImageUploader from './ImageUploader.jsx';

/* ═════════════════════════ 0) 공통 도우미 ═════════════════════════ */

const MAX_RANDOM_BRANCHES = 5; // 서버 한도 (랜덤 분기 최대 개수)
const BUCKET_TYPE = { stats: 'stat', resources: 'resource', factions: 'faction', items: 'item', flags: 'flag' };

// 선택지 하나가 가리키는 연결들: 고정(fixed) / 랜덤(random) / N번째 고정(visit)
function edgesOf(choice) {
  const out = [];
  if (Array.isArray(choice.to)) {
    for (const b of choice.to) if (b?.sceneId) out.push({ to: b.sceneId, kind: 'random' });
  } else if (choice.to) {
    out.push({ to: choice.to, kind: 'fixed' });
  }
  if (choice.fixedVisit?.sceneId) out.push({ to: choice.fixedVisit.sceneId, kind: 'visit' });
  return out;
}

// 선택지 하나가 가리키는 모든 장면 키
function targetsOf(choice) {
  return edgesOf(choice).map((e) => e.to);
}

// 선택지의 이동 대상이 비었거나 없는 장면을 가리키면 true
function choiceBroken(choice, scenes) {
  const main = Array.isArray(choice.to) ? choice.to.map((b) => b?.sceneId) : [choice.to];
  if (main.length === 0 || main.some((t) => !t || !scenes[t])) return true;
  return Boolean(choice.fixedVisit && !scenes[choice.fixedVisit.sceneId]);
}

// 시작 장면(과 스탯 onZero 장면)에서 갈 수 없는 장면들. 서버 validateStory 와 같은 규칙 (엔딩의 선택지는 무시)
function findUnreachable(scenes, startSceneId, config) {
  const seeds = [startSceneId, ...Object.values(config.stats ?? {}).map((d) => d?.onZero)].filter((k) => k && scenes[k]);
  const seen = new Set();
  const stack = [...seeds];
  while (stack.length > 0) {
    const key = stack.pop();
    if (seen.has(key)) continue;
    seen.add(key);
    const scene = scenes[key];
    if (scene.isEnding) continue;
    for (const choice of scene.choices ?? []) {
      for (const to of targetsOf(choice)) if (scenes[to] && !seen.has(to)) stack.push(to);
    }
  }
  return new Set(Object.keys(scenes).filter((k) => !seen.has(k)));
}

// 선택지 안의 oldKey 장면 연결을 newKey 로 바꾼다. newKey 가 ''(삭제)면 연결을 비우고 fixedVisit 은 통째로 지운다.
function remapChoice(choice, oldKey, newKey) {
  let out = choice;
  if (typeof choice.to === 'string') {
    if (choice.to === oldKey) out = { ...out, to: newKey };
  } else if (Array.isArray(choice.to) && choice.to.some((b) => b?.sceneId === oldKey)) {
    out = { ...out, to: choice.to.map((b) => (b?.sceneId === oldKey ? { ...b, sceneId: newKey } : b)) };
  }
  if (choice.fixedVisit?.sceneId === oldKey) {
    if (newKey) {
      out = { ...out, fixedVisit: { ...choice.fixedVisit, sceneId: newKey } };
    } else {
      const { fixedVisit, ...rest } = out; // 서버는 빈 sceneId 의 fixedVisit 을 오류로 보므로 지운다
      out = rest;
    }
  }
  return out;
}

// 조건/효과 목록에서 (type, oldKey) 항목의 key 를 newKey 로 바꾼다. 해당 항목이 없으면 같은 배열을 그대로 돌려준다.
function remapEntries(list, type, oldKey, newKey) {
  if (!Array.isArray(list) || !list.some((e) => e?.type === type && e.key === oldKey)) return list;
  return list.map((e) => (e?.type === type && e.key === oldKey ? { ...e, key: newKey } : e));
}

// 검사 메시지 속 '장면키' 중 실제로 있는 첫 번째 장면 (메시지는 항상 문제의 장면을 맨 앞에 적는다)
function jumpKeyOf(message, scenes) {
  for (const m of String(message).matchAll(/'([^']+)'/g)) {
    if (Object.prototype.hasOwnProperty.call(scenes, m[1])) return m[1];
  }
  return null;
}

// 조건/효과 목록에서 (type, key) 항목을 지운다. 해당 항목이 없으면 같은 배열을 그대로 돌려준다.
function removeEntries(list, type, key) {
  if (!Array.isArray(list) || !list.some((e) => e?.type === type && e.key === key)) return list;
  return list.filter((e) => !(e?.type === type && e.key === key));
}

// 모든 장면의 진입 효과 / 선택지 조건 / 선택지 효과 목록에 transform 을 적용한다. 하나도 안 바뀌면 같은 객체를 돌려준다.
function mapEntryLists(scenes, transform) {
  let any = false;
  const out = {};
  for (const [k, s] of Object.entries(scenes)) {
    const onEnter = transform(s.onEnter);
    const list = s.choices ?? [];
    const choices = list.map((c) => {
      const condition = transform(c.condition);
      const effects = transform(c.effects);
      if (condition === c.condition && effects === c.effects) return c;
      return { ...c, ...(condition !== c.condition ? { condition } : null), ...(effects !== c.effects ? { effects } : null) };
    });
    const changed = onEnter !== s.onEnter || choices.some((c, i) => c !== list[i]);
    if (changed) any = true;
    out[k] = changed ? { ...s, ...(onEnter !== s.onEnter ? { onEnter } : null), choices } : s;
  }
  return any ? out : scenes;
}

// "type:key" → [{ sceneKey, where }]  (설정 항목이 쓰이는 모든 곳)
function buildUsageIndex(scenes) {
  const index = new Map();
  const add = (list, sceneKey, where) => {
    for (const e of list ?? []) {
      if (!e?.type || !e.key) continue;
      const id = `${e.type}:${e.key}`;
      if (!index.has(id)) index.set(id, []);
      index.get(id).push({ sceneKey, where });
    }
  };
  for (const [sceneKey, s] of Object.entries(scenes)) {
    add(s.onEnter, sceneKey, '진입 효과');
    (s.choices ?? []).forEach((c, i) => {
      add(c.condition, sceneKey, `선택지 ${i + 1} 조건`);
      add(c.effects, sceneKey, `선택지 ${i + 1} 효과`);
    });
  }
  return index;
}

// 구조도 자동 정렬: 시작 장면(과 onZero 장면)에서 몇 걸음 떨어졌는지를 열로, 같은 열 안에서는 키 이름 순으로 세로로 쌓는다.
// 시작 장면에서 갈 수 없는 장면은 맨 오른쪽 열에 모은다. { 장면키: { x, y } } 를 돌려준다.
function autoLayout(scenes, startSceneId, config) {
  const keys = Object.keys(scenes).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
  const depth = {};
  const queue = [];
  for (const k of [startSceneId, ...Object.values(config.stats ?? {}).map((d) => d?.onZero)]) {
    if (k && scenes[k] && depth[k] === undefined) { depth[k] = 0; queue.push(k); }
  }
  for (let h = 0; h < queue.length; h += 1) {
    const k = queue[h];
    if (scenes[k].isEnding) continue;
    for (const c of scenes[k].choices ?? []) {
      for (const t of targetsOf(c)) {
        if (scenes[t] && depth[t] === undefined) { depth[t] = depth[k] + 1; queue.push(t); }
      }
    }
  }
  const orphanCol = Math.max(-1, ...Object.values(depth)) + 1;
  const rows = {};
  const pos = {};
  for (const k of keys) {
    const col = depth[k] ?? orphanCol;
    const row = rows[col] ?? 0;
    rows[col] = row + 1;
    pos[k] = { x: 40 + col * (NODE_W + 90), y: 40 + row * (NODE_H + 40) };
  }
  return pos;
}

// 미리보기: 원하는 장면에서, 원하는 시작 상태(스탯/소지품/플래그)로 시작한다. (lib.js 의 settle 과 같은 순서)
async function startPreviewAt(config, scene, loadScene, ov) {
  const state = createInitialState(config);
  for (const bucket of ['stats', 'resources', 'factions']) {
    for (const [key, n] of Object.entries(ov[bucket] ?? {})) {
      if (config[bucket]?.[key]) state[bucket][key] = clampValue(n, bucket, config[bucket][key]);
    }
  }
  for (const [key, n] of Object.entries(ov.inventory ?? {})) {
    if (!config.items?.[key]) continue;
    if (n > 0) state.inventory[key] = Math.min(99, Math.trunc(n));
    else delete state.inventory[key];
  }
  for (const [key, on] of Object.entries(ov.flags ?? {})) {
    if (config.flags?.[key]) state.flags[key] = Boolean(on);
  }
  let current = state;
  let currentScene = scene;
  for (let i = 0; i <= 5; i += 1) {
    const entered = enterScene(config, current, currentScene);
    current = entered.state;
    if (!entered.redirectTo) return { ok: true, state: current, scene: currentScene };
    const target = await loadScene(entered.redirectTo);
    if (!target) return { ok: false, message: `장면 '${entered.redirectTo}'을(를) 찾을 수 없습니다.` };
    currentScene = target;
  }
  return { ok: false, message: '스탯 리다이렉트가 끝나지 않습니다. onZero 장면을 확인하세요.' };
}

/** 숫자 입력칸: 범위 안의 값일 때만 부모에 반영하고, 입력 도중(예: "0.")에는 글자를 건드리지 않는다. */
function NumField({ value, onCommit, min, max, int = false, ...rest }) {
  const [text, setText] = useState(String(value));
  useEffect(() => { setText((t) => (Number(t) === value ? t : String(value))); }, [value]);
  function handle(e) {
    const raw = e.target.value;
    setText(raw);
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n))) onCommit(n);
  }
  return <input type="number" value={text} min={min} max={max} step={int ? 1 : 'any'} onChange={handle} onBlur={() => setText(String(value))} {...rest} />;
}

/** 장면 고르는 드롭다운 */
function SceneSelect({ value, scenes, order, pageOf, onChange, allowEmpty = true, label }) {
  const missing = value && !scenes[value];
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      {allowEmpty && <option value="">(연결 안 됨 — 끊긴 분기로 표시됩니다)</option>}
      {missing && <option value={value}>(없는 장면: {value})</option>}
      {order.map((key) => <option key={key} value={key}>P. {pageOf[key]} · {shortPreviewOf(scenes[key], key)}</option>)}
    </select>
  );
}

/* ═════════════════════════ 1) ConfigPanel ═════════════════════════ */

function BucketEditor({ title, bucket, config, setConfig, onRenameKey, onRemoveKey, usageIndex, pageOf, onGoto, numeric, help }) {
  const entries = Object.entries(config[bucket] ?? {});
  const [openKey, setOpenKey] = useState(null); // 사용처 목록을 펼친 항목

  function update(key, patch) {
    setConfig((prev) => ({ ...prev, [bucket]: { ...prev[bucket], [key]: { ...prev[bucket][key], ...patch } } }));
  }
  function rename(key) {
    const next = (prompt(`'${key}' 의 새 키 이름 (영문/숫자/_/- 40자 이하)`, key) ?? '').trim();
    if (!next || next === key) return;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(next) || ['__proto__', 'constructor', 'prototype'].includes(next)) {
      alert('영문/숫자/_/- 40자 이하만 가능합니다. (__proto__ 같은 예약어는 쓸 수 없어요)');
      return;
    }
    if (config[bucket]?.[next]) { alert('이미 있는 키입니다.'); return; }
    onRenameKey(bucket, key, next);
  }
  function add() {
    const key = prompt(`새 ${title} 키 (영문/숫자/_/- , 예: hp)`);
    if (!key) return;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(key)) { alert('영문/숫자/_/- 40자 이하만 가능합니다.'); return; }
    if (config[bucket]?.[key]) { alert('이미 있는 키입니다.'); return; }
    const def = numeric ? { label: key, initial: 0, min: 0, max: 100 } : { label: key };
    setConfig((prev) => ({ ...prev, [bucket]: { ...prev[bucket], [key]: def } }));
  }

  return (
    <div className="field">
      <div className="panel-title" style={{ fontSize: 13 }}>
        {title} ({entries.length})
        <button className="btn btn-small" onClick={add}>+ 추가</button>
      </div>
      {help && <div className="help">{help}</div>}
      {entries.map(([key, def]) => (
        <div key={key} className="list-item">
          <div className="list-item-head">
            <code style={{ fontSize: 11, color: 'var(--muted)' }}>{key}</code>
            <button type="button" className="link-btn" onClick={() => setOpenKey(openKey === key ? null : key)} title="이 항목을 쓰는 장면 보기">
              사용처 {(usageIndex?.get(`${BUCKET_TYPE[bucket]}:${key}`) ?? []).length}곳 {openKey === key ? '▲' : '▼'}
            </button>
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-small" onClick={() => rename(key)} title="키 이름 바꾸기 (조건·효과·시작 소지품에서 쓰는 곳도 같이 고쳐져요)">이름 바꾸기</button>
              <button className="btn btn-small btn-danger" onClick={() => onRemoveKey(bucket, key)}>삭제</button>
            </span>
          </div>
          {openKey === key && (
            <div className="entry-block" style={{ marginBottom: 6 }}>
              {(usageIndex?.get(`${BUCKET_TYPE[bucket]}:${key}`) ?? []).length === 0 && <div className="muted" style={{ fontSize: 12 }}>어떤 장면에서도 쓰지 않아요.</div>}
              {(usageIndex?.get(`${BUCKET_TYPE[bucket]}:${key}`) ?? []).map((u, i) => (
                <button key={i} type="button" className="link-btn" style={{ display: 'block', textAlign: 'left' }} onClick={() => onGoto(u.sceneKey)}>
                  P. {pageOf[u.sceneKey]} · {u.sceneKey} · {u.where} ↗
                </button>
              ))}
              {bucket === 'items' && config.startInventory?.[key] > 0 && <div className="muted" style={{ fontSize: 12 }}>시작 소지품 {config.startInventory[key]}개</div>}
            </div>
          )}
          <input value={def.label ?? ''} placeholder="이름(라벨)" onChange={(e) => update(key, { label: e.target.value })} style={{ marginBottom: 6 }} />
          {numeric && (
            <div className="row">
              <input type="number" value={def.initial ?? 0} placeholder="초기값" onChange={(e) => update(key, { initial: Number(e.target.value) })} />
              <input type="number" value={def.min ?? 0} placeholder="최소" onChange={(e) => update(key, { min: Number(e.target.value) })} />
              <input type="number" value={def.max ?? 100} placeholder="최대" onChange={(e) => update(key, { max: Number(e.target.value) })} />
            </div>
          )}
          {numeric && bucket === 'stats' && (
            <input
              style={{ marginTop: 6 }}
              value={def.onZero ?? ''}
              placeholder="onZero: 0 이하가 되면 이동할 장면 키 (선택)"
              onChange={(e) => update(key, { onZero: e.target.value || undefined })}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function StartInventoryEditor({ config, setConfig }) {
  const items = Object.keys(config.items ?? {});
  if (items.length === 0) return null;

  function setCount(key, count) {
    setConfig((prev) => {
      const next = { ...prev.startInventory };
      if (!count || count <= 0) delete next[key]; else next[key] = count;
      return { ...prev, startInventory: next };
    });
  }

  return (
    <div className="field">
      <label>시작 소지품</label>
      {items.map((key) => (
        <div key={key} className="row" style={{ marginBottom: 4 }}>
          <span style={{ flex: 2 }}>{config.items[key]?.label ?? key}</span>
          <input type="number" min="0" max="99" value={config.startInventory?.[key] ?? 0} onChange={(e) => setCount(key, Number(e.target.value))} />
        </div>
      ))}
    </div>
  );
}

function ConfigPanel({ meta, setMeta, config, setConfig, onRenameKey, onRemoveKey, usageIndex, pageOf, onGoto, isPublic, onVisibility, onDelete }) {
  const [tagInput, setTagInput] = useState('');

  function addTag() {
    const tag = tagInput.trim();
    if (!tag) return;
    if (meta.tags.length >= 5) { alert('태그는 최대 5개까지 가능합니다.'); return; }
    if (meta.tags.includes(tag)) { setTagInput(''); return; }
    setMeta((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setTagInput('');
  }
  function removeTag(tag) {
    setMeta((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  }

  return (
    <div>
      <div className="panel-title">스토리 설정</div>

      <div className="field">
        <label>제목</label>
        <input value={meta.title} maxLength={50} onChange={(e) => setMeta((p) => ({ ...p, title: e.target.value }))} />
      </div>
      <div className="field">
        <label>설명</label>
        <textarea rows={3} value={meta.description} maxLength={500} onChange={(e) => setMeta((p) => ({ ...p, description: e.target.value }))} />
      </div>
      <div className="field">
        <label>태그 (최대 5개)</label>
        <div className="row">
          <input value={tagInput} maxLength={20} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTag()} />
          <button className="btn btn-small" onClick={addTag} style={{ flex: '0 0 auto' }}>추가</button>
        </div>
        <div style={{ marginTop: 6 }}>
          {meta.tags.map((tag) => (
            <span key={tag} className="tag-pill" style={{ cursor: 'pointer' }} onClick={() => removeTag(tag)} title="클릭하면 삭제">{tag} ✕</span>
          ))}
        </div>
      </div>

      <div className="field">
        <label>공개 상태</label>
        <button className={`btn ${isPublic ? 'btn-primary' : ''}`} onClick={() => onVisibility(!isPublic)}>
          {isPublic ? '✅ 공개 중 (클릭하면 비공개로)' : '🔒 비공개 (클릭하면 공개로)'}
        </button>
      </div>

      <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />

      <BucketEditor title="스탯" bucket="stats" help={'플레이어의 몸과 마음 상태(체력, 정신력)예요. 0 아래로 떨어지면 정해 둔 장면(예: 사망 엔딩)으로 자동 이동시킬 수 있어요.'} config={config} setConfig={setConfig} numeric onRenameKey={onRenameKey} onRemoveKey={onRemoveKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={onGoto} />
      <BucketEditor title="자원" bucket="resources" help={'쓰고 모으는 소모품(식량, 필터, 탄약)이에요. 선택지 효과로 늘리거나 줄이고, 조건으로 ‘필터 1 이상일 때만’ 같은 제한을 걸 수 있어요.'} config={config} setConfig={setConfig} numeric onRenameKey={onRenameKey} onRemoveKey={onRemoveKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={onGoto} />
      <BucketEditor title="파벌" bucket="factions" help={'세력(한자 동맹, 레드라인 등)과의 호감도 수치예요. -100~100이고 시작은 보통 0이에요. 도와주면 올리고 배신하면 내려서, 호감도가 높을 때만 열리는 선택지나 엔딩을 만들 수 있어요.'} config={config} setConfig={setConfig} numeric onRenameKey={onRenameKey} onRemoveKey={onRemoveKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={onGoto} />
      <BucketEditor title="아이템" bucket="items" help={'개수를 세는 물건(방독면, 카드키)이에요. 효과로 얻거나 잃고, 조건으로 ‘방독면 1개 이상 필요’를 걸어요.'} config={config} setConfig={setConfig} onRenameKey={onRenameKey} onRemoveKey={onRemoveKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={onGoto} />
      <BucketEditor title="플래그" bucket="flags" help={'켜짐/꺼짐으로 기억하는 스위치예요. 숫자 없이 ‘그 일이 있었는지’만 저장해요(예: 시장 거래 완료, 비밀문 발견). 효과로 켜고 끄고, 조건으로 ‘켜져 있을 때만’ 또는 ‘꺼져 있을 때만’ 선택할 수 있게 해요. 한 번만 일어나야 하는 일에 쓰세요.'} config={config} setConfig={setConfig} onRenameKey={onRenameKey} onRemoveKey={onRemoveKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={onGoto} />
      <StartInventoryEditor config={config} setConfig={setConfig} />

      <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />
      <button className="btn btn-danger" onClick={onDelete}>스토리 삭제</button>
    </div>
  );
}

/* ═════════════════════════ 2) ValidationPanel ═════════════════════════ */

function ValidationItem({ msg, scenes, onGoto }) {
  const key = jumpKeyOf(msg, scenes);
  return (
    <li>
      {msg}{' '}
      {key && <button type="button" className="link-btn" onClick={() => onGoto(key)}>이동 ↗</button>}
    </li>
  );
}

function ValidationPanel({ config, scenes, startSceneId, validation, setValidation, onGoto }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const scenesToSend = {};
      for (const [key, scene] of Object.entries(scenes)) {
        const { id, ...rest } = scene;
        scenesToSend[key] = rest;
      }
      const report = await api.validateDraft({ startSceneId, config, scenes: scenesToSend });
      setValidation(report);
    } catch (err) {
      if (err.status === 400 && err.details) setError(err.details.join(' / '));
      else setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="panel-title" style={{ fontSize: 13 }}>
        유효성 검사
        <button className="btn btn-small" disabled={checking} onClick={check}>{checking ? '검사 중...' : '검사하기'}</button>
      </div>
      {error && <div className="validation-error">⚠️ 입력값 자체에 문제가 있습니다: {error}</div>}
      {validation && (
        <>
          <div className={validation.ok ? 'validation-ok' : 'validation-error'}>
            {validation.ok ? '✅ 통과 — 공개할 수 있습니다.' : '❌ 오류가 있어 공개할 수 없습니다.'}
          </div>
          {validation.errors.length > 0 && (
            <ul className="validation-list validation-error">{validation.errors.map((msg, i) => <ValidationItem key={i} msg={msg} scenes={scenes} onGoto={onGoto} />)}</ul>
          )}
          {validation.warnings.length > 0 && (
            <ul className="validation-list validation-warn">{validation.warnings.map((msg, i) => <ValidationItem key={i} msg={msg} scenes={scenes} onGoto={onGoto} />)}</ul>
          )}
        </>
      )}
    </div>
  );
}

/* ═════════════════════════ 3) SceneGraph ═════════════════════════ */

const NODE_W = 180, NODE_H = 70;

function SceneGraph({ scenes, selected, onSelect, startSceneId, onMove, onAddAt, unreachable }) {
  const canvasRef = useRef(null);
  const [dragging, setDragging] = useState(null); // { key, offsetX, offsetY }
  const [dragPos, setDragPos] = useState(null); // 드래그 중엔 여기만 갱신(로컬) — 뗄 때 한 번만 부모로 commit

  useEffect(() => {
    if (!dragging) return;
    function handleMove(e) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
      const y = e.clientY - rect.top + canvasRef.current.scrollTop;
      setDragPos({ x: Math.max(0, Math.round(x - dragging.offsetX)), y: Math.max(0, Math.round(y - dragging.offsetY)) });
    }
    function handleUp() {
      setDragPos((pos) => {
        if (pos) onMove(dragging.key, pos.x, pos.y); // 마지막 위치만 부모 state(scenes)에 1회 반영
        return null;
      });
      setDragging(null);
    }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [dragging, onMove]); // dragPos는 deps에서 제외 → 드래그 중 리스너 재등록 없음

  function onPointerDown(e, key) {
    const scene = scenes[key];
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
    const y = e.clientY - rect.top + canvasRef.current.scrollTop;
    setDragging({ key, offsetX: x - (scene.posX ?? 0), offsetY: y - (scene.posY ?? 0) });
    onSelect(key);
    e.stopPropagation();
  }

  function onCanvasDoubleClick(e) {
    if (!e.target.classList.contains('graph-canvas') && !e.target.classList.contains('graph-inner')) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
    const y = e.clientY - rect.top + canvasRef.current.scrollTop;
    onAddAt(Math.round(x - NODE_W / 2), Math.round(y - NODE_H / 2));
  }

  const entries = Object.entries(scenes);
  const edges = [];
  for (const [key, scene] of entries) {
    for (const choice of scene.choices ?? []) {
      for (const e of edgesOf(choice)) if (scenes[e.to]) edges.push({ from: key, to: e.to, kind: e.kind });
    }
  }
  const width = Math.max(1200, ...entries.map(([, s]) => (s.posX ?? 0) + NODE_W + 100), 0);
  const height = Math.max(800, ...entries.map(([, s]) => (s.posY ?? 0) + NODE_H + 100), 0);

  function center(key) {
    const s = scenes[key];
    return { x: (s.posX ?? 0) + NODE_W / 2, y: (s.posY ?? 0) + NODE_H / 2 };
  }

  return (
    <div ref={canvasRef} className="graph-canvas" onDoubleClick={onCanvasDoubleClick} title="빈 곳을 더블클릭하면 그 위치에 장면이 추가됩니다">
      <svg width={width} height={height} style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}>
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--border)" />
          </marker>
          <marker id="arrow-random" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--accent)" />
          </marker>
          <marker id="arrow-visit" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 Z" fill="var(--warn)" />
          </marker>
        </defs>
        {edges.map((edge, i) => {
          const a = center(edge.from), b = center(edge.to);
          const style = {
            fixed: { stroke: 'var(--border)', dash: undefined, marker: 'arrow' },
            random: { stroke: 'var(--accent)', dash: '8 5', marker: 'arrow-random' },
            visit: { stroke: 'var(--warn)', dash: '2 5', marker: 'arrow-visit' },
          }[edge.kind];
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={style.stroke} strokeDasharray={style.dash} strokeWidth="2" markerEnd={`url(#${style.marker})`} />;
        })}
      </svg>
      <div className="graph-inner" style={{ position: 'relative', width, height }}>
        {entries.map(([key, scene]) => {
          const isDraggingThis = dragging?.key === key && dragPos;
          const left = isDraggingThis ? dragPos.x : (scene.posX ?? 0);
          const top = isDraggingThis ? dragPos.y : (scene.posY ?? 0);
          return (
            <div
              key={key}
              className={`scene-node ${selected === key ? 'selected' : ''} ${scene.isEnding ? 'ending' : ''} ${key === startSceneId ? 'start-marker' : ''}`}
              style={unreachable?.has(key) ? { left, top, opacity: 0.5, borderStyle: 'dashed' } : { left, top }}
              title={unreachable?.has(key) ? '시작 장면에서 도달할 수 없는 장면입니다' : undefined}
              onPointerDown={(e) => onPointerDown(e, key)}
            >
              <div className="title">{key === startSceneId ? '🚩 ' : ''}{scene.isEnding ? '🏁 ' : ''}{key}</div>
              <div className="body-preview">{scene.body || '(본문 없음)'}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ═════════════════════════ 4) PlayPreview ═════════════════════════ */

function withIds(scenes) {
  const out = {};
  for (const [key, scene] of Object.entries(scenes)) out[key] = { ...scene, id: key };
  return out;
}

const EMPTY_OVERRIDE = { stats: {}, resources: {}, factions: {}, inventory: {}, flags: {} };

function PlayPreview({ config, scenes, startSceneId, storyTitle, order, pageOf, onClose }) {
  const scenesWithIds = withIds(scenes);
  const loadScene = async (id) => scenesWithIds[id] ?? null;

  const [state, setState] = useState(null);
  const [scene, setScene] = useState(null);
  const [error, setError] = useState(null);
  const [startKey, setStartKey] = useState(scenes[startSceneId] ? startSceneId : (order[0] ?? ''));
  const [ov, setOv] = useState(EMPTY_OVERRIDE); // 기본값과 다르게 시작하려고 바꾼 값만 담는다
  const hasOverride = Object.values(ov).some((o) => Object.keys(o).length > 0);
  const setOvField = (group, key, value) => setOv((prev) => ({ ...prev, [group]: { ...prev[group], [key]: value } }));

  function start() {
    const startScene = scenesWithIds[startKey];
    if (!startScene) { setError('시작 장면이 없습니다.'); return; }
    const run = startKey === startSceneId && !hasOverride
      ? startStory(config, startScene, loadScene) // 평소 시작 (실제 플레이와 똑같은 경로)
      : startPreviewAt(config, startScene, loadScene, ov);
    run.then((result) => {
      if (!result.ok) { setError(result.message); return; }
      setState(result.state); setScene(result.scene); setError(null);
    });
  }

  async function pick(index) {
    const result = await advance(config, state, scene, index, loadScene);
    if (!result.ok) { setError(result.message); return; }
    setState(result.state); setScene(result.scene); setError(null);
  }

  if (!state) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h3>▶ 미리보기: {storyTitle || '(제목 없음)'}</h3>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>저장하지 않은 현재 편집 내용으로 바로 플레이합니다. (Firestore에 영향 없음)</p>
          {error && <div className="validation-error">⚠️ {error}</div>}

          <div className="field" style={{ marginTop: 10 }}>
            <label>시작 장면 {startKey !== startSceneId && <span className="muted">· 원래 시작 장면이 아니에요</span>}</label>
            <SceneSelect value={startKey} allowEmpty={false} scenes={scenes} order={order} pageOf={pageOf} label="미리보기 시작 장면" onChange={setStartKey} />
          </div>
          <details className="scene-opts">
            <summary>시작 상태 바꾸기 {hasOverride && <span className="muted">· 바꾼 값 있음</span>}</summary>
            <div className="scene-opts-body">
              {['stats', 'resources', 'factions'].map((bucket) => Object.entries(config[bucket] ?? {}).map(([key, def]) => {
                const lo = Number.isFinite(def.min) ? def.min : (bucket === 'factions' ? -100 : 0);
                const hi = Number.isFinite(def.max) ? def.max : (bucket === 'resources' ? 99 : 100);
                return (
                  <div key={`${bucket}:${key}`} className="row" style={{ marginBottom: 4 }}>
                    <span style={{ flex: 2 }}>{def.label ?? key}</span>
                    <NumField value={ov[bucket][key] ?? clampValue(Number(def.initial) || 0, bucket, def)} min={lo} max={hi} onCommit={(n) => setOvField(bucket, key, n)} aria-label={`${def.label ?? key} 시작값`} />
                  </div>
                );
              }))}
              {Object.entries(config.items ?? {}).map(([key, def]) => (
                <div key={`item:${key}`} className="row" style={{ marginBottom: 4 }}>
                  <span style={{ flex: 2 }}>🎒 {def.label ?? key}</span>
                  <NumField value={ov.inventory[key] ?? (config.startInventory?.[key] ?? 0)} min={0} max={99} int onCommit={(n) => setOvField('inventory', key, n)} aria-label={`${def.label ?? key} 개수`} />
                </div>
              ))}
              {Object.entries(config.flags ?? {}).map(([key, def]) => (
                <label key={`flag:${key}`} className="check">
                  <input type="checkbox" checked={Boolean(ov.flags[key])} onChange={(e) => setOvField('flags', key, e.target.checked)} />
                  🚩 {def.label ?? key} 켜진 상태로 시작
                </label>
              ))}
              {hasOverride && <button type="button" className="link-btn" onClick={() => setOv(EMPTY_OVERRIDE)}>기본값으로 되돌리기</button>}
            </div>
          </details>

          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn btn-primary" onClick={start}>시작</button>
            <button className="btn" onClick={onClose}>닫기</button>
          </div>
        </div>
      </div>
    );
  }

  const choices = getAvailableChoices(config, state, scene);
  const statusParts = [];
  // 파벌(호감도)은 플레이어 화면에 수치로 노출하지 않는 게 기본 — 테스트 미리보기에서도 동일하게 숨김.
  // 내부 조건(condition)/엔딩 분기 로직에는 그대로 쓰이고, 숫자만 화면에 안 보일 뿐이다.
  for (const bucket of ['stats', 'resources']) {
    for (const [key, def] of Object.entries(config[bucket] ?? {})) {
      statusParts.push(`${def.label ?? key} ${state[bucket][key] ?? 0}`);
    }
  }
  const items = Object.entries(state.inventory).map(([key, n]) => `${config.items?.[key]?.label ?? key}×${n}`);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {state.station && <div className="badge" style={{ marginBottom: 8 }}>📍 {state.station}</div>}
        <p>{scene.body}</p>
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>{statusParts.join(' · ')}</p>
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>소지품: {items.length ? items.join(', ') : '없음'}</p>

        {state.ending ? (
          <div style={{ marginTop: 12 }}><strong>🏁 [{state.ending.type}] {state.ending.name}</strong></div>
        ) : (
          <div style={{ marginTop: 12 }}>
            {choices.length === 0 && <div className="validation-warn">⚠️ 선택지가 없습니다 (막다른 길).</div>}
            {choices.map((c) => (
              <button key={c.index} className={`btn choice-btn ${c.enabled ? '' : 'locked'}`} disabled={!c.enabled} onClick={() => pick(c.index)} title={c.lockedReason ?? ''}>
                {c.enabled ? '' : '🔒 '}{c.label}{c.lockedReason ? ` (${c.lockedReason})` : ''}
              </button>
            ))}
          </div>
        )}

        {error && <div className="validation-error" style={{ marginTop: 10 }}>⚠️ {error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={start}>처음부터 다시</button>
          <button className="btn" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}

/* ═════════════════════════ 5) SceneForm ═════════════════════════ */

// 아래 상수들은 src/bundle.js 의 LIMITS/MAX 를 손으로 옮겨 적은 것이다.
// 서버 쪽 값이 바뀌면 여기도 같이 맞춰야 한다 (화면 제한은 참고용일 뿐, 최종 검증은 항상 서버가 한다).
const LIMITS = { BODY: 1800, LABEL: 80, CHOICES: 5, STATION: 40, ENDING_NAME: 50, IMAGE_URL: 500, ENTRIES: 10 };
const ENTRY_TYPES = ['stat', 'resource', 'faction', 'item', 'flag'];
const TYPE_LABEL = { stat: '스탯', resource: '자원', faction: '파벌', item: '아이템', flag: '플래그' };
const COND_OPS = ['>=', '<=', '>', '<', '==', '!='];
const ENDING_TYPES = [{ value: 'good', label: '굿' }, { value: 'bad', label: '배드' }, { value: 'hidden', label: '히든' }];

function allKeysOf(config, type) {
  if (type === 'item') return Object.entries(config.items ?? {});
  if (type === 'flag') return Object.entries(config.flags ?? {});
  const bucket = { stat: 'stats', resource: 'resources', faction: 'factions' }[type];
  return Object.entries(config[bucket] ?? {});
}

function describeEffect(config, effect) {
  if (!effect.key) return '(항목 미선택)';
  const name = labelOf(config, effect.type, effect.key);
  if (effect.type === 'flag') return `${name} ${effect.value === false ? '끄기' : '켜기'}`;
  const delta = Number(effect.delta) || 0;
  return `${name} ${delta > 0 ? '+' : ''}${delta}`;
}

function chipOf(config, entry, kind) {
  if (kind === 'condition') {
    return { text: entry.key ? `🔒 ${describeCondition(config, entry)}` : '(항목 미선택)', tone: entry.key ? 'cond' : 'warn' };
  }
  const delta = Number(entry.delta) || 0;
  let tone = 'neutral';
  if (!entry.key) tone = 'warn';
  else if (entry.type === 'flag') tone = entry.value === false ? 'minus' : 'plus';
  else tone = delta > 0 ? 'plus' : delta < 0 ? 'minus' : 'neutral';
  return { text: describeEffect(config, entry), tone };
}

// 선택지 드롭다운용 짧은 미리보기 (26자에서 자름)
function shortPreviewOf(scene, key) {
  const line = String(scene?.body ?? '').split('\n').find((l) => l.trim()) ?? '';
  const text = line.trim() || `(본문 없음) ${key}`;
  return text.length > 26 ? `${text.slice(0, 26)}…` : text;
}

/** 내용 길이에 맞춰 높이가 자동으로 늘어나는 입력칸 */
function AutoText({ value, onChange, className, maxLength, placeholder, minHeight = 0 }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight + 2)}px`;
  }, [value, minHeight]);
  return <textarea ref={ref} className={className} rows={1} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/* ───────── 조건/효과 한 줄 ───────── */

function EntryRow({ entry, config, kind, onChange, onRemove }) {
  const options = allKeysOf(config, entry.type);
  return (
    <div className="row entry-row">
      <select value={entry.type} onChange={(e) => onChange({ ...entry, type: e.target.value, key: '' })} aria-label="종류">
        {ENTRY_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
      </select>
      <select value={entry.key ?? ''} onChange={(e) => onChange({ ...entry, key: e.target.value })} aria-label="항목">
        <option value="">(선택)</option>
        {options.map(([key, def]) => <option key={key} value={key}>{def.label ?? key}</option>)}
      </select>
      {entry.type === 'flag' ? (
        <select value={entry.value === false ? 'false' : 'true'} onChange={(e) => onChange({ ...entry, value: e.target.value === 'true' })} aria-label="상태">
          <option value="true">켜짐</option>
          <option value="false">꺼짐</option>
        </select>
      ) : kind === 'condition' ? (
        <>
          <select value={entry.op ?? '>='} onChange={(e) => onChange({ ...entry, op: e.target.value })} aria-label="비교">
            {COND_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input type="number" value={entry.value ?? 0} onChange={(e) => onChange({ ...entry, value: Number(e.target.value) })} aria-label="값" />
        </>
      ) : (
        <input type="number" placeholder="증감" value={entry.delta ?? 0} onChange={(e) => onChange({ ...entry, delta: Number(e.target.value) })} aria-label="증감" />
      )}
      <button type="button" className="icon-btn small" onClick={onRemove} aria-label="삭제">✕</button>
    </div>
  );
}

/** 평소에는 칩으로 요약해서 보여 주고, [편집]을 누르면 입력칸이 펼쳐진다. */
function EntryList({ label, list, config, kind, onChange }) {
  const [editing, setEditing] = useState(false);

  function update(i, entry) { const next = [...list]; next[i] = entry; onChange(next); }
  function remove(i) { onChange(list.filter((_, idx) => idx !== i)); }
  function add() {
    if (list.length >= LIMITS.ENTRIES) { alert(`최대 ${LIMITS.ENTRIES}개까지 가능합니다.`); return; }
    onChange([...list, kind === 'condition' ? { type: 'item', key: '', op: '>=', value: 1 } : { type: 'stat', key: '', delta: 0 }]);
    setEditing(true);
  }

  return (
    <div className="entry-block">
      <div className="entry-head">
        <span className="entry-label">{label}</span>
        <div className="chips">
          {list.length === 0 && <span className="muted">없음</span>}
          {!editing && list.map((entry, i) => {
            const chip = chipOf(config, entry, kind);
            return <span key={i} className={`chip ${chip.tone}`}>{chip.text}</span>;
          })}
        </div>
        {list.length === 0 && !editing ? (
          <button type="button" className="link-btn" onClick={add}>+ 추가</button>
        ) : (
          <button type="button" className="link-btn" onClick={() => setEditing((v) => !v)}>{editing ? '완료' : '편집'}</button>
        )}
      </div>
      {editing && (
        <div className="entry-edit">
          {list.map((entry, i) => (
            <EntryRow key={i} entry={entry} config={config} kind={kind} onChange={(e) => update(i, e)} onRemove={() => remove(i)} />
          ))}
          <button type="button" className="btn btn-small" onClick={add}>+ 추가 ({list.length}/{LIMITS.ENTRIES})</button>
        </div>
      )}
    </div>
  );
}

/* ───────── 선택지 카드 ───────── */

function ChoiceCard({ choice, index, isFirst, isLast, scenes, order, pageOf, config, onChange, onRemove, onMove, onGoto }) {
  const isRandom = Array.isArray(choice.to);
  const branches = isRandom ? choice.to : [];
  const totalWeight = branches.reduce((sum, b) => sum + (Number(b?.weight) > 0 ? Number(b.weight) : 0), 0);
  const target = !isRandom && choice.to && scenes[choice.to] ? choice.to : '';
  const fv = choice.fixedVisit ?? null;

  function setMode(mode) {
    if (mode === 'random' && !isRandom) onChange({ ...choice, to: [{ sceneId: choice.to || '', weight: 1 }] });
    if (mode === 'fixed' && isRandom) onChange({ ...choice, to: branches.find((b) => b?.sceneId)?.sceneId ?? '' });
  }
  function updateBranch(i, patch) { onChange({ ...choice, to: branches.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) }); }
  function removeBranch(i) { onChange({ ...choice, to: branches.filter((_, idx) => idx !== i) }); }
  function addBranch() {
    if (branches.length >= MAX_RANDOM_BRANCHES) { alert(`랜덤 분기는 최대 ${MAX_RANDOM_BRANCHES}개까지 가능합니다.`); return; }
    onChange({ ...choice, to: [...branches, { sceneId: '', weight: 1 }] });
  }
  function toggleFixedVisit(on) {
    if (on) { onChange({ ...choice, fixedVisit: { count: 2, sceneId: order[0] ?? '' } }); return; }
    const { fixedVisit, ...rest } = choice;
    onChange(rest);
  }

  return (
    <section className="card choice-card" aria-label={`선택지 ${index + 1}`}>
      <div className="card-head">
        <input
          className="choice-label" value={choice.label ?? ''} maxLength={LIMITS.LABEL}
          placeholder={`선택지 ${index + 1} 문구 (버튼에 표시됩니다)`}
          onChange={(e) => onChange({ ...choice, label: e.target.value })}
        />
        <button type="button" className="icon-btn" disabled={isFirst} onClick={() => onMove(-1)} title="위로 올리기" aria-label="선택지 위로">↑</button>
        <button type="button" className="icon-btn" disabled={isLast} onClick={() => onMove(1)} title="아래로 내리기" aria-label="선택지 아래로">↓</button>
        <button type="button" className="icon-btn" onClick={onRemove} title="이 선택지 삭제" aria-label="이 선택지 삭제">🗑</button>
      </div>

      <div className="target-row">
        <select value={isRandom ? 'random' : 'fixed'} onChange={(e) => setMode(e.target.value)} aria-label="이동 방식" style={{ flex: '0 0 auto' }}>
          <option value="fixed">고정 이동</option>
          <option value="random">랜덤 이동</option>
        </select>
        {!isRandom && (
          <>
            <span className={`page-pill ${target ? '' : 'broken'}`}>{target ? `P. ${pageOf[target]}` : 'P. ?'}</span>
            <SceneSelect value={choice.to ?? ''} scenes={scenes} order={order} pageOf={pageOf} label="이동할 페이지" onChange={(v) => onChange({ ...choice, to: v })} />
            {target && <button type="button" className="icon-btn" onClick={() => onGoto(target)} title="그 페이지로 이동" aria-label="그 페이지로 이동">↗</button>}
          </>
        )}
      </div>

      {isRandom && (
        <div className="entry-block">
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>고르면 가중치 비율대로 아래 장면 중 하나로 이동해요. (가중치 0.01~1000, 최대 {MAX_RANDOM_BRANCHES}개)</div>
          {branches.map((b, i) => {
            const ok = Boolean(b?.sceneId && scenes[b.sceneId]);
            const pct = totalWeight > 0 && Number(b?.weight) > 0 ? Math.round((Number(b.weight) / totalWeight) * 100) : 0;
            return (
              <div key={i} className="target-row">
                <span className={`page-pill ${ok ? '' : 'broken'}`}>{ok ? `P. ${pageOf[b.sceneId]}` : 'P. ?'}</span>
                <SceneSelect value={b?.sceneId ?? ''} scenes={scenes} order={order} pageOf={pageOf} label={`랜덤 분기 ${i + 1} 장면`} onChange={(v) => updateBranch(i, { sceneId: v })} />
                <NumField value={Number(b?.weight) > 0 ? Number(b.weight) : 1} min={0.01} max={1000} onCommit={(n) => updateBranch(i, { weight: n })} aria-label={`랜덤 분기 ${i + 1} 가중치`} style={{ flex: '0 0 72px', width: 72 }} />
                <span className="muted" style={{ flex: '0 0 auto', fontSize: 12, minWidth: 32, textAlign: 'right' }}>{pct}%</span>
                {ok && <button type="button" className="icon-btn" onClick={() => onGoto(b.sceneId)} title="그 페이지로 이동" aria-label="그 페이지로 이동">↗</button>}
                <button type="button" className="icon-btn small" disabled={branches.length <= 1} onClick={() => removeBranch(i)} title="이 분기 삭제" aria-label="이 분기 삭제">✕</button>
              </div>
            );
          })}
          <button type="button" className="btn btn-small" onClick={addBranch}>+ 분기 추가 ({branches.length}/{MAX_RANDOM_BRANCHES})</button>
        </div>
      )}

      <label className="check">
        <input type="checkbox" checked={Boolean(fv)} onChange={(e) => toggleFixedVisit(e.target.checked)} />
        N번째로 고르면 정해진 장면으로 이동 (위 설정보다 우선)
      </label>
      {fv && (
        <div className="target-row">
          <NumField value={Number.isInteger(fv.count) ? fv.count : 2} min={1} max={999} int onCommit={(n) => onChange({ ...choice, fixedVisit: { ...fv, count: n } })} aria-label="몇 번째" style={{ flex: '0 0 72px', width: 72 }} />
          <span className="muted" style={{ flex: '0 0 auto' }}>번째에는</span>
          <SceneSelect value={fv.sceneId ?? ''} allowEmpty={false} scenes={scenes} order={order} pageOf={pageOf} label="N번째에 이동할 페이지" onChange={(v) => onChange({ ...choice, fixedVisit: { ...fv, sceneId: v } })} />
          {fv.sceneId && scenes[fv.sceneId] && <button type="button" className="icon-btn" onClick={() => onGoto(fv.sceneId)} title="그 페이지로 이동" aria-label="그 페이지로 이동">↗</button>}
        </div>
      )}

      <EntryList label="조건" list={choice.condition ?? []} config={config} kind="condition" onChange={(v) => onChange({ ...choice, condition: v })} />
      <EntryList label="효과" list={choice.effects ?? []} config={config} kind="effect" onChange={(v) => onChange({ ...choice, effects: v })} />

      {(choice.condition ?? []).length > 0 && (
        <label className="check">
          <input type="checkbox" checked={Boolean(choice.hideWhenLocked)} onChange={(e) => onChange({ ...choice, hideWhenLocked: e.target.checked })} />
          조건을 못 채우면 선택지를 숨김 (끄면 🔒 잠금으로 보여 줌)
        </label>
      )}
    </section>
  );
}

/* ───────── 장면 전체 ───────── */

function SceneForm({ sceneKey, scene, scenes, order, pageOf, startSceneId, config, onChange, onDelete, onDuplicate, onSetStart, onRename, onGoto, unreachable }) {
  const choices = scene.choices ?? [];
  const isStart = sceneKey === startSceneId;

  function updateChoice(i, choice) { const next = [...choices]; next[i] = choice; onChange({ choices: next }); }
  function removeChoice(i) { onChange({ choices: choices.filter((_, idx) => idx !== i) }); }
  function moveChoice(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= choices.length) return;
    const next = [...choices];
    [next[i], next[j]] = [next[j], next[i]];
    onChange({ choices: next });
  }
  function addChoice() {
    if (choices.length >= LIMITS.CHOICES) { alert(`선택지는 최대 ${LIMITS.CHOICES}개까지 가능합니다.`); return; }
    onChange({ choices: [...choices, { label: '', to: '', condition: [], effects: [], hideWhenLocked: false }] });
  }

  return (
    <div className="scene-form">
      <div className="scene-meta">
        <span className="page-pill big">P. {pageOf[sceneKey]}</span>
        <code className="muted">{sceneKey}</code>
        {isStart && <span className="badge start">🚩 시작</span>}
        {scene.isEnding && <span className="badge end">🏁 엔딩</span>}
        <span className="spacer" />
        {!isStart && <button type="button" className="btn btn-small" onClick={onSetStart}>🚩 시작 장면으로</button>}
        <button
          type="button" className="btn btn-small" title="키 이름 바꾸기 (이 장면을 가리키는 선택지도 같이 고쳐져요)"
          onClick={() => { const next = prompt('새 키 이름 (영문/숫자/_/- 40자 이하)', sceneKey); if (next !== null) onRename(next); }}
        >✏️ 이름 바꾸기</button>
        <button type="button" className="btn btn-small" onClick={onDuplicate} title="이 장면을 똑같이 복제">복제</button>
        <button type="button" className="btn btn-small btn-danger-outline" onClick={onDelete}>삭제</button>
      </div>

      {unreachable && <div className="warn-box">⚠️ 시작 장면에서 어떤 선택으로도 올 수 없는 장면이에요. 다른 장면의 선택지에서 이 장면으로 연결해 주세요.</div>}

      <AutoText
        className="scene-body" value={scene.body ?? ''} maxLength={LIMITS.BODY} minHeight={160}
        placeholder="여기에 장면 본문을 쓰세요. 플레이어에게 가장 먼저 보이는 글입니다."
        onChange={(v) => onChange({ body: v })}
      />
      <div className="body-count">{(scene.body ?? '').length} / {LIMITS.BODY}</div>

      <details className="scene-opts">
        <summary>장면 설정 <span className="muted">장소 · 이미지 · 엔딩</span></summary>
        <div className="scene-opts-body">
          <div className="field">
            <label>장소 배지 (화면 상단에 뜸, 선택)</label>
            <input value={scene.station ?? ''} maxLength={LIMITS.STATION} onChange={(e) => onChange({ station: e.target.value || null })} />
          </div>
          <ImageUploader value={scene.imageUrl} onChange={(url) => onChange({ imageUrl: url })} />
          <label className="check">
            <input type="checkbox" checked={Boolean(scene.isEnding)} onChange={(e) => onChange({ isEnding: e.target.checked })} />
            이 장면은 엔딩입니다
          </label>
        </div>
      </details>

      {scene.isEnding ? (
        <section className="card">
          <div className="card-title">🏁 엔딩 정보</div>
          <div className="field">
            <label>엔딩 이름</label>
            <input value={scene.endingName ?? ''} maxLength={LIMITS.ENDING_NAME} onChange={(e) => onChange({ endingName: e.target.value || null })} />
          </div>
          <div className="field">
            <label>엔딩 종류</label>
            <select value={scene.endingType ?? ''} onChange={(e) => onChange({ endingType: e.target.value || null })}>
              <option value="">(선택)</option>
              {ENDING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        </section>
      ) : (
        <>
          <section className="card soft">
            <EntryList label="진입 효과" list={scene.onEnter ?? []} config={config} kind="effect" onChange={(v) => onChange({ onEnter: v })} />
            <div className="hint">이 장면에 들어오는 순간 자동으로 적용됩니다.</div>
          </section>

          <h3 className="section-title">선택지 <span className="muted">{choices.length} / {LIMITS.CHOICES}</span></h3>
          {choices.length === 0 && <div className="warn-box">⚠️ 선택지가 없습니다. 엔딩이 아니라면 막다른 길이라 공개할 수 없어요.</div>}
          {choices.map((choice, i) => (
            <ChoiceCard
              key={i} choice={choice} index={i} isFirst={i === 0} isLast={i === choices.length - 1} scenes={scenes} order={order} pageOf={pageOf} config={config}
              onChange={(c) => updateChoice(i, c)} onRemove={() => removeChoice(i)} onMove={(dir) => moveChoice(i, dir)} onGoto={onGoto}
            />
          ))}
          <button type="button" className="add-pill" onClick={addChoice} aria-label="선택지 추가">+ 선택지 추가</button>
        </>
      )}
    </div>
  );
}

/* ═════════════════════════ 6) Editor (본체) ═════════════════════════ */

const DESKTOP_QUERY = '(min-width: 901px)';
const AUTOSAVE_DELAY_MS = 2000; // 마지막 입력 후 이 시간이 지나면 자동 저장

let sceneCounter = 0;
function newSceneKey(scenes) {
  let key;
  do {
    sceneCounter += 1;
    key = `scene_${sceneCounter}`;
  } while (scenes[key]);
  return key;
}

// 사이드바에 보여 줄 한 줄 미리보기
function previewOf(scene, key) {
  const line = String(scene?.body ?? '').split('\n').find((l) => l.trim()) ?? '';
  return line.trim() || `(본문 없음) ${key}`;
}

// 막다른 길이거나 끊긴 선택지가 있는 장면인가
function hasProblem(scene, scenes) {
  if (scene.isEnding) return false;
  const choices = scene.choices ?? [];
  if (choices.length === 0) return true;
  return choices.some((c) => choiceBroken(c, scenes));
}

// 서버가 400으로 주는 "field: 메시지" 형식의 유효성 오류를,
// 유저가 바로 이해할 수 있는 한국어 문장으로 바꿔준다.
const VALIDATION_FIELD_LABELS = { title: '제목', description: '설명', tags: '태그' };
function friendlyValidationMessage(details) {
  if (!Array.isArray(details) || details.length === 0) return '입력값을 다시 확인해 주세요.';
  return details
    .map((d) => {
      const i = d.indexOf(':');
      if (i === -1) return d;
      const field = d.slice(0, i).trim();
      const msg = d.slice(i + 1).trim();
      return `${VALIDATION_FIELD_LABELS[field] ?? field}이(가) ${msg}`;
    })
    .join(' / ');
}

// 사이드바 한 줄: scene 객체 레퍼런스가 안 바뀌면(= 다른 장면을 편집 중이면) 리렌더 스킵
const ScenePageButton = memo(function ScenePageButton({ sceneKey, scene, pageNo, isStart, isCurrent, hasIssue, isOrphan, onSelect }) {
  return (
    <button type="button" className={`ed-page ${isCurrent ? 'active' : ''}`} style={isOrphan ? { opacity: 0.6 } : undefined} onClick={() => onSelect(sceneKey)}>
      <span className="ed-page-no">{pageNo}</span>
      <span className="ed-page-text">{previewOf(scene, sceneKey)}</span>
      <span className="ed-page-badges">
        {isStart && <span title="시작 장면">🚩</span>}
        {scene.isEnding && <span title="엔딩">🏁</span>}
        {hasIssue && <span title="막다른 길이거나 끊긴 선택지가 있습니다">⚠️</span>}
        {isOrphan && <span title="시작 장면에서 도달할 수 없는 장면입니다">🚫</span>}
      </span>
    </button>
  );
});

// ───── 되돌리기 / 저장 기록 / 내보내기·가져오기 도우미 ─────
const HISTORY_MAX_STEPS = 100; // 되돌리기 최대 단계
const HISTORY_BURST_MS = 800;  // 이 시간 안의 연속 입력은 한 단계로 묶는다
const newHist = () => ({ past: [], future: [], stable: null, burst: false, timer: null, expect: null });
const sameSnap = (a, b) => a.meta === b.meta && a.config === b.config && a.scenes === b.scenes && a.startSceneId === b.startSceneId;

function stripIds(scenes) {
  const out = {};
  for (const [key, scene] of Object.entries(scenes)) {
    const { id, ...rest } = scene;
    out[key] = rest;
  }
  return out;
}
const toStoryData = (snap) => ({ meta: snap.meta, config: snap.config, startSceneId: snap.startSceneId, scenes: stripIds(snap.scenes) });

// 저장 기록: 이 브라우저(localStorage)에만 남는다. 서버에는 올라가지 않는다.
const HIST_KEY = (storyId) => `haejung-hist:${storyId}`;
const HIST_MAX = 15;                 // 스토리마다 최근 15개
const HIST_GAP_MS = 5 * 60 * 1000;   // 자동 저장은 5분에 한 번만 기록 (수동 저장·충돌·가져오기는 항상 기록)
const HIST_MAX_BYTES = 400 * 1024;   // 한 개가 이보다 크면 기록을 건너뜀

function readHistory(storyId) {
  try {
    const list = JSON.parse(localStorage.getItem(HIST_KEY(storyId)) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushHistory(storyId, snap, force) {
  try {
    const list = readHistory(storyId);
    const last = list[list.length - 1];
    const data = toStoryData(snap);
    if (last && JSON.stringify(last.data) === JSON.stringify(data)) return; // 내용이 같으면 중복 기록 안 함
    if (!force && last && Date.now() - last.at < HIST_GAP_MS) return;
    const entry = { at: Date.now(), data };
    if (JSON.stringify(entry).length > HIST_MAX_BYTES) return;
    list.push(entry);
    while (list.length > HIST_MAX) list.shift();
    for (;;) {
      try {
        localStorage.setItem(HIST_KEY(storyId), JSON.stringify(list));
        return;
      } catch {
        if (list.length <= 1) return; // 저장 공간이 부족하면 오래된 것부터 버린다
        list.shift();
      }
    }
  } catch {
    /* localStorage 를 못 쓰는 환경이면 조용히 건너뜀 */
  }
}

/** 내보낸 JSON 파일(또는 저장 기록)이 쓸 수 있는 모양인지 확인한다. 세부 검증은 저장할 때 서버가 한다. */
function parseStoryJson(text) {
  let data;
  try { data = JSON.parse(text); } catch { return { error: 'JSON 파일이 아니에요.' }; }
  if (!data || typeof data !== 'object' || !data.scenes || typeof data.scenes !== 'object' || Array.isArray(data.scenes)) {
    return { error: '이 앱에서 내보낸 스토리 파일이 아니에요. (scenes 없음)' };
  }
  const entries = Object.entries(data.scenes);
  if (entries.length === 0) return { error: '장면이 하나도 없어요.' };
  if (entries.some(([, scene]) => !scene || typeof scene !== 'object' || Array.isArray(scene))) {
    return { error: '장면 데이터가 올바르지 않아요.' };
  }
  return { data };
}

function HistoryPanel({ storyId, onRestore }) {
  const [entries] = useState(() => readHistory(storyId).slice().reverse());
  return (
    <div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
        저장할 때마다 이 브라우저에 최근 {HIST_MAX}개까지 기록돼요. 다른 기기나 브라우저에서는 보이지 않아요.
      </p>
      {entries.length === 0 && <div className="muted">아직 기록이 없어요.</div>}
      {entries.map((entry, i) => (
        <div key={`${entry.at}-${i}`} className="monitor-row" style={{ alignItems: 'center' }}>
          <span>
            {new Date(entry.at).toLocaleString('ko-KR')}
            <span className="muted"> · 장면 {Object.keys(entry.data.scenes ?? {}).length}개 · {entry.data.meta?.title || '(제목 없음)'}</span>
          </span>
          <button type="button" className="btn btn-small" onClick={() => onRestore(entry)}>복원</button>
        </div>
      ))}
    </div>
  );
}

export default function Editor({ storyId, onBack }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [meta, setMeta] = useState({ title: '', description: '', tags: [] });
  const [config, setConfig] = useState({ stats: {}, resources: {}, factions: {}, items: {}, flags: {}, startInventory: {} });
  const [scenes, setScenes] = useState({});
  const [startSceneId, setStartSceneId] = useState('start');
  const [selected, setSelected] = useState(null);
  const [isPublic, setIsPublic] = useState(false);
  const [baseUpdatedAt, setBaseUpdatedAt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const [validation, setValidation] = useState(null);
  const [preview, setPreview] = useState(false);
  const [panel, setPanel] = useState(null); // null | 'settings' | 'validation' | 'graph'
  const [search, setSearch] = useState('');
  const [sideOpen, setSideOpen] = useState(() => window.matchMedia(DESKTOP_QUERY).matches);
  const contentRef = useRef(null);

  // ── 자동 저장용 ──
  const savedRef = useRef(null);      // 마지막으로 서버와 맞춘 시점의 스냅샷 (참조 비교용)
  const latestRef = useRef(null);     // 항상 최신 편집 내용
  const baseRef = useRef(0);          // 항상 최신 baseUpdatedAt
  const savingRef = useRef(false);    // 저장 중복 방지
  const conflictRef = useRef(false);  // 409(충돌) 후에는 자동 저장 중지
  const [saveTick, setSaveTick] = useState(0); // 저장이 끝난 뒤 변경분이 있는지 다시 확인시키는 용도
  latestRef.current = { meta, config, scenes, startSceneId };
  const histRef = useRef(newHist());          // 되돌리기/다시하기 스택
  const [, setHistTick] = useState(0);        // 되돌리기 버튼 활성/비활성 갱신용
  const [conflict, setConflict] = useState(false);
  const importRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    api.getStory(storyId)
      .then((data) => {
        const { story, scenes: loadedScenes } = data;
        const loadedMeta = { title: story.title, description: story.description, tags: story.tags };
        setMeta(loadedMeta);
        setConfig(story.config);
        setScenes(loadedScenes);
        setStartSceneId(story.startSceneId);
        setIsPublic(story.isPublic);
        setBaseUpdatedAt(story.updatedAt);
        setSelected(story.startSceneId in loadedScenes ? story.startSceneId : Object.keys(loadedScenes)[0] ?? null);
        savedRef.current = { meta: loadedMeta, config: story.config, scenes: loadedScenes, startSceneId: story.startSceneId };
        baseRef.current = story.updatedAt;
        conflictRef.current = false;
        setConflict(false);
        clearTimeout(histRef.current.timer);
        histRef.current = newHist();
        setHistTick((t) => t + 1);
        pushHistory(storyId, savedRef.current, true); // 열었을 때의 서버 내용을 기록으로 남김
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [storyId]);

  useEffect(load, [load]);

  // 장면을 바꾸면 본문 맨 위로
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [selected]);

  // 페이지 번호: 시작 장면이 P.0, 나머지는 키 이름 순서 (이름이 같으면 번호도 그대로라서 장면을 옮겨도 안 바뀐다)
  const order = useMemo(() => {
    const keys = Object.keys(scenes).sort((a, b) => a.localeCompare(b, 'ko', { numeric: true }));
    const at = keys.indexOf(startSceneId);
    if (at > 0) { keys.splice(at, 1); keys.unshift(startSceneId); }
    return keys;
  }, [scenes, startSceneId]);
  const pageOf = useMemo(() => Object.fromEntries(order.map((key, i) => [key, i])), [order]);

  const visibleKeys = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return order;
    return order.filter((key) => key.toLowerCase().includes(q) || String(scenes[key]?.body ?? '').toLowerCase().includes(q));
  }, [order, search, scenes]);

  // ScenePageButton에 scenes 전체 대신 boolean만 넘기기 위한 사전 계산
  const problemByKey = useMemo(
    () => Object.fromEntries(order.map((key) => [key, hasProblem(scenes[key], scenes)])),
    [order, scenes]
  );
  const unreachable = useMemo(() => findUnreachable(scenes, startSceneId, config), [scenes, startSceneId, config]);
  const usageIndex = useMemo(() => (panel === 'settings' ? buildUsageIndex(scenes) : null), [panel, scenes]);

  function closeSideOnMobile() {
    if (!window.matchMedia(DESKTOP_QUERY).matches) setSideOpen(false);
  }

  const selectScene = useCallback((key) => {
    setSelected(key);
    if (!window.matchMedia(DESKTOP_QUERY).matches) setSideOpen(false);
  }, []);

  function updateScene(key, patch) {
    setScenes((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function addScene() {
    const key = newSceneKey(scenes);
    const n = Object.keys(scenes).length;
    const scene = {
      id: key, body: '', imageUrl: null, station: null, isEnding: false,
      endingName: null, endingType: null, onEnter: [], choices: [],
      posX: (n % 4) * 260, posY: Math.floor(n / 4) * 180,
    };
    setScenes((prev) => ({ ...prev, [key]: scene }));
    setSelected(key);
    setSearch('');
    closeSideOnMobile();
  }

  function duplicateScene(key) {
    const src = scenes[key];
    if (!src) return;
    const nextKey = newSceneKey(scenes);
    const copy = JSON.parse(JSON.stringify(src)); // 선택지·조건·효과까지 완전히 독립된 복사본
    copy.id = nextKey;
    copy.posX = (src.posX ?? 0) + 40; // 구조도에서 원본 위에 겹치지 않게 살짝 옮긴다
    copy.posY = (src.posY ?? 0) + 40;
    setScenes((prev) => ({ ...prev, [nextKey]: copy }));
    setSelected(nextKey);
    setSearch('');
    setSaveMsg(`P.${pageOf[key]} 장면을 복제했어요.`);
  }

  function deleteScene(key) {
    if (key === startSceneId) { alert('시작 장면은 삭제할 수 없습니다. 먼저 다른 장면을 시작 장면으로 바꿔주세요.'); return; }
    let refs = 0;
    for (const [k, sc] of Object.entries(scenes)) {
      if (k !== key) for (const c of sc.choices ?? []) if (targetsOf(c).includes(key)) refs += 1;
    }
    const zeroStats = Object.entries(config.stats ?? {}).filter(([, d]) => d?.onZero === key).map(([k, d]) => d?.label || k);
    const notes = [`P.${pageOf[key]} '${key}' 장면을 삭제할까요?`];
    if (refs > 0) notes.push(`이 장면을 가리키는 선택지 ${refs}개는 연결이 끊어집니다.`);
    if (zeroStats.length > 0) notes.push(`스탯(${zeroStats.join(', ')})의 onZero 연결도 해제됩니다.`);
    if (!confirm(notes.join('\n'))) return;
    setScenes((prev) => {
      const next = { ...prev };
      delete next[key];
      for (const sceneKey of Object.keys(next)) {
        next[sceneKey] = { ...next[sceneKey], choices: (next[sceneKey].choices ?? []).map((c) => remapChoice(c, key, '')) };
      }
      return next;
    });
    setConfig((prev) => {
      const stats = prev.stats ?? {};
      if (!Object.values(stats).some((d) => d?.onZero === key)) return prev;
      return { ...prev, stats: Object.fromEntries(Object.entries(stats).map(([k, d]) => {
        if (d?.onZero !== key) return [k, d];
        const { onZero, ...rest } = d;
        return [k, rest];
      })) };
    });
    setSelected((cur) => (cur === key ? startSceneId : cur));
  }

  function renameScene(oldKey, rawName) {
    const newKey = String(rawName ?? '').trim();
    if (!newKey || newKey === oldKey) return;
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(newKey) || ['__proto__', 'constructor', 'prototype'].includes(newKey)) {
      alert('영문/숫자/_/- 40자 이하만 가능합니다. (__proto__ 같은 예약어는 쓸 수 없어요)');
      return;
    }
    if (scenes[newKey]) { alert(`'${newKey}' 는 이미 있는 장면 키입니다.`); return; }

    setScenes((prev) => {
      const next = {}; // 키 순서를 그대로 유지하려고 새로 쌓는다
      for (const [k, s] of Object.entries(prev)) {
        const list = s.choices ?? [];
        const choices = list.map((c) => remapChoice(c, oldKey, newKey));
        const changed = choices.some((c, i) => c !== list[i]);
        if (k === oldKey) next[newKey] = { ...s, id: newKey, choices };
        else next[k] = changed ? { ...s, choices } : s; // 안 바뀐 장면은 그대로 둬서 불필요한 다시 그리기를 막는다
      }
      return next;
    });
    setConfig((prev) => {
      const stats = prev.stats ?? {};
      if (!Object.values(stats).some((d) => d?.onZero === oldKey)) return prev;
      return { ...prev, stats: Object.fromEntries(Object.entries(stats).map(([k, d]) => [k, d?.onZero === oldKey ? { ...d, onZero: newKey } : d])) };
    });
    setStartSceneId((cur) => (cur === oldKey ? newKey : cur));
    setSelected((cur) => (cur === oldKey ? newKey : cur));
    setSaveMsg(`'${oldKey}' → '${newKey}' 로 바꿨어요.`);
  }

  // 스탯/자원/파벌/아이템/플래그 키 이름 바꾸기: 설정, 시작 소지품, 모든 장면의 진입 효과·조건·효과를 함께 고친다.
  function renameConfigKey(bucket, oldKey, newKey) {
    const type = BUCKET_TYPE[bucket];
    if (!type) return;
    const renameIn = (obj) => Object.fromEntries(Object.entries(obj ?? {}).map(([k, v]) => [k === oldKey ? newKey : k, v]));
    setConfig((prev) => {
      const next = { ...prev, [bucket]: renameIn(prev[bucket]) };
      if (bucket === 'items' && prev.startInventory && oldKey in prev.startInventory) next.startInventory = renameIn(prev.startInventory);
      return next;
    });
    setScenes((prev) => mapEntryLists(prev, (list) => remapEntries(list, type, oldKey, newKey)));
    setSaveMsg(`키 '${oldKey}' → '${newKey}' 로 바꿨어요.`);
  }

  // 설정 항목 삭제: 쓰이는 곳이 있으면 몇 군데인지 알려 주고, 확인하면 조건/효과/시작 소지품에서도 같이 지운다.
  function removeConfigKey(bucket, key) {
    const type = BUCKET_TYPE[bucket];
    if (!type) return;
    const uses = buildUsageIndex(scenes).get(`${type}:${key}`) ?? [];
    const inStart = bucket === 'items' && Number(config.startInventory?.[key]) > 0;
    if (uses.length > 0 || inStart) {
      const notes = [`'${key}' 항목을 삭제할까요?`];
      if (uses.length > 0) notes.push(`이 항목을 쓰는 곳 ${uses.length}군데(진입 효과·선택지 조건·효과)에서도 함께 지워집니다.`);
      if (inStart) notes.push('시작 소지품에서도 빠집니다.');
      if (!confirm(notes.join('\n'))) return;
    }
    setConfig((prev) => {
      const nextBucket = { ...prev[bucket] };
      delete nextBucket[key];
      const next = { ...prev, [bucket]: nextBucket };
      if (bucket === 'items' && prev.startInventory && key in prev.startInventory) {
        const inv = { ...prev.startInventory };
        delete inv[key];
        next.startInventory = inv;
      }
      return next;
    });
    if (uses.length > 0) setScenes((prev) => mapEntryLists(prev, (list) => removeEntries(list, type, key)));
    if (uses.length > 0) setSaveMsg(`'${key}' 항목과 쓰이던 ${uses.length}곳을 지웠어요.`);
  }

  // 구조도 자동 정렬 (한 번에 반영하므로 되돌리기 한 번으로 원상복구)
  function autoArrange() {
    if (!confirm('모든 장면 카드를 자동으로 정렬할까요? (Ctrl+Z로 되돌릴 수 있어요)')) return;
    setScenes((prev) => {
      const pos = autoLayout(prev, startSceneId, config);
      return Object.fromEntries(Object.entries(prev).map(([k, sc]) => [k, { ...sc, posX: pos[k].x, posY: pos[k].y }]));
    });
  }

  function isDirty() {
    const s = savedRef.current, n = latestRef.current;
    return Boolean(s) && (s.meta !== n.meta || s.config !== n.config || s.scenes !== n.scenes || s.startSceneId !== n.startSceneId);
  }

  // auto=true 이면 조용히 저장(변경이 없으면 건너뜀), false 이면 기존 [저장] 버튼 동작
  async function save({ auto = false } = {}) {
    if (savingRef.current) return false;
    if (auto && !isDirty()) return true;
    const snap = latestRef.current; // 저장하는 동안 편집이 이어져도 "보낸 내용"을 기준으로 삼는다

    // 제목이 비어 있으면 서버까지 가기 전에 먼저 알려준다 (가장 흔한 저장 실패 원인).
    if (!snap.meta.title.trim()) {
      setSaveMsg(auto ? '⚠️ 제목이 비어 있어 자동 저장을 건너뛰었어요.' : '⚠️ 제목을 입력해 주세요. (스토리 설정에서 입력)');
      if (!auto) setPanel('settings');
      return false;
    }

    savingRef.current = true;
    if (!auto) { setSaving(true); setSaveMsg(null); }
    try {
      await api.updateStory(storyId, { title: snap.meta.title, description: snap.meta.description, tags: snap.meta.tags, baseUpdatedAt: baseRef.current });
      const scenesToSend = {};
      for (const [key, scene] of Object.entries(snap.scenes)) {
        const { id, ...rest } = scene;
        scenesToSend[key] = rest;
      }
      const result = await api.saveScenes(storyId, { scenes: scenesToSend, config: snap.config, startSceneId: snap.startSceneId, baseUpdatedAt: baseRef.current });
      baseRef.current = result.updatedAt;
      setBaseUpdatedAt(result.updatedAt);
      savedRef.current = snap;
      setValidation(result.validation);
      setSaveMsg(auto ? `자동 저장됨 · ${new Date().toLocaleTimeString('ko-KR')}` : '저장했습니다.');
      pushHistory(storyId, snap, !auto);
      setSaveTick((t) => t + 1); // 저장 중에 또 고친 내용이 있으면 다시 예약
      return true;
    } catch (err) {
      if (err.status === 409) {
        conflictRef.current = true;
        setConflict(true);
        pushHistory(storyId, snap, true); // 충돌이 나도 내 내용은 저장 기록에 남겨 둔다
        setSaveMsg(auto ? '다른 곳에서 먼저 수정되어 자동 저장을 멈췄어요. 새로고침 후 다시 시도하세요.' : '다른 곳에서 먼저 수정되었습니다. 새로고침 후 다시 시도하세요.');
      } else if (err.status === 422) {
        setValidation(err.validation);
        setSaveMsg('공개 중인 스토리는 오류가 없어야 저장됩니다. 비공개로 바꾼 뒤 다시 시도하세요.');
      } else if (err.status === 400) {
        // 서버 쪽 유효성 검사 실패 (예: 제목 50자 초과, 태그 형식 오류 등) — 원인을 설정 화면과 함께 보여준다.
        setSaveMsg(`${auto ? '자동 저장 실패: ' : ''}⚠️ ${friendlyValidationMessage(err.details)}`);
        if (!auto) setPanel('settings');
      } else {
        setSaveMsg(`${auto ? '자동 ' : ''}저장 실패: ${err.message}`);
      }
      return false; // 실패 시 saveTick 을 올리지 않음 → 다음 편집 때까지 재시도 안 함(무한 재시도 방지)
    } finally {
      savingRef.current = false;
      if (!auto) setSaving(false);
    }
  }

  function handleSave() { return save({ auto: false }); }

  // 뒤로 가기: 저장 안 된 변경이 있으면 먼저 저장하고, 실패하면 확인을 받는다
  async function handleBack() {
    while (savingRef.current) await new Promise((r) => setTimeout(r, 100));
    if (isDirty()) {
      const ok = !isPublic && (await save({ auto: true }));
      if (!ok && !confirm('저장하지 않은 변경 사항이 있어요. 저장하지 않고 나갈까요?')) return;
    }
    onBack();
  }

  // 자동 저장: 편집 내용이 바뀌면 타이머를 다시 걸고, 조용해지면 저장 (공개 스토리는 제외)
  useEffect(() => {
    if (loading || isPublic || conflictRef.current || !isDirty()) return undefined;
    const timer = setTimeout(() => save({ auto: true }), AUTOSAVE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [loading, isPublic, meta, config, scenes, startSceneId, saveTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // 탭 닫기/새로고침 시 저장 안 된 내용이 있으면 브라우저 경고
  useEffect(() => {
    function warn(e) {
      if (isDirty()) { e.preventDefault(); e.returnValue = ''; }
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 되돌리기 / 다시하기 ──
  function applySnapshot(snap) {
    const h = histRef.current;
    clearTimeout(h.timer);
    h.burst = false;
    h.expect = snap;
    setMeta(snap.meta);
    setConfig(snap.config);
    setScenes(snap.scenes);
    setStartSceneId(snap.startSceneId);
    setSelected((cur) => (snap.scenes[cur] ? cur : (snap.startSceneId in snap.scenes ? snap.startSceneId : Object.keys(snap.scenes)[0] ?? null)));
    setHistTick((t) => t + 1);
  }

  // 가져오기·복원처럼 큰 작업은 직전 입력과 한 단계로 묶이지 않도록, 진행 중인 묶음을 먼저 닫는다
  function closeHistBurst() {
    const h = histRef.current;
    clearTimeout(h.timer);
    h.stable = latestRef.current;
    h.burst = false;
  }

  function undo() {
    const h = histRef.current;
    if (h.past.length === 0) return;
    const cur = h.expect ?? latestRef.current;
    h.future.push(cur);
    applySnapshot(h.past.pop());
  }

  function redo() {
    const h = histRef.current;
    if (h.future.length === 0) return;
    const cur = h.expect ?? latestRef.current;
    h.past.push(cur);
    applySnapshot(h.future.pop());
  }

  // 편집 내용이 바뀌면 "바뀌기 직전 상태"를 되돌리기 스택에 넣는다 (연속 입력은 한 단계로 묶음)
  useEffect(() => {
    if (loading) return;
    const h = histRef.current;
    const cur = { meta, config, scenes, startSceneId };
    if (!h.stable || (h.expect && sameSnap(h.expect, cur))) { h.stable = cur; h.expect = null; return; } // 불러오기/되돌리기 결과는 기록하지 않음
    if (sameSnap(h.stable, cur)) return;
    h.expect = null;
    if (!h.burst) {
      h.past.push(h.stable);
      if (h.past.length > HISTORY_MAX_STEPS) h.past.shift();
      h.future = [];
      h.burst = true;
      setHistTick((t) => t + 1);
    }
    clearTimeout(h.timer);
    h.timer = setTimeout(() => { h.stable = latestRef.current; h.burst = false; }, HISTORY_BURST_MS);
  }, [loading, meta, config, scenes, startSceneId]);

  // 단축키: Ctrl/Cmd + S 저장, Ctrl/Cmd + Z 되돌리기, Ctrl/Cmd + Shift + Z (또는 Y) 다시하기
  useEffect(() => {
    function onKey(e) {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); save({ auto: false }); }
      else if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(histRef.current.timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── 내보내기 / 가져오기 ──
  function exportJson() {
    const snap = latestRef.current;
    const data = { format: 'haejung-story', version: 1, exportedAt: new Date().toISOString(), ...toStoryData(snap) };
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const name = (snap.meta.title || 'story').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function applyStoryData(data) {
    const nextScenes = {};
    for (const [key, scene] of Object.entries(data.scenes)) nextScenes[key] = { ...scene, id: key };
    const start = data.startSceneId in nextScenes ? data.startSceneId : Object.keys(nextScenes)[0];
    const m = data.meta ?? {};
    setMeta({
      title: String(m.title ?? '').slice(0, 50),
      description: String(m.description ?? '').slice(0, 500),
      tags: Array.isArray(m.tags) ? m.tags.filter((t) => typeof t === 'string').slice(0, 5) : [],
    });
    setConfig({ stats: {}, resources: {}, factions: {}, items: {}, flags: {}, startInventory: {}, ...(data.config && typeof data.config === 'object' ? data.config : {}) });
    setScenes(nextScenes);
    setStartSceneId(start);
    setSelected(start);
    setSearch('');
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일을 다시 골라도 동작하도록 비운다
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { alert('파일이 너무 커요. (5MB 이하만 가능)'); return; }
    const parsed = parseStoryJson(await file.text());
    if (parsed.error) { alert(`가져오기 실패: ${parsed.error}`); return; }
    const n = Object.keys(parsed.data.scenes).length;
    if (!confirm(`현재 편집 중인 내용을 이 파일(장면 ${n}개)로 바꿀까요?\n되돌리기(Ctrl+Z)로 취소할 수 있어요.`)) return;
    pushHistory(storyId, latestRef.current, true);
    closeHistBurst();
    applyStoryData(parsed.data);
    closeSideOnMobile();
    setSaveMsg(isPublic ? '파일을 가져왔어요. [저장]을 눌러야 반영돼요.' : '파일을 가져왔어요. 곧 자동 저장돼요.');
  }

  function restoreFromHistory(entry) {
    if (!confirm(`${new Date(entry.at).toLocaleString('ko-KR')} 시점으로 복원할까요?\n지금 내용은 기록에 남기고, 되돌리기(Ctrl+Z)로도 취소할 수 있어요.`)) return;
    const parsed = parseStoryJson(JSON.stringify(entry.data));
    if (parsed.error) { alert(`복원 실패: ${parsed.error}`); return; }
    pushHistory(storyId, latestRef.current, true);
    closeHistBurst();
    applyStoryData(parsed.data);
    setPanel(null);
    setSaveMsg(isPublic ? '복원했어요. [저장]을 눌러야 반영돼요.' : '복원했어요. 곧 자동 저장돼요.');
  }

  // 충돌(409) 후: 서버의 최신 내용으로 다시 시작
  function reloadFromServer() {
    if (!confirm('서버에 저장된 최신 내용을 불러오면 지금 편집 중인 내용은 화면에서 사라져요.\n(내 내용은 🕘 저장 기록에도 남아 있어요.) 계속할까요?')) return;
    pushHistory(storyId, latestRef.current, true);
    load();
  }

  async function handleVisibility(next) {
    try {
      const result = await api.setVisibility(storyId, next);
      setIsPublic(result.isPublic);
      setBaseUpdatedAt(result.updatedAt);
      if (result.validation) setValidation(result.validation);
      setSaveMsg(next ? '공개로 전환했습니다.' : '비공개로 전환했습니다.');
    } catch (err) {
      if (err.status === 422) { setValidation(err.validation); setSaveMsg('오류를 모두 고쳐야 공개할 수 있습니다.'); }
      else setSaveMsg(`전환 실패: ${err.message}`);
    }
  }

  async function handleDelete() {
    if (!confirm('정말 이 스토리를 삭제할까요? 되돌릴 수 없습니다.')) return;
    try {
      await api.deleteStory(storyId);
      onBack();
    } catch (err) {
      setSaveMsg(`삭제 실패: ${err.message}`);
    }
  }

  if (loading) return <div style={{ padding: 20 }}>불러오는 중...</div>;
  if (error) return <div style={{ padding: 20 }}>⚠️ {error}</div>;

  const current = selected && scenes[selected] ? selected : null;

  return (
    <div className={`ed-shell ${sideOpen ? 'side-open' : ''}`}>
      {/* ───────── 왼쪽: 페이지 목록 ───────── */}
      <aside className="ed-side">
        <div className="ed-side-head">
          <button type="button" className="ed-back" onClick={handleBack} title="내 스토리로 돌아가기">
            <span aria-hidden="true">‹</span> {meta.title || '(제목 없음)'}
          </button>
          <button type="button" className="icon-btn" onClick={() => setPanel('settings')} title="스토리 설정" aria-label="스토리 설정">⚙</button>
        </div>

        <div className="ed-side-title">
          페이지 <span className="muted">{order.length}</span>
        </div>
        <input className="ed-search" placeholder="페이지 검색 (번호 키 본문)" value={search} onChange={(e) => setSearch(e.target.value)} />

        <div className="ed-pages">
          {visibleKeys.length === 0 && <div className="muted ed-pages-empty">검색 결과가 없습니다.</div>}
          {visibleKeys.map((key) => (
            <ScenePageButton
              key={key}
              sceneKey={key}
              scene={scenes[key]}
              pageNo={pageOf[key]}
              isStart={key === startSceneId}
              isCurrent={key === current}
              hasIssue={problemByKey[key]}
              isOrphan={unreachable.has(key)}
              onSelect={selectScene}
            />
          ))}
        </div>

        <div className="ed-side-foot">
          <button type="button" onClick={() => setPanel('graph')}>🗺 구조도 보기</button>
          <button type="button" onClick={() => setPanel('validation')}>
            ✅ 유효성 검사
            {validation && <span className={`dot ${validation.ok ? 'ok' : 'bad'}`} />}
          </button>
          <button type="button" onClick={() => setPanel('settings')}>⚙ 스토리 설정</button>
          <button type="button" onClick={() => setPanel('history')}>🕘 저장 기록</button>
          <button type="button" onClick={exportJson}>📤 파일로 내보내기</button>
          <button type="button" onClick={() => importRef.current?.click()}>📥 파일에서 가져오기</button>
          <input ref={importRef} type="file" accept="application/json,.json" hidden onChange={handleImportFile} />
        </div>
      </aside>
      <div className="ed-scrim" onClick={() => setSideOpen(false)} />

      {/* ───────── 가운데: 장면 편집 ───────── */}
      <main className="ed-main">
        <div className="ed-toolbar">
          <button type="button" className="icon-btn" onClick={() => setSideOpen((v) => !v)} title="페이지 목록 열기/닫기" aria-label="페이지 목록 열기/닫기">
            {sideOpen ? '«' : '☰'}
          </button>
          <button type="button" className="icon-btn" onClick={undo} disabled={histRef.current.past.length === 0} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">↶</button>
          <button type="button" className="icon-btn" onClick={redo} disabled={histRef.current.future.length === 0} title="다시 실행 (Ctrl+Shift+Z)" aria-label="다시 실행">↷</button>
          <div className="spacer" />
          {isPublic && !saveMsg && <span className="ed-msg muted">공개 중이라 자동 저장이 꺼져 있어요</span>}
          {saveMsg && <span className="ed-msg" role="status">{saveMsg}</span>}
          {conflict && (
            <>
              <button type="button" className="btn btn-small" onClick={exportJson}>내 내용 내려받기</button>
              <button type="button" className="btn btn-small btn-danger-outline" onClick={reloadFromServer}>서버 내용 불러오기</button>
            </>
          )}
          <button type="button" className="btn" onClick={() => setPreview(true)}>▶ 미리보기</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? '저장 중...' : '저장'}</button>
        </div>

        <div className="ed-content" ref={contentRef}>
          {current ? (
            <SceneForm
              key={current}
              sceneKey={current} scene={scenes[current]} scenes={scenes}
              order={order} pageOf={pageOf} startSceneId={startSceneId} config={config}
              onChange={(patch) => updateScene(current, patch)}
              onDelete={() => deleteScene(current)}
              onDuplicate={() => duplicateScene(current)}
              onRename={(name) => renameScene(current, name)}
              onSetStart={() => setStartSceneId(current)}
              onGoto={selectScene}
              unreachable={unreachable.has(current)}
            />
          ) : (
            <div className="ed-empty">
              <p>왼쪽 목록에서 페이지를 고르거나, 오른쪽 아래 <strong>+</strong> 버튼으로 새 페이지를 만드세요.</p>
            </div>
          )}
        </div>

        <button type="button" className="fab" onClick={addScene} title="새 페이지 추가" aria-label="새 페이지 추가">+</button>
      </main>

      {/* ───────── 모달들 ───────── */}
      {panel && (
        <div className="modal-backdrop" onClick={() => setPanel(null)}>
          <div className={`modal ${panel === 'graph' ? 'wide' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>{panel === 'settings' ? '스토리 설정' : panel === 'validation' ? '유효성 검사' : panel === 'history' ? '저장 기록' : '구조도'}</strong>
              <button type="button" className="icon-btn" onClick={() => setPanel(null)} aria-label="닫기">✕</button>
            </div>

            {panel === 'settings' && (
              <ConfigPanel meta={meta} setMeta={setMeta} config={config} setConfig={setConfig} onRenameKey={renameConfigKey} onRemoveKey={removeConfigKey} usageIndex={usageIndex} pageOf={pageOf} onGoto={(key) => { selectScene(key); setPanel(null); }} isPublic={isPublic} onVisibility={handleVisibility} onDelete={handleDelete} />
            )}
            {panel === 'validation' && (
              <ValidationPanel config={config} scenes={scenes} startSceneId={startSceneId} validation={validation} setValidation={setValidation} onGoto={(key) => { selectScene(key); setPanel(null); }} />
            )}
            {panel === 'history' && (
              <HistoryPanel storyId={storyId} onRestore={restoreFromHistory} />
            )}
            {panel === 'graph' && (
              <>
                <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
                  장면 카드를 끌어서 옮기고, 눌러서 선택하세요. 빈 곳을 더블클릭하면 새 페이지가 만들어집니다.
                  <br />연결선: 실선 = 고정 이동 · 파선 = 랜덤 이동 · 점선 = N번째 고정 이동 · 흐린 점선 카드 = 도달 불가
                </p>
                <div className="graph-wrap">
                  <SceneGraph
                    scenes={scenes} selected={current} onSelect={setSelected} startSceneId={startSceneId} unreachable={unreachable}
                    onMove={(key, posX, posY) => updateScene(key, { posX, posY })}
                    onAddAt={(x, y) => {
                      const key = newSceneKey(scenes);
                      setScenes((prev) => ({ ...prev, [key]: { id: key, body: '', imageUrl: null, station: null, isEnding: false, endingName: null, endingType: null, onEnter: [], choices: [], posX: x, posY: y } }));
                      setSelected(key);
                    }}
                  />
                </div>
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between' }}>
                  <button type="button" className="btn" onClick={autoArrange} title="시작 장면에서 가까운 순서로 카드를 가지런히 놓아요 (Ctrl+Z로 되돌릴 수 있어요)">🧹 자동 정렬</button>
                  <button type="button" className="btn btn-primary" onClick={() => setPanel(null)} disabled={!current}>
                    {current ? `P.${pageOf[current]} 편집하러 가기` : '닫기'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {preview && (
        <PlayPreview config={config} scenes={scenes} startSceneId={startSceneId} storyTitle={meta.title} order={order} pageOf={pageOf} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}