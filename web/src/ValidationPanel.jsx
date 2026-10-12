import { useState } from 'react';
import { api } from './api.js';

export default function ValidationPanel({ config, scenes, startSceneId, validation, setValidation }) {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const scenesToSend = {};
      for (const [key, scene] of Object.entries(scenes)) {
        const { id, ...rest } = scene;
        scenesToSend[key] = rest;
      }
      const report = await api.validateDraft({ startSceneId, config, scenes: scenesToSend });
      setValidation(report);
    } catch (err) {
      if (err.status === 400 && err.details) setError(err.details.join(' / '));
      else setError(err.message);
    } finally {
      setChecking(false);
    }
  }

  return (
    <div style={{ marginTop: 20, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
      <div className="panel-title" style={{ fontSize: 13 }}>
        유효성 검사
        <button className="btn btn-small" disabled={checking} onClick={check}>{checking ? '검사 중...' : '검사하기'}</button>
      </div>
      {error && <div className="validation-error">⚠️ 입력값 자체에 문제가 있습니다: {error}</div>}
      {validation && (
        <>
          <div className={validation.ok ? 'validation-ok' : 'validation-error'}>
            {validation.ok ? '✅ 통과 — 공개할 수 있습니다.' : '❌ 오류가 있어 공개할 수 없습니다.'}
          </div>
          {validation.errors.length > 0 && (
            <ul className="validation-list validation-error">{validation.errors.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
          )}
          {validation.warnings.length > 0 && (
            <ul className="validation-list validation-warn">{validation.warnings.map((msg, i) => <li key={i}>{msg}</li>)}</ul>
          )}
        </>
      )}
    </div>
  );
}