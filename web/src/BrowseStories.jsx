// 둘러보기 탭: 공개 스토리 검색, 태그 필터, 정렬, 좋아요, 엔딩 도감
import { useEffect, useState } from 'react';

// 쓰기 요청(PUT)에는 서버가 요구하는 보안 헤더가 반드시 필요하다. (4단계 CSRF 방어)
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', 'x-requested-with': 'haejung', ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `요청 실패 (${res.status})`);
  return data;
}

const ENDING_TYPE = { good: '굿', bad: '배드', hidden: '히든' };

const styles = {
  bar: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 },
  card: { border: '1px solid var(--border)', borderRadius: 14, padding: 14, marginBottom: 10 },
  chip: (active) => ({
    padding: '2px 10px', borderRadius: 999, border: '1px solid var(--border)', cursor: 'pointer',
    background: active ? 'var(--accent)' : 'transparent', color: active ? '#fff' : 'inherit',
  }),
};

export default function BrowseStories({ user }) {
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

    api(`/api/browse?${params}`)
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
      const result = await api(`/api/stories/${story.id}/like`, { method: 'PUT', body: JSON.stringify({ liked: !story.liked }) });
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
      const book = await api(`/api/stories/${story.id}/endings`);
      setBooks((prev) => ({ ...prev, [story.id]: book }));
    } catch (err) {
      setBooks((prev) => { const next = { ...prev }; delete next[story.id]; return next; });
      setError(err.message);
    }
  }

  return (
    <section>
      <form onSubmit={submitSearch} style={styles.bar}>
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
        <div style={{ ...styles.bar, gap: 6 }}>
          <button type="button" style={styles.chip(!tag)} onClick={() => changeFilter(setTag)('')}>전체</button>
          {data.tags.map(({ tag: name, count }) => (
            <button key={name} type="button" style={styles.chip(tag === name)} onClick={() => changeFilter(setTag)(tag === name ? '' : name)}>
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
          <article key={story.id} style={styles.card}>
            <h3 style={{ margin: '0 0 4px' }}>{story.title}</h3>
            <p style={{ margin: '0 0 6px', opacity: 0.8 }}>{story.description || '설명 없음'}</p>
            <p style={{ margin: '0 0 8px', fontSize: 13, opacity: 0.7 }}>
              제작자 {story.authorName ?? '운영자'} · 플레이 {story.playCount}회 · 장면 {story.sceneCount}개
              {story.tags.length > 0 && ` · ${story.tags.map((t) => `#${t}`).join(' ')}`}
            </p>
            <div style={styles.bar}>
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
        <div style={styles.bar}>
          <button type="button" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - data.pageSize))}>이전</button>
          <span>{data.total === 0 ? 0 : offset + 1}–{offset + data.stories.length} / {data.total}</span>
          <button type="button" disabled={!data.hasMore || loading} onClick={() => setOffset(offset + data.pageSize)}>다음</button>
        </div>
      )}
    </section>
  );
}
