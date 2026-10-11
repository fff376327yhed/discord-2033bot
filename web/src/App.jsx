import { useEffect, useState } from 'react';
import { api } from './api.js';
import Editor from './Editor.jsx';
import BrowseStories from './BrowseStories.jsx';

/* ───────────────────────── StoryList (내 스토리) ───────────────────────── */

function StoryList({ onOpen }) {
  const [stories, setStories] = useState(null);
  const [error, setError] = useState(null);

  function reload() {
    api.myStories().then((data) => setStories(data.stories)).catch((err) => setError(err.message));
  }
  useEffect(reload, []);

  async function createStory() {
    try {
      const data = await api.createStory({ title: '새 스토리' });
      onOpen(data.story.id);
    } catch (err) {
      setError(err.message);
    }
  }

  if (error) return <div className="story-list">⚠️ {error}</div>;
  if (!stories) return <div className="story-list">불러오는 중...</div>;

  return (
    <div className="story-list">
      <button className="btn btn-primary" onClick={createStory}>+ 새 스토리 만들기</button>
      {stories.length === 0 && <p style={{ color: 'var(--muted)' }}>아직 만든 스토리가 없습니다.</p>}
      {stories.map((story) => (
        <div key={story.id} className="story-row" onClick={() => onOpen(story.id)}>
          <div>
            <div>
              {story.title} {story.isPublic ? <span className="badge">공개</span> : <span className="badge">비공개</span>}
            </div>
            <div className="meta">
              장면 {story.sceneCount}개 · 플레이 {story.playCount}회 ·{' '}
              {story.tags.map((t) => <span key={t} className="tag-pill">{t}</span>)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── App ───────────────────────── */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 확인 중, null = 비로그인
  const [tab, setTab] = useState('mine'); // 'mine' = 내 스토리, 'browse' = 둘러보기
  const [storyId, setStoryId] = useState(null);

  useEffect(() => {
    api.me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div style={{ padding: 20 }}>불러오는 중...</div>;
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
      setStoryId(null);
    }
  }

  // 로그인 안 한 사람은 항상 '둘러보기'만 보인다.
  const activeTab = user ? tab : 'browse';
  const editing = Boolean(user && storyId);

  return (
    <div>
      <div className="topbar">
        <strong className="brand">🚇 해정2033 창작마당</strong>

        {/* 편집 중에는 화면을 넓게 쓰려고 탭을 숨긴다 */}
        {user && !editing && (
          <nav className="tabs" aria-label="메뉴">
            <button type="button" className={`tab ${activeTab === 'mine' ? 'active' : ''}`} aria-current={activeTab === 'mine'} onClick={() => setTab('mine')}>내 스토리</button>
            <button type="button" className={`tab ${activeTab === 'browse' ? 'active' : ''}`} aria-current={activeTab === 'browse'} onClick={() => setTab('browse')}>둘러보기</button>
          </nav>
        )}

        <div className="spacer" />

        {user ? (
          <>
            <span className="user">{user.username ?? user.name ?? '사용자'}</span>
            <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
          </>
        ) : (
          <a className="btn btn-small btn-primary" href="/api/auth/login">디스코드로 로그인</a>
        )}
      </div>

      {editing ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : activeTab === 'mine' ? (
        <StoryList onOpen={setStoryId} />
      ) : (
        <div className="browse-wrap">
          <BrowseStories user={user} />
        </div>
      )}
    </div>
  );
}
