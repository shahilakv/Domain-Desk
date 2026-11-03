import { useState, type FormEvent, type ReactNode } from 'react'
import { CubeCluster, LogoMark } from './components/Decorations'
import { describeAuthError } from './lib/authErrors'
import { recoveryRedirectUrl } from './lib/authRedirect'
import { supabase } from './lib/supabase'
import './Login.css'

interface AuthShellProps {
  onSubmit: (event: FormEvent<HTMLFormElement>) => void
  children: ReactNode
}

/** Shared layout for the sign-in, reset-request and set-new-password screens. */
export function AuthShell({ onSubmit, children }: AuthShellProps) {
  return (
    <main className="login-page">
      <div className="login-art" aria-hidden="true">
        <CubeCluster
          className="login-cubes"
          tone="blue"
          unit={26}
          cubes={[
            [0, 0, 0],
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
            [1, 0, 1],
          ]}
        />
      </div>

      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-brand">
          <LogoMark size={44} />
          <span className="brand-name">DomainDesk</span>
        </div>
        {children}
        <p className="login-footer">Private workspace · Authorized access only</p>
      </form>
    </main>
  )
}

interface LoginProps {
  /** Shown when a saved session could not be restored or a reset link failed. */
  sessionError?: string | null
}

export function Login({ sessionError = null }: LoginProps) {
  const [mode, setMode] = useState<'sign-in' | 'forgot'>(sessionError?.includes('reset link') ? 'forgot' : 'sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const switchMode = (next: 'sign-in' | 'forgot') => {
    setMode(next)
    setError(null)
    setNotice(null)
    setPassword('')
  }

  async function handleSignIn() {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw error
    // On success the auth listener in App swaps in the workspace.
  }

  async function handleResetRequest() {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: recoveryRedirectUrl() })
    if (error) throw error
    // Same message whether or not the address has an account, so it can't be used to probe accounts.
    setNotice(
      'If an account exists for that email, a reset link is on its way. Open only the newest email, once, in this browser.',
    )
    setLoading(false)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)
    if (mode === 'forgot' && !email.trim()) return setError('Enter your email address.')
    setLoading(true)
    try {
      if (mode === 'sign-in') await handleSignIn()
      else await handleResetRequest()
    } catch (err) {
      setError(describeAuthError(err as { message?: string; status?: number; code?: string }))
      setLoading(false)
    }
  }

  // A link problem is shown until the user acts on this screen.
  const shownError = error ?? (notice ? null : sessionError)

  return (
    <AuthShell onSubmit={handleSubmit}>
      <p className="login-eyebrow">Your domain workspace</p>
      <h1>{mode === 'sign-in' ? 'Welcome back' : 'Reset your password'}</h1>
      <p className="login-description">
        {mode === 'sign-in'
          ? 'Sign in to manage your clients, domains, and renewals.'
          : "Enter your account email and we'll send you a link to choose a new password."}
      </p>

      <label htmlFor="login-email">Email address</label>
      <input
        id="login-email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        placeholder="you@example.com"
        required
        autoFocus
      />

      {mode === 'sign-in' && (
        <>
          <div className="login-label-row">
            <label htmlFor="login-password">Password</label>
            <button type="button" className="login-link" onClick={() => switchMode('forgot')}>
              Forgot password?
            </button>
          </div>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter your password"
            required
          />
        </>
      )}

      {shownError && (
        <p className="login-error" role="alert">
          {shownError}
        </p>
      )}
      {notice && (
        <p className="login-notice" role="status">
          {notice}
        </p>
      )}

      <button type="submit" className="btn btn-primary login-submit" disabled={loading}>
        <span>
          {mode === 'sign-in' ? (loading ? 'Signing in…' : 'Sign in') : loading ? 'Sending…' : 'Send reset link'}
        </span>
      </button>

      {mode === 'forgot' && (
        <button type="button" className="login-link login-back" onClick={() => switchMode('sign-in')}>
          Back to sign in
        </button>
      )}
    </AuthShell>
  )
}
