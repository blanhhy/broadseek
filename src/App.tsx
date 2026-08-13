import { useAuth } from './core/store';
import LoginPage from './pages/LoginPage';
import ChatPage from './pages/ChatPage';

export default function App() {
  const token = useAuth((s) => s.token);
  if (!token) return <LoginPage />;
  return <ChatPage />;
}
