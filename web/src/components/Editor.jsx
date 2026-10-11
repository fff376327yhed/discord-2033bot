import { useEffect, useState, useCallback } from 'react';
import { api } from '../api.js';
import ConfigPanel from './ConfigPanel.jsx';
import SceneGraph from './scenegraph.jsx';
import SceneForm from './sceneform.jsx';
import ValidationPanel from './ValidationPanel.jsx';
import PlayPreview from './PlayPreview.jsx';

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