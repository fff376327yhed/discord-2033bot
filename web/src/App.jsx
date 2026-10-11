import { useEffect, useState } from 'react';
import { api } from './api.js';
import Editor from './Editor.jsx';

/* ───────────────────────── Login ───────────────────────── */

function Login() {
  return (
    <div className="center-screen">
      <div className="login-card" style={{ textAlign: 'center' }}>
        <h1>🚇 해정2033 창작마당</h1>
        <p style={{ color: 'var(--muted)' }}>디스코드로 로그인하면 내 스토리를 만들고 편집할 수 있습니다.</p>
        <a className="btn btn-primary" href="/api/auth/login" style={{ display: 'inline-block', marginTop: 12 }}>
          디스코드로 로그인
        </a>
      </div>
    </div>
  );
}

/* ───────────────────────── StoryList ───────────────────────── */

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
  const [storyId, setStoryId] = useState(null);

  useEffect(() => {
    api.me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  if (user === undefined) {
    return <div style={{ padding: 20 }}>불러오는 중...</div>;
  }

  if (!user) {
    return <Login />;
  }

  async function handleLogout() {
    try {
      await api.logout();
    } finally {
      setUser(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <strong>🚇 해정2033 창작마당</strong>
        <div className="spacer" />
        <span className="user">{user.username ?? user.name ?? '사용자'}</span>
        <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
      </div>

      {storyId ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : (
        <StoryList onOpen={setStoryId} />
      )}
    </div>
  );
}
