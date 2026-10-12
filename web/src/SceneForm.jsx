// 장면 하나를 편집하는 화면: 본문 + 선택지 카드
// 아래 상수들은 src/bundle.js 의 LIMITS/MAX 를 손으로 옮겨 적은 것이다.
// 서버 쪽 값이 바뀌면 여기도 같이 맞춰야 한다 (화면 제한은 참고용일 뿐, 최종 검증은 항상 서버가 한다).
import { useEffect, useRef, useState } from 'react';
import { describeCondition, labelOf } from './engine.js';

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

function previewOf(scene, key) {
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
          {order.map((key) => <option key={key} value={key}>P. {pageOf[key]} · {previewOf(scenes[key], key)}</option>)}
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

export default function SceneForm({ sceneKey, scene, scenes, order, pageOf, startSceneId, config, onChange, onDelete, onSetStart, onGoto }) {
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
