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
import { api, describeCondition, labelOf, startStory, advance, getAvailableChoices } from './lib.js';

/* ═════════════════════════ 1) ConfigPanel ═════════════════════════ */

function BucketEditor({ title, bucket, config, setConfig, numeric, help }) {
  const entries = Object.entries(config[bucket] ?? {});

  function update(key, patch) {
    setConfig((prev) => ({ ...prev, [bucket]: { ...prev[bucket], [key]: { ...prev[bucket][key], ...patch } } }));
  }
  function remove(key) {
    setConfig((prev) => {
      const next = { ...prev[bucket] };
      delete next[key];
      return { ...prev, [bucket]: next };
    });
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
            <button className="btn btn-small btn-danger" onClick={() => remove(key)}>삭제</button>
          </div>
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

function ConfigPanel({ meta, setMeta, config, setConfig, isPublic, onVisibility, onDelete }) {
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

      <BucketEditor title="스탯" bucket="stats" help={'플레이어의 몸과 마음 상태(체력, 정신력)예요. 0 아래로 떨어지면 정해 둔 장면(예: 사망 엔딩)으로 자동 이동시킬 수 있어요.'} config={config} setConfig={setConfig} numeric />
      <BucketEditor title="자원" bucket="resources" help={'쓰고 모으는 소모품(식량, 필터, 탄약)이에요. 선택지 효과로 늘리거나 줄이고, 조건으로 ‘필터 1 이상일 때만’ 같은 제한을 걸 수 있어요.'} config={config} setConfig={setConfig} numeric />
      <BucketEditor title="파벌" bucket="factions" help={'세력(한자 동맹, 레드라인 등)과의 호감도 수치예요. -100~100이고 시작은 보통 0이에요. 도와주면 올리고 배신하면 내려서, 호감도가 높을 때만 열리는 선택지나 엔딩을 만들 수 있어요.'} config={config} setConfig={setConfig} numeric />
      <BucketEditor title="아이템" bucket="items" help={'개수를 세는 물건(방독면, 카드키)이에요. 효과로 얻거나 잃고, 조건으로 ‘방독면 1개 이상 필요’를 걸어요.'} config={config} setConfig={setConfig} />
      <BucketEditor title="플래그" bucket="flags" help={'켜짐/꺼짐으로 기억하는 스위치예요. 숫자 없이 ‘그 일이 있었는지’만 저장해요(예: 시장 거래 완료, 비밀문 발견). 효과로 켜고 끄고, 조건으로 ‘켜져 있을 때만’ 또는 ‘꺼져 있을 때만’ 선택할 수 있게 해요. 한 번만 일어나야 하는 일에 쓰세요.'} config={config} setConfig={setConfig} />
      <StartInventoryEditor config={config} setConfig={setConfig} />

      <hr style={{ borderColor: 'var(--border)', margin: '16px 0' }} />
      <button className="btn btn-danger" onClick={onDelete}>스토리 삭제</button>
    </div>
  );
}

/* ═════════════════════════ 2) ValidationPanel ═════════════════════════ */

function ValidationPanel({ config, scenes, startSceneId, validation, setValidation }) {
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
            <ul className="validation-list validation-error">{validation.errors.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
          )}
          {validation.warnings.length > 0 && (
            <ul className="validation-list validation-warn">{validation.warnings.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
          )}
        </>
      )}
    </div>
  );
}

/* ═════════════════════════ 3) SceneGraph ═════════════════════════ */

const NODE_W = 180, NODE_H = 70;

