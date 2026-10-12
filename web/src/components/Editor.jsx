// 스토리 편집 화면 전체 (3단 레이아웃: 설정 | 구조도 | 장면 편집)
//
// 이 파일 안에 합쳐진 것들 (위에서 아래 순서):
//   1) ConfigPanel      — 스토리 설정(제목/태그/공개/스탯 등)
//   2) ValidationPanel  — 유효성 검사
//   3) SceneGraph       — 구조도(드래그 가능한 장면 카드)
//   4) PlayPreview      — 저장 전 미리보기 플레이
//   5) SceneForm        — 장면 하나 편집(본문 + 선택지)
//   6) Editor (default) — 위 조각들을 조립하는 본체
import { useEffect, useRef, useState, useCallback } from 'react';
import { api } from '../api.js';
import { startStory, advance, getAvailableChoices } from '../engine.js';

/* ═════════════════════════ 1) ConfigPanel ═════════════════════════ */

function BucketEditor({ title, bucket, config, setConfig, numeric }) {
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

      <BucketEditor title="스탯" bucket="stats" config={config} setConfig={setConfig} numeric />
      <BucketEditor title="자원" bucket="resources" config={config} setConfig={setConfig} numeric />
      <BucketEditor title="파벌" bucket="factions" config={config} setConfig={setConfig} numeric />
      <BucketEditor title="아이템" bucket="items" config={config} setConfig={setConfig} />
      <BucketEditor title="플래그" bucket="flags" config={config} setConfig={setConfig} />
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

  useEffect(() => {
    if (!dragging) return;
    function handleMove(e) {
      const rect = canvasRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left + canvasRef.current.scrollLeft;
      const y = e.clientY - rect.top + canvasRef.current.scrollTop;
      onMove(dragging.key, Math.max(0, Math.round(x - dragging.offsetX)), Math.max(0, Math.round(y - dragging.offsetY)));
    }
    function handleUp() { setDragging(null); }
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [dragging, onMove]);

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
        {entries.map(([key, scene]) => (
          <div
            key={key}
            className={`scene-node ${selected === key ? 'selected' : ''} ${scene.isEnding ? 'ending' : ''} ${key === startSceneId ? 'start-marker' : ''}`}
            style={{ left: scene.posX ?? 0, top: scene.posY ?? 0 }}
            onPointerDown={(e) => onPointerDown(e, key)}
          >
            <div className="title">{key === startSceneId ? '🚩 ' : ''}{scene.isEnding ? '🏁 ' : ''}{key}</div>
            <div className="body-preview">{scene.body || '(본문 없음)'}</div>
          </div>
        ))}
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

// 아래 상수들은 src/bundle.js 의 LIMITS/MAX 를 사람이 손으로 옮겨 적은 것이다.
// 서버 쪽 값이 바뀌면 여기도 같이 맞춰야 한다 (화면 제한은 참고용일 뿐, 최종 검증은 항상 서버가 한다).
const LIMITS = { BODY: 1800, LABEL: 80, CHOICES: 5, STATION: 40, ENDING_NAME: 50, IMAGE_URL: 500, ENTRIES: 10 };
const ENTRY_TYPES = ['stat', 'resource', 'faction', 'item', 'flag'];
const COND_OPS = ['>=', '<=', '>', '<', '==', '!='];
const ENDING_TYPES = [{ value: 'good', label: '굿' }, { value: 'bad', label: '배드' }, { value: 'hidden', label: '히든' }];

function allKeysOf(config, type) {
  if (type === 'item') return Object.entries(config.items ?? {});
  if (type === 'flag') return Object.entries(config.flags ?? {});
  const bucket = { stat: 'stats', resource: 'resources', faction: 'factions' }[type];
  return Object.entries(config[bucket] ?? {});
}

function EntryRow({ entry, config, kind, onChange, onRemove }) {
  const options = allKeysOf(config, entry.type);
  return (
    <div className="row" style={{ marginBottom: 4, flexWrap: 'wrap' }}>
      <select value={entry.type} onChange={(e) => onChange({ ...entry, type: e.target.value, key: '' })}>
        {ENTRY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <select value={entry.key ?? ''} onChange={(e) => onChange({ ...entry, key: e.target.value })}>
        <option value="">(선택)</option>
        {options.map(([key, def]) => <option key={key} value={key}>{def.label ?? key}</option>)}
      </select>
      {entry.type === 'flag' ? (
        <select value={entry.value === false ? 'false' : 'true'} onChange={(e) => onChange({ ...entry, value: e.target.value === 'true' })}>
          <option value="true">켜짐</option>
          <option value="false">꺼짐</option>
        </select>
      ) : kind === 'condition' ? (
        <>
          <select value={entry.op ?? '>='} onChange={(e) => onChange({ ...entry, op: e.target.value })}>
            {COND_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input type="number" value={entry.value ?? 0} onChange={(e) => onChange({ ...entry, value: Number(e.target.value) })} />
        </>
      ) : (
        <input type="number" placeholder="증감(delta)" value={entry.delta ?? 0} onChange={(e) => onChange({ ...entry, delta: Number(e.target.value) })} />
      )}
      <button className="btn btn-small btn-danger" onClick={onRemove} style={{ flex: '0 0 auto' }}>✕</button>
    </div>
  );
}

function EntryListEditor({ title, list, config, kind, onChange }) {
  function update(i, entry) { const next = [...list]; next[i] = entry; onChange(next); }
  function remove(i) { onChange(list.filter((_, idx) => idx !== i)); }
  function add() {
    if (list.length >= LIMITS.ENTRIES) { alert(`최대 ${LIMITS.ENTRIES}개까지 가능합니다.`); return; }
    onChange([...list, kind === 'condition' ? { type: 'item', key: '', op: '>=', value: 1 } : { type: 'stat', key: '', delta: 0 }]);
  }
  return (
    <div className="field">
      <label>{title} ({list.length}/{LIMITS.ENTRIES})</label>
      {list.map((entry, i) => (
        <EntryRow key={i} entry={entry} config={config} kind={kind} onChange={(e) => update(i, e)} onRemove={() => remove(i)} />
      ))}
      <button className="btn btn-small" onClick={add}>+ {title} 추가</button>
    </div>
  );
}

function ChoiceEditor({ choice, index, scenes, config, onChange, onRemove }) {
  const sceneKeys = Object.keys(scenes);
  return (
    <div className="list-item">
      <div className="list-item-head">
        <strong style={{ fontSize: 12 }}>선택지 {index + 1}</strong>
        <button className="btn btn-small btn-danger" onClick={onRemove}>삭제</button>
      </div>
      <div className="field">
        <label>버튼 문구</label>
        <input value={choice.label} maxLength={LIMITS.LABEL} onChange={(e) => onChange({ ...choice, label: e.target.value })} />
      </div>
      <div className="field">
        <label>이동할 장면</label>
        <select value={choice.to ?? ''} onChange={(e) => onChange({ ...choice, to: e.target.value })}>
          <option value="">(연결 안 됨 — 끊긴 분기로 표시됩니다)</option>
          {sceneKeys.map((key) => <option key={key} value={key}>{key}</option>)}
        </select>
      </div>
      <EntryListEditor title="조건 (전부 만족해야 함)" list={choice.condition ?? []} config={config} kind="condition" onChange={(v) => onChange({ ...choice, condition: v })} />
      <EntryListEditor title="효과" list={choice.effects ?? []} config={config} kind="effect" onChange={(v) => onChange({ ...choice, effects: v })} />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 6 }}>
        <input type="checkbox" checked={Boolean(choice.hideWhenLocked)} onChange={(e) => onChange({ ...choice, hideWhenLocked: e.target.checked })} style={{ width: 'auto' }} />
        조건 미달 시 선택지를 숨김 (끄면 🔒 잠금 표시로 보여줌)
      </label>
    </div>
  );
}

function SceneForm({ sceneKey, scene, scenes, startSceneId, onChange, onDelete, onSetStart, config }) {
  const choices = scene.choices ?? [];

  function updateChoice(i, choice) { const next = [...choices]; next[i] = choice; onChange({ choices: next }); }
  function removeChoice(i) { onChange({ choices: choices.filter((_, idx) => idx !== i) }); }
  function addChoice() {
    if (choices.length >= LIMITS.CHOICES) { alert(`선택지는 최대 ${LIMITS.CHOICES}개까지 가능합니다.`); return; }
    onChange({ choices: [...choices, { label: '선택', to: '', condition: [], effects: [], hideWhenLocked: false }] });
  }

  return (
    <div>
      <div className="panel-title">
        장면: <code>{sceneKey}</code>
        <button className="btn btn-small btn-danger" onClick={onDelete}>삭제</button>
      </div>

      {sceneKey !== startSceneId && (
        <button className="btn btn-small" onClick={onSetStart} style={{ marginBottom: 10 }}>🚩 이 장면을 시작 장면으로</button>
      )}

      <div className="field">
        <label>본문 ({(scene.body ?? '').length}/{LIMITS.BODY})</label>
        <textarea rows={6} value={scene.body ?? ''} maxLength={LIMITS.BODY} onChange={(e) => onChange({ body: e.target.value })} />
      </div>
      <div className="field">
        <label>역 이름 (표시용, 선택)</label>
        <input value={scene.station ?? ''} maxLength={LIMITS.STATION} onChange={(e) => onChange({ station: e.target.value || null })} />
      </div>
      <div className="field">
        <label>이미지 주소 (https만 가능, 선택)</label>
        <input value={scene.imageUrl ?? ''} maxLength={LIMITS.IMAGE_URL} onChange={(e) => onChange({ imageUrl: e.target.value || null })} />
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <input type="checkbox" checked={Boolean(scene.isEnding)} onChange={(e) => onChange({ isEnding: e.target.checked })} style={{ width: 'auto' }} />
        이 장면은 엔딩입니다
      </label>

      {scene.isEnding ? (
        <>
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
        </>
      ) : (
        <>
          <EntryListEditor title="진입 효과 (onEnter)" list={scene.onEnter ?? []} config={config} kind="effect" onChange={(v) => onChange({ onEnter: v })} />
          <div className="panel-title" style={{ fontSize: 13 }}>
            선택지 ({choices.length}/{LIMITS.CHOICES})
            <button className="btn btn-small" onClick={addChoice}>+ 선택지 추가</button>
          </div>
          {choices.map((choice, i) => (
            <ChoiceEditor key={i} choice={choice} index={i} scenes={scenes} config={config} onChange={(c) => updateChoice(i, c)} onRemove={() => removeChoice(i)} />
          ))}
        </>
      )}
    </div>
  );
}

/* ═════════════════════════ 6) Editor (본체) ═════════════════════════ */

let sceneCounter = 0;
function newSceneKey(scenes) {
  let key;
  do {
    sceneCounter += 1;
    key = `scene_${sceneCounter}`;
  } while (scenes[key]);
  return key;
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

  function updateScene(key, patch) {
    setScenes((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function addScene(posX, posY) {
    const key = newSceneKey(scenes);
    const scene = {
      id: key, body: '새 장면', imageUrl: null, station: null, isEnding: false,
      endingName: null, endingType: null, onEnter: [], choices: [], posX: posX ?? 0, posY: posY ?? 0,
    };
    setScenes((prev) => ({ ...prev, [key]: scene }));
    setSelected(key);
  }

  function deleteScene(key) {
    if (key === startSceneId) { alert('시작 장면은 삭제할 수 없습니다. 먼저 다른 장면을 시작 장면으로 바꿔주세요.'); return; }
    if (!confirm(`'${key}' 장면을 삭제할까요? 이 장면을 가리키던 선택지는 연결이 끊어집니다.`)) return;
    setScenes((prev) => {
      const next = { ...prev };
      delete next[key];
      for (const sceneKey of Object.keys(next)) {
        next[sceneKey] = { ...next[sceneKey], choices: (next[sceneKey].choices ?? []).map((c) => (c.to === key ? { ...c, to: '' } : c)) };
      }
      return next;
    });
    setSelected((cur) => (cur === key ? null : cur));
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

  return (
    <div className="editor-layout">
      <div className="editor-col">
        <ConfigPanel meta={meta} setMeta={setMeta} config={config} setConfig={setConfig} isPublic={isPublic} onVisibility={handleVisibility} onDelete={handleDelete} />
      </div>

      <div className="editor-col" style={{ padding: 0, position: 'relative' }}>
        <div style={{ position: 'sticky', top: 0, zIndex: 10, background: 'var(--panel)', padding: 10, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={() => addScene(40, 40)}>+ 장면 추가</button>
          <button className="btn" onClick={() => setPreview(true)}>▶ 미리보기 플레이</button>
          <div className="spacer" />
          {saveMsg && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{saveMsg}</span>}
          <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? '저장 중...' : '저장'}</button>
        </div>
        <SceneGraph scenes={scenes} selected={selected} onSelect={setSelected} startSceneId={startSceneId} onMove={(key, posX, posY) => updateScene(key, { posX, posY })} onAddAt={addScene} />
      </div>

      <div className="editor-col">
        {selected && scenes[selected] ? (
          <SceneForm
            sceneKey={selected} scene={scenes[selected]} scenes={scenes}
            startSceneId={startSceneId}
            onChange={(patch) => updateScene(selected, patch)}
            onDelete={() => deleteScene(selected)}
            onSetStart={() => setStartSceneId(selected)}
            config={config}
          />
        ) : (
          <div style={{ color: 'var(--muted)' }}>가운데 그래프에서 장면을 선택하거나 새로 추가하세요.</div>
        )}
        <ValidationPanel config={config} scenes={scenes} startSceneId={startSceneId} validation={validation} setValidation={setValidation} />
      </div>

      {preview && (
        <PlayPreview config={config} scenes={scenes} startSceneId={startSceneId} storyTitle={meta.title} onClose={() => setPreview(false)} />
      )}
    </div>
  );
}
