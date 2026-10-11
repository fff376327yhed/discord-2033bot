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

export default function SceneForm({ sceneKey, scene, scenes, startSceneId, onChange, onDelete, onSetStart, config }) {
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