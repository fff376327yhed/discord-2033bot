// 장면 설정의 "이미지" 칸: 사진 올리기 + 내 사진 보관함 + 주소 직접 입력 + 미리보기 + 내 사용량
import { useEffect, useRef, useState } from 'react';
import { compressImage, uploadApi, formatBytes } from './imageUpload.js';
import './upload.css';

export default function ImageUploader({ value, onChange, maxLength = 500 }) {
  const [usage, setUsage] = useState(null); // 서버가 알려준 내 사용량 (관리자면 isAdmin: true)
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const [broken, setBroken] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [items, setItems] = useState(null); // 내 사진 보관함 (null = 아직 안 불러옴)
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    uploadApi.mine().then((d) => alive && setUsage(d.usage)).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => setBroken(false), [value]);

  async function loadItems() {
    try {
      setItems((await uploadApi.myItems()).items);
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    }
  }

  function toggleGallery() {
    const next = !galleryOpen;
    setGalleryOpen(next);
    if (next) loadItems();
  }

  async function handleFile(e) {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 사진을 다시 골라도 동작하도록 비운다
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      const blob = await compressImage(file, Boolean(usage?.isAdmin));
      const result = await uploadApi.upload(blob);
      onChange(result.url);
      setUsage(result.usage);
      if (galleryOpen) loadItems();
      setMessage({ kind: 'ok', text: `올렸어요! ${formatBytes(file.size)} → ${formatBytes(result.size)}로 줄여서 저장했어요.` });
    } catch (err) {
      if (err.usage) setUsage(err.usage);
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
    }
  }

  async function removeItem(item) {
    if (!window.confirm('이 사진을 완전히 지울까요? 이 사진을 쓰는 장면에서는 이미지가 안 보이게 돼요.')) return;
    try {
      await uploadApi.remove(item.id);
      if (value === item.url) onChange(null);
      await loadItems();
      setUsage((await uploadApi.mine()).usage);
      setMessage({ kind: 'ok', text: '사진을 지웠어요.' });
    } catch (err) {
      setMessage({ kind: 'error', text: err.message });
    }
  }

  const limited = usage && !usage.isAdmin && usage.maxBytes;
  const percent = limited ? Math.min(100, Math.round((usage.bytes / usage.maxBytes) * 100)) : 0;

  return (
    <div className="field img-uploader">
      <label>이미지 (사진을 올리거나 https 주소를 직접 적을 수 있어요, 선택)</label>
      <div className="img-row">
        <input value={value ?? ''} maxLength={maxLength} placeholder="https://..." onChange={(e) => onChange(e.target.value || null)} />
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? '올리는 중...' : '📷 사진 올리기'}
        </button>
        <button type="button" className="btn btn-small" onClick={toggleGallery}>{galleryOpen ? '보관함 닫기' : '🗂 내 사진'}</button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>

      {galleryOpen && (
        <div className="gallery">
          {!items && <div className="hint">불러오는 중...</div>}
          {items?.length === 0 && <div className="hint">아직 올린 사진이 없어요.</div>}
          {items?.length > 0 && (
            <div className="gallery-grid">
              {items.map((item) => (
                <div key={item.id} className="gallery-item">
                  <button type="button" className={`pick ${value === item.url ? 'current' : ''}`} title="이 사진 쓰기" onClick={() => onChange(item.url)}>
                    <img src={item.url} alt="" loading="lazy" />
                  </button>
                  <span className="size">{formatBytes(item.size)}</span>
                  <button type="button" className="del" title="사진 지우기" onClick={() => removeItem(item)}>✕</button>
                </div>
              ))}
            </div>
          )}
          <div className="hint">사진을 누르면 이 장면에 쓰고, ✕를 누르면 저장소에서 완전히 지워서 내 공간을 비워요.</div>
        </div>
      )}

      {value && !broken && <img className="img-preview" src={value} alt="미리보기" onError={() => setBroken(true)} />}
      {value && broken && <div className="hint">미리보기를 불러오지 못했어요. 주소를 확인해 주세요.</div>}
      {value && (
        <button type="button" className="link-btn" onClick={() => onChange(null)}>이미지 빼기</button>
      )}

      {message && <div className={message.kind === 'ok' ? 'validation-ok hint' : 'validation-error hint'}>{message.text}</div>}

      {usage?.isAdmin && <div className="hint">👑 관리자: 용량/개수/횟수 제한 없음 (한 장은 4MB까지)</div>}
      {limited && (
        <div className="img-usage">
          <div className="meter"><div className={`meter-fill ${percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : ''}`} style={{ width: `${percent}%` }} /></div>
          <div className="hint">
            내 사진 공간 {formatBytes(usage.bytes)} / {formatBytes(usage.maxBytes)} · {usage.count} / {usage.maxFiles}장 · 이번 달 올리기 {usage.monthCount} / {usage.maxPerMonth}회
          </div>
        </div>
      )}
    </div>
  );
}
