// 스토리 편집 화면: 왼쪽 페이지 목록 + 가운데 장면 편집(본문, 선택지 카드)
// 설정/유효성 검사/구조도는 모달로 열린다.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { api } from './api.js';
import ConfigPanel from './ConfigPanel.jsx';
import SceneGraph from './SceneGraph.jsx';
import SceneForm from './SceneForm.jsx';
import ValidationPanel from './ValidationPanel.jsx';
import PlayPreview from './PlayPreview.jsx';

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

  function closeSideOnMobile() {
    if (!window.matchMedia(DESKTOP_QUERY).matches) setSideOpen(false);
  }

  function selectScene(key) {
    setSelected(key);
    closeSideOnMobile();
  }

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
          {visibleKeys.map((key) => {
            const scene = scenes[key];
            return (
              <button
                type="button" key={key}
                className={`ed-page ${key === current ? 'active' : ''}`}
                onClick={() => selectScene(key)}
              >
                <span className="ed-page-no">{pageOf[key]}</span>
                <span className="ed-page-text">{previewOf(scene, key)}</span>
                <span className="ed-page-badges">
                  {key === startSceneId && <span title="시작 장면">🚩</span>}
                  {scene.isEnding && <span title="엔딩">🏁</span>}
                  {hasProblem(scene, scenes) && <span title="막다른 길이거나 끊긴 선택지가 있습니다">⚠️</span>}
                </span>
              </button>
            );
          })}
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
