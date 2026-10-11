export default function Login() {
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