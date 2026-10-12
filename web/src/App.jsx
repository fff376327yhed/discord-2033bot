// 앱 전체 화면: 상단바 + 탭(내 스토리 / 둘러보기) + 다크 모드
// 예전의 BrowseStories.jsx 를 이 파일 안으로 합쳤다.
import { useEffect, useState } from 'react';
import { api } from './lib.js';
import Editor from './Editor.jsx';

/* ───────────────────────── 내 스토리 ───────────────────────── */

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

/* ───────────────────────── 둘러보기 (공개 스토리 검색, 태그, 정렬, 좋아요, 엔딩 도감) ───────────────────────── */

const ENDING_TYPE = { good: '굿', bad: '배드', hidden: '히든' };

const browseStyles = {
  bar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  card: { border: '1px solid var(--border)', borderRadius: 14, padding: 14, marginBottom: 10 },
  chip: (active) => ({
    padding: '2px 10px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer',
    background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'inherit',
  }),
};

function BrowseStories({ user }) {
  const [input, setInput] = useState('');   // 입력창에 쓰는 중인 글자
  const [query, setQuery] = useState('');   // 실제로 검색에 쓰이는 글자 (엔터/버튼 때 확정)
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState('latest');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [books, setBooks] = useState({});   // { 스토리ID: 엔딩 도감 | 'loading' }

  // 검색 조건이 바뀔 때마다 목록을 다시 불러온다. (이전 요청이 늦게 도착해도 무시)
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = new URLSearchParams({ sort, offset: String(offset) });
    if (query) params.set('q', query);
    if (tag) params.set('tag', tag);

    api.browse(params)
      .then((result) => !cancelled && setData(result))
      .catch((err) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [query, tag, sort, offset]);

  // 조건을 바꾸면 항상 첫 페이지부터
  const changeFilter = (setter) => (value) => { setter(value); setOffset(0); };
  const submitSearch = (event) => { event.preventDefault(); setQuery(input.trim()); setOffset(0); };

  async function toggleLike(story) {
    if (!user) return setError('좋아요는 로그인 후 누를 수 있습니다.');
    try {
      const result = await api.setLike(story.id, !story.liked);
      setData((prev) => ({
        ...prev,
        stories: prev.stories.map((s) => (s.id === story.id ? { ...s, liked: result.liked, likeCount: result.likeCount } : s)),
      }));
    } catch (err) {
      setError(err.message);
    }
  }

  async function toggleEndings(story) {
    if (!user) return setError('엔딩 도감은 로그인 후 볼 수 있습니다.');
    if (books[story.id] && books[story.id] !== 'loading') {
      setBooks((prev) => { const next = { ...prev }; delete next[story.id]; return next; }); // 접기
      return;
    }
    setBooks((prev) => ({ ...prev, [story.id]: 'loading' }));
    try {
      const book = await api.endings(story.id);
      setBooks((prev) => ({ ...prev, [story.id]: book }));
    } catch (err) {
      setBooks((prev) => { const next = { ...prev }; delete next[story.id]; return next; });
      setError(err.message);
    }
  }

  return (
    <section>
      <form onSubmit={submitSearch} style={browseStyles.bar}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={50}
          placeholder="제목, 설명, 태그 검색"
          style={{ flex: 1, minWidth: 160 }}
        />
        <button type="submit">검색</button>
        <select value={sort} onChange={(e) => changeFilter(setSort)(e.target.value)}>
          <option value="latest">최신순</option>
          <option value="popular">인기순</option>
        </select>
      </form>

      {data?.tags?.length > 0 && (
        <div style={{ ...browseStyles.bar, gap: 6 }}>
          <button type="button" style={browseStyles.chip(!tag)} onClick={() => changeFilter(setTag)('')}>전체</button>
          {data.tags.map(({ tag: name, count }) => (
            <button key={name} type="button" style={browseStyles.chip(tag === name)} onClick={() => changeFilter(setTag)(tag === name ? '' : name)}>
              #{name} {count}
            </button>
          ))}
        </div>
      )}

      {error && <p role="alert" style={{ color: '#ed4245' }}>⚠️ {error}</p>}
      {loading && <p>불러오는 중…</p>}
      {data && !loading && data.stories.length === 0 && <p>조건에 맞는 공개 스토리가 없습니다.</p>}

      {data?.stories.map((story) => {
        const book = books[story.id];
        return (
          <article key={story.id} style={browseStyles.card}>
            <h3 style={{ margin: '0 0 4px' }}>{story.title}</h3>
            <p style={{ margin: '0 0 6px', opacity: 0.8 }}>{story.description || '설명 없음'}</p>
            <p style={{ margin: '0 0 8px', fontSize: 13, opacity: 0.7 }}>
              제작자 {story.authorName ?? '운영자'} · 플레이 {story.playCount}회 · 장면 {story.sceneCount}개
              {story.tags.length > 0 && ` · ${story.tags.map((t) => `#${t}`).join(' ')}`}
            </p>
            <div style={browseStyles.bar}>
              <button type="button" onClick={() => toggleLike(story)} aria-pressed={story.liked}>
                {story.liked ? '❤️' : '🤍'} {story.likeCount}
              </button>
              <button type="button" onClick={() => toggleEndings(story)}>🏁 엔딩 도감</button>
              <code style={{ opacity: 0.6 }}>/플레이 {story.id}</code>
            </div>
            {book === 'loading' && <p>도감 확인 중…</p>}
            {book && book !== 'loading' && (
              <div>
                <strong>엔딩 {book.seenCount} / {book.total}</strong>
                <ul>
                  {book.seen.map((ending) => (
                    <li key={ending.sceneId}>{ending.name} ({ENDING_TYPE[ending.type] ?? '엔딩'})</li>
                  ))}
                  {book.total > book.seenCount && <li>❓ 아직 못 본 엔딩 {book.total - book.seenCount}개</li>}
                </ul>
              </div>
            )}
          </article>
        );
      })}

      {data && (
        <div style={browseStyles.bar}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>이전</button>
          <span>{data.total === 0 ? 0 : offset + 1}–{offset + data.stories.length} / {data.total}</span>
          <button type="button" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + data.pageSize)}>다음</button>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 다크 모드 ───────────────────────── */

// 저장된 선택이 없으면 null → 컴퓨터/폰의 설정을 따른다.
function readSavedTheme() {
  try {
    const value = localStorage.getItem('theme');
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    return null; // 저장소를 못 쓰는 환경이어도 화면은 정상 동작
  }
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/* ───────────────────────── App ───────────────────────── */

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = 확인 중, null = 비로그인
  const [tab, setTab] = useState('mine'); // 'mine' = 내 스토리, 'browse' = 둘러보기
  const [storyId, setStoryId] = useState(null);
  const [theme, setTheme] = useState(readSavedTheme); // 'dark' | 'light' | null(시스템 설정 따름)

  // <html data-theme="..."> 로 css의 다크 색상을 켜고 끈다.
  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
  }, [theme]);

  const isDark = theme ? theme === 'dark' : systemPrefersDark();

  function toggleTheme() {
    const next = isDark ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('theme', next); } catch { /* 저장 실패해도 이번 방문에는 적용됨 */ }
  }

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

        <button
          type="button" className="btn btn-small theme-btn" onClick={toggleTheme}
          aria-label={isDark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'}
          title={isDark ? '라이트 모드' : '다크 모드'}
        >
          {isDark ? '☀️' : '🌙'}
        </button>

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
