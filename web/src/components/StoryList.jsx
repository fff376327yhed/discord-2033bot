import { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function StoryList({ onOpen }) {
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