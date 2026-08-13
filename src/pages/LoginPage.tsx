import { useState } from 'react';
import { useAuth } from '../core/store';

export default function LoginPage() {
  const login = useAuth((s) => s.login);
  const [token, setTokenInput] = useState('');

  const submit = () => {
    const t = token.trim();
    if (!t) return;
    login(t);
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-logo">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z" fill="#4D6BFE" />
            <path d="M12 6a6 6 0 100 12 6 6 0 000-12zm0 9a3 3 0 110-6 3 3 0 010 6z" fill="#fff" />
          </svg>
        </div>
        <h1>DeepSeek</h1>
        <p className="login-sub">第三方客户端 · 分支管理增强</p>
        <div className="login-field">
          <label>登录 Token</label>
          <textarea
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="从 chat.deepseek.com 的 localStorage.userToken 获取（value 字段）"
            rows={4}
          />
        </div>
        <button className="login-btn" onClick={submit} disabled={!token.trim()}>
          进入
        </button>
        <p className="login-hint">
          打开 https://chat.deepseek.com → F12 → Application → Local Storage →
          userToken → 复制 value 字段
        </p>
      </div>
    </div>
  );
}
