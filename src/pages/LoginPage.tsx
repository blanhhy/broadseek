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
        <h1>BroadSeek 登录</h1>
        <div className="login-field">
          <textarea
            value={token}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="请输入 Deepseek 的 userToken ..."
            rows={1}
          />
        </div>
        <button className="login-btn"
                onClick={submit}
                disabled={!token.trim()}
                title={!token.trim() ? "请输入 Token" : "登录"} 
          >
          进入
        </button>
      </div>
    </div>
  );
}