function SceneGraph({ scenes, selected, onSelect, startSceneId, onMove, onAddAt }) {
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
      if (choice.to && scenes[choice.to]) edges.push({ from: key, to: choice.to });
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
        </defs>
        {edges.map((edge, i) => {
          const a = center(edge.from), b = center(edge.to);
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border)" strokeWidth="2" markerEnd="url(#arrow)" />;
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
              style={{ left, top }}
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

function PlayPreview({ config, scenes, startSceneId, storyTitle, onClose }) {
  const scenesWithIds = withIds(scenes);
  const loadScene = async (id) => scenesWithIds[id] ?? null;

  const [state, setState] = useState(null);
  const [scene, setScene] = useState(null);
  const [error, setError] = useState(null);

  function start() {
    const startScene = scenesWithIds[startSceneId];
    if (!startScene) { setError('시작 장면이 없습니다.'); return; }
    startStory(config, startScene, loadScene).then((result) => {
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
  for (const bucket of ['stats', 'resources', 'factions']) {
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

function ChoiceCard({ choice, index, scenes, order, pageOf, config, onChange, onRemove, onGoto }) {
  const target = choice.to && scenes[choice.to] ? choice.to : '';
  const missing = choice.to && !scenes[choice.to];
  return (
    <section className="card choice-card" aria-label={`선택지 ${index + 1}`}>
      <div className="card-head">
        <input
          className="choice-label" value={choice.label ?? ''} maxLength={LIMITS.LABEL}
          placeholder={`선택지 ${index + 1} 문구 (버튼에 표시됩니다)`}
          onChange={(e) => onChange({ ...choice, label: e.target.value })}
        />
        <button type="button" className="icon-btn" onClick={onRemove} title="이 선택지 삭제" aria-label="이 선택지 삭제">🗑</button>
      </div>

      <div className="target-row">
        <span className={`page-pill ${target ? '' : 'broken'}`}>{target ? `P. ${pageOf[target]}` : 'P. ?'}</span>
        <select value={choice.to ?? ''} onChange={(e) => onChange({ ...choice, to: e.target.value })} aria-label="이동할 페이지">
          <option value="">(연결 안 됨 — 끊긴 분기로 표시됩니다)</option>
          {missing && <option value={choice.to}>(없는 장면: {choice.to})</option>}
          {order.map((key) => <option key={key} value={key}>P. {pageOf[key]} · {shortPreviewOf(scenes[key], key)}</option>)}
        </select>
        {target && <button type="button" className="icon-btn" onClick={() => onGoto(target)} title="그 페이지로 이동" aria-label="그 페이지로 이동">↗</button>}
      </div>

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

function SceneForm({ sceneKey, scene, scenes, order, pageOf, startSceneId, config, onChange, onDelete, onSetStart, onGoto }) {
  const choices = scene.choices ?? [];
  const isStart = sceneKey === startSceneId;

  function updateChoice(i, choice) { const next = [...choices]; next[i] = choice; onChange({ choices: next }); }
  function removeChoice(i) { onChange({ choices: choices.filter((_, idx) => idx !== i) }); }
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
        <button type="button" className="btn btn-small btn-danger-outline" onClick={onDelete}>삭제</button>
      </div>

      <AutoText
        className="scene-body" value={scene.body ?? ''} maxLength={LIMITS.BODY} minHeight={160}
        placeholder="여기에 장면 본문을 쓰세요. 플레이어에게 가장 먼저 보이는 글입니다."
        onChange={(v) => onChange({ body: v })}
      />
      <div className="body-count">{(scene.body ?? '').length} / {LIMITS.BODY}</div>

      <details className="scene-opts">
        <summary>장면 설정 <span className="muted">역 이름 · 이미지 · 엔딩</span></summary>
        <div className="scene-opts-body">
          <div className="field">
            <label>역 이름 (표시용, 선택)</label>
            <input value={scene.station ?? ''} maxLength={LIMITS.STATION} onChange={(e) => onChange({ station: e.target.value || null })} />
          </div>
          <div className="field">
            <label>이미지 주소 (https만 가능, 선택)</label>
            <input value={scene.imageUrl ?? ''} maxLength={LIMITS.IMAGE_URL} onChange={(e) => onChange({ imageUrl: e.target.value || null })} />
          </div>
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
              key={i} choice={choice} index={i} scenes={scenes} order={order} pageOf={pageOf} config={config}
              onChange={(c) => updateChoice(i, c)} onRemove={() => removeChoice(i)} onGoto={onGoto}
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
  return choices.some((c) => !c.to || !scenes[c.to]);
}

// 사이드바 한 줄: scene 객체 레퍼런스가 안 바뀌면(= 다른 장면을 편집 중이면) 리렌더 스킵
const ScenePageButton = memo(function ScenePageButton({ sceneKey, scene, pageNo, isStart, isCurrent, hasIssue, onSelect }) {
  return (
    <button type="button" className={`ed-page ${isCurrent ? 'active' : ''}`} onClick={() => onSelect(sceneKey)}>
      <span className="ed-page-no">{pageNo}</span>
      <span className="ed-page-text">{previewOf(scene, sceneKey)}</span>
      <span className="ed-page-badges">
        {isStart && <span title="시작 장면">🚩</span>}
        {scene.isEnding && <span title="엔딩">🏁</span>}
        {hasIssue && <span title="막다른 길이거나 끊긴 선택지가 있습니다">⚠️</span>}
      </span>
    </button>
  );
});

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

  const load = useCallback(() => {
    setLoading(true);
    api.getStory(storyId)
      .then((data) => {
        const { story, scenes: loadedScenes } = data;
        setMeta({ title: story.title, description: story.description, tags: story.tags });
        setConfig(story.config);
        setScenes(loadedScenes);
        setStartSceneId(story.startSceneId);
        setIsPublic(story.isPublic);
        setBaseUpdatedAt(story.updatedAt);
        setSelected(story.startSceneId in loadedScenes ? story.startSceneId : Object.keys(loadedScenes)[0] ?? null);
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

  function deleteScene(key) {
    if (key === startSceneId) { alert('시작 장면은 삭제할 수 없습니다. 먼저 다른 장면을 시작 장면으로 바꿔주세요.'); return; }
    if (!confirm(`P.${pageOf[key]} '${key}' 장면을 삭제할까요? 이 장면을 가리키던 선택지는 연결이 끊어집니다.`)) return;
    setScenes((prev) => {
      const next = { ...prev };
      delete next[key];
      for (const sceneKey of Object.keys(next)) {
        next[sceneKey] = { ...next[sceneKey], choices: (next[sceneKey].choices ?? []).map((c) => (c.to === key ? { ...c, to: '' } : c)) };
      }
      return next;
    });
    setSelected((cur) => (cur === key ? startSceneId : cur));
  }

  async function handleSave() {
    setSaving(true);
    setSaveMsg(null);
    try {
      await api.updateStory(storyId, { title: meta.title, description: meta.description, tags: meta.tags, baseUpdatedAt });
      const scenesToSend = {};
      for (const [key, scene] of Object.entries(scenes)) {
        const { id, ...rest } = scene;
        scenesToSend[key] = rest;
      }
      const result = await api.saveScenes(storyId, { scenes: scenesToSend, config, startSceneId, baseUpdatedAt });
      setBaseUpdatedAt(result.updatedAt);
      setValidation(result.validation);
      setSaveMsg('저장했습니다.');
    } catch (err) {
      if (err.status === 409) setSaveMsg('다른 곳에서 먼저 수정되었습니다. 새로고침 후 다시 시도하세요.');
      else if (err.status === 422) { setValidation(err.validation); setSaveMsg('공개 중인 스토리는 오류가 없어야 저장됩니다. 비공개로 바꾼 뒤 다시 시도하세요.'); }
      else setSaveMsg(`저장 실패: ${err.message}`);
    } finally {
      setSaving(false);
    }
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
          <button type="button" className="ed-back" onClick={onBack} title="내 스토리로 돌아가기">
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
        </div>
      </aside>
      <div className="ed-scrim" onClick={() => setSideOpen(false)} />

      {/* ───────── 가운데: 장면 편집 ───────── */}
      <main className="ed-main">
        <div className="ed-toolbar">
          <button type="button" className="icon-btn" onClick={() => setSideOpen((v) => !v)} title="페이지 목록 열기/닫기" aria-label="페이지 목록 열기/닫기">
            {sideOpen ? '«' : '☰'}
          </button>
          <div className="spacer" />
          {saveMsg && <span className="ed-msg" role="status">{saveMsg}</span>}
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
              onSetStart={() => setStartSceneId(current)}
              onGoto={selectScene}
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
              <strong>{panel === 'settings' ? '스토리 설정' : panel === 'validation' ? '유효성 검사' : '구조도'}</strong>
              <button type="button" className="icon-btn" onClick={() => setPanel(null)} aria-label="닫기">✕</button>
            </div>

            {panel === 'settings' && (
              <ConfigPanel meta={meta} setMeta={setMeta} config={config} setConfig={setConfig} isPublic={isPublic} onVisibility={handleVisibility} onDelete={handleDelete} />
            )}
            {panel === 'validation' && (
              <ValidationPanel config={config} scenes={scenes} startSceneId={startSceneId} validation={validation} setValidation={setValidation} />
            )}
            {panel === 'graph' && (
              <>
                <p className="muted" style={{ fontSize: 13, margin: '0 0 8px' }}>
                  장면 카드를 끌어서 옮기고, 눌러서 선택하세요. 빈 곳을 더블클릭하면 새 페이지가 만들어집니다.
                </p>
                <div className="graph-wrap">
                  <SceneGraph
                    scenes={scenes} selected={current} onSelect={setSelected} startSceneId={startSceneId}
                    onMove={(key, posX, posY) => updateScene(key, { posX, posY })}
                    onAddAt={(x, y) => {
                      const key = newSceneKey(scenes);
                      setScenes((prev) => ({ ...prev, [key]: { id: key, body: '', imageUrl: null, station: null, isEnding: false, endingName: null, endingType: null, onEnter: [], choices: [], posX: x, posY: y } }));
                      setSelected(key);
                    }}
                  />
                </div>
                <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
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
        <PlayPreview config={config} scenes={scenes} startSceneId={startSceneId} storyTitle={meta.title} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}