import { useState } from 'react';

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

export default function ConfigPanel({ meta, setMeta, config, setConfig, isPublic, onVisibility, onDelete }) {
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