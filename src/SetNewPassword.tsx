import { useState, type FormEvent } from 'react'
import { describeAuthError } from './lib/authErrors'
import { AuthShell } from './Login'
import { supabase } from './lib/supabase'

const MIN_LENGTH = 8

interface SetNewPasswordProps {
  email: string
  /** Leaves recovery mode and opens the workspace. */
  onDone: () => void
}

/**
 * Shown for a password-recovery session. The workspace stays hidden until a
 * new password is saved (or the user signs out).
 */
export function SetNewPassword({ email, onDone }: SetNewPasswordProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saved) return onDone()
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`)
    if (password !== confirm) return setError("The two passwords don't match.")

    setError(null)
    setSaving(true)
    const { error } = await supabase.auth.updateUser({ password })
    setSaving(false)
    if (error) return setError(describeAuthError(error))
    setPassword('')
    setConfirm('')
    setSaved(true)
  }

  async function cancel() {
    // Signing out ends the recovery session; the auth listener shows the login screen.
    await supabase.auth.signOut()
  }

  return (
    <AuthShell onSubmit={handleSubmit}>
      <p className="login-eyebrow">Account recovery</p>
      <h1>{saved ? 'Password updated' : 'Set a new password'}</h1>
      <p className="login-description">
        {saved ? (
          'Your new password is saved. Use it the next time you sign in.'
        ) : (
          <>
            Choose a new password for <strong>{email}</strong>.
          </>
        )}
      </p>

      {!saved && (
        <>
          {/* Hidden username field lets password managers save the new password against this account. */}
          <input type="email" autoComplete="username" value={email} readOnly hidden />

          <label htmlFor="new-password">New password</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={`At least ${MIN_LENGTH} characters`}
            minLength={MIN_LENGTH}
            required
            autoFocus
          />

          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="Type it again"
            required
          />
        </>
      )}

      {error && (
        <p className="login-error" role="alert">
          {error}
        </p>
      )}
      {saved && (
        <p className="login-notice" role="status">
          Password changed successfully.
        </p>
      )}

      <button type="submit" className="btn btn-primary login-submit" disabled={saving} autoFocus={saved}>
        <span>{saved ? 'Continue to DomainDesk' : saving ? 'Saving…' : 'Save new password'}</span>
      </button>

      {!saved && (
        <button type="button" className="login-link login-back" onClick={cancel} disabled={saving}>
          Cancel and sign out
        </button>
      )}
    </AuthShell>
  )
}
