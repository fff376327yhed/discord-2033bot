import { useState } from 'react';
import { startStory, advance, getAvailableChoices } from './engine.js';

function withIds(scenes) {
  const out = {};
  for (const [key, scene] of Object.entries(scenes)) out[key] = { ...scene, id: key };
  return out;
}

export default function PlayPreview({ config, scenes, startSceneId, storyTitle, onClose }) {
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