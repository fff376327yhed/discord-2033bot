// 앱 화면: 로그인 → 내 스토리 목록 → 편집기
// 예전의 Login.jsx, StoryList.jsx 를 이 파일 안으로 합쳤다.
import { useEffect, useState } from 'react';
import { api } from '../api.js';
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

/* ───────────────────────── AdminPanel (관리자) ───────────────────────── */

function AdminPanel() {
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [error, setError] = useState(null);

  function reload() {
    setError(null);
    setReports(null);
    api.adminReports(status)
      .then((data) => setReports(data.reports ?? []))
      .catch((err) => setError(err.message));
  }
  useEffect(reload, [status]);

  async function act(fn) {
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err.message);
    }
  }

  function hideStory(report) {
    const reason = window.prompt('숨김 사유를 입력하세요');
    if (reason === null) return;
    act(() => api.adminHideStory(report.storyId, true, reason));
  }

  function blockUser(report) {
    const reason = window.prompt('차단 사유를 입력하세요');
    if (reason === null) return;
    act(() => api.adminBlockUser(report.authorId, true, reason));
  }

  return (
    <div className="story-list">
      <div style={{ display: 'flex', gap: 8 }}>
        {['open', 'resolved', 'dismissed'].map((s) => (
          <button
            key={s}
            className={`btn btn-small ${status === s ? 'btn-primary' : ''}`}
            onClick={() => setStatus(s)}
          >
            {{ open: '대기', resolved: '처리됨', dismissed: '기각' }[s]}
          </button>
        ))}
      </div>

      {error && <div>⚠️ {error}</div>}
      {!error && !reports && <div>불러오는 중...</div>}
      {reports?.length === 0 && <p style={{ color: 'var(--muted)' }}>신고가 없습니다.</p>}

      {reports?.map((r) => (
        <div key={r.id} className="story-row" style={{ cursor: 'default' }}>
          <div>
            <div>스토리 {r.storyId}</div>
            <div className="meta">{r.reason}</div>
            {status === 'open' && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button className="btn btn-small" onClick={() => act(() => api.adminResolveReport(r.id, 'resolved'))}>처리 완료</button>
                <button className="btn btn-small" onClick={() => act(() => api.adminResolveReport(r.id, 'dismissed'))}>기각</button>
                <button className="btn btn-small" onClick={() => hideStory(r)}>스토리 숨기기</button>
                <button className="btn btn-small" onClick={() => blockUser(r)}>작성자 차단</button>
              </div>
            )}
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
  const [tab, setTab] = useState('stories'); // 'stories' | 'admin'
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api.me()
      .then((data) => setUser(data.user))
      .catch(() => setUser(null));
  }, []);

  // 운영자가 아니면 서버가 404를 주므로, 성공할 때만 관리자 탭을 보여준다.
  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    api.adminReports('open')
      .then(() => setIsAdmin(true))
      .catch(() => setIsAdmin(false));
  }, [user]);

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
      setTab('stories');
      setUser(null);
    }
  }

  return (
    <div>
      <div className="topbar">
        <strong>🚇 해정2033 창작마당</strong>
        {isAdmin && !storyId && (
          <>
            <button className={`btn btn-small ${tab === 'stories' ? 'btn-primary' : ''}`} onClick={() => setTab('stories')}>내 스토리</button>
            <button className={`btn btn-small ${tab === 'admin' ? 'btn-primary' : ''}`} onClick={() => setTab('admin')}>관리자</button>
          </>
        )}
        <div className="spacer" />
        <span className="user">{user.username ?? user.name ?? '사용자'}</span>
        <button className="btn btn-small" onClick={handleLogout}>로그아웃</button>
      </div>

      {storyId ? (
        <Editor storyId={storyId} onBack={() => setStoryId(null)} />
      ) : tab === 'admin' && isAdmin ? (
        <AdminPanel />
      ) : (
        <StoryList onOpen={setStoryId} />
      )}
    </div>
  );
}
