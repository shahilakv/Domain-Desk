import { LogoMark } from './components/Decorations'
import { useAuth } from './hooks/useAuth'
import { Login } from './Login'
import { SetNewPassword } from './SetNewPassword'
import { Workspace } from './Workspace'
import './App.css'

/**
 * Auth gate: nothing but the login screen renders without a session, and a
 * password-recovery session only reaches the "set new password" screen.
 */
function App() {
  const { auth, finishRecovery } = useAuth()

  if (auth.status === 'loading') {
    return (
      <div className="auth-loading" role="status">
        <LogoMark size={48} />
        <p>Loading DomainDesk…</p>
      </div>
    )
  }

  if (auth.status === 'signed-out') {
    return <Login sessionError={auth.error} />
  }

  if (auth.status === 'recovery') {
    return <SetNewPassword email={auth.session.user.email ?? ''} onDone={finishRecovery} />
  }

  // Keyed by user so no state survives a switch between accounts.
  return <Workspace key={auth.session.user.id} session={auth.session} />
}

export default App
