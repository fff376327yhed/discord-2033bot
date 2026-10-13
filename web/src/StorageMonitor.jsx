// 관리자 화면: 사진 저장소 사용량을 5초마다 새로 읽어서 보여준다.
// (브라우저가 서버에 5초마다 "지금 얼마야?" 하고 물어보는 방식. 탭이 가려져 있으면 쉰다.)
import { useCallback, useEffect, useState } from 'react';
import { uploadApi, formatBytes } from './imageUpload.js';
import './upload.css';

const REFRESH_MS = 5000;

export default function StorageMonitor() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(null);
  const [lastOk, setLastOk] = useState(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    try {
      setStats(await uploadApi.adminStats());
      setError(null);
      setLastOk(new Date());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  async function resync() {
    if (!window.confirm('저장소에 실제로 있는 사진을 세어서 전체 합계를 다시 계산할까요?')) return;
    setSyncing(true);
    try {
      await uploadApi.adminResync();
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  if (!stats) return <div className="card soft">{error ? `⚠️ ${error}` : '사용량 불러오는 중...'}</div>;

  const percent = stats.limitBytes ? Math.min(100, (stats.totalBytes / stats.limitBytes) * 100) : 0;
  const tone = percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : '';

  return (
    <div className="card monitor">
      <div className="card-head">
        <strong>📦 사진 저장소 사용량</strong>
        <span className="live-dot" title="5초마다 자동으로 새로 읽습니다" />
        <span className="spacer" />
        <button type="button" className="btn btn-small" disabled={syncing} onClick={resync}>{syncing ? '계산 중...' : '다시 계산'}</button>
      </div>

      <div className="monitor-big">{formatBytes(stats.totalBytes)} <span className="muted">/ {formatBytes(stats.limitBytes)}</span></div>
      <div className="meter"><div className={`meter-fill ${tone}`} style={{ width: `${percent}%` }} /></div>
      <div className="hint">
        {percent.toFixed(1)}% 사용 · 사진 {stats.totalCount}장
        {lastOk && ` · ${lastOk.toLocaleTimeString('ko-KR')} 기준`}
        {error && ` · ⚠️ 새로고침 실패: ${error}`}
      </div>

      {stats.topUsers.length > 0 && (
        <>
          <div className="section-title">많이 쓴 사람 TOP {stats.topUsers.length}</div>
          {stats.topUsers.map((u) => (
            <div key={u.id} className="monitor-row">
              <span>{u.username ?? u.id}</span>
              <span className="muted">{u.count}장 · {formatBytes(u.bytes)}</span>
            </div>
          ))}
        </>
      )}

      {stats.recent.length > 0 && (
        <>
          <div className="section-title">방금 올라온 사진</div>
          <div className="monitor-thumbs">
            {stats.recent.map((r) => (
              <a key={r.id} href={r.url} target="_blank" rel="noreferrer" title={`${formatBytes(r.size)} · ${new Date(r.createdAt).toLocaleString('ko-KR')}`}>
                <img src={r.url} alt="" loading="lazy" />
              </a>
            ))}
          </div>
        </>
      )}
      <div className="hint">※ 막대의 기준 용량은 환경 변수 UPLOAD_STORAGE_LIMIT_MB(기본 1024MB)입니다. 실제 Vercel 한도는 요금제 화면에서 꼭 확인하세요.</div>
    </div>
  );
}
