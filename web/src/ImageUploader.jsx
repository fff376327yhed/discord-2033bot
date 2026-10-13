// 장면 설정의 "이미지" 칸: 사진 올리기 버튼 + 주소 직접 입력 + 미리보기 + 내 사용량
import { useEffect, useRef, useState } from 'react';
import { compressImage, uploadApi, formatBytes } from './imageUpload.js';
import './upload.css';

export default function ImageUploader({ value, onChange, maxLength = 500 }) {
  const [usage, setUsage] = useState(null); // 서버가 알려준 내 사용량 (관리자면 isAdmin: true)
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null); // { kind: 'ok' | 'error', text }
  const [broken, setBroken] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    let alive = true;
    uploadApi.mine().then((d) => alive && setUsage(d.usage)).catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => setBroken(false), [value]);

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
      setMessage({ kind: 'ok', text: `올렸어요! ${formatBytes(file.size)} → ${formatBytes(result.size)}로 줄여서 저장했어요.` });
    } catch (err) {
      if (err.usage) setUsage(err.usage);
      setMessage({ kind: 'error', text: err.message });
    } finally {
      setBusy(false);
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
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={handleFile} />
      </div>

      {value && !broken && <img className="img-preview" src={value} alt="미리보기" onError={() => setBroken(true)} />}
      {value && broken && <div className="hint">미리보기를 불러오지 못했어요. 주소를 확인해 주세요.</div>}
      {value && (
        <button type="button" className="link-btn" onClick={() => onChange(null)}>이미지 빼기</button>
      )}

      {message && <div className={message.kind === 'ok' ? 'validation-ok hint' : 'validation-error hint'}>{message.text}</div>}

      {usage?.isAdmin && <div className="hint">👑 관리자: 용량/개수 제한 없음 (한 장은 4MB까지)</div>}
      {limited && (
        <div className="img-usage">
          <div className="meter"><div className={`meter-fill ${percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : ''}`} style={{ width: `${percent}%` }} /></div>
          <div className="hint">
            내 사진 공간 {formatBytes(usage.bytes)} / {formatBytes(usage.maxBytes)} · {usage.count} / {usage.maxFiles}장
          </div>
        </div>
      )}
    </div>
  );
}
