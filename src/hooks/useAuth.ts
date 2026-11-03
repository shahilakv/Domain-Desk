import type { Session } from '@supabase/supabase-js'
import { useCallback, useEffect, useState } from 'react'
import {
  cleanAuthParamsFromUrl,
  clearRecoveryPending,
  isRecoveryPending,
  markRecoveryPending,
  recoveryLinkProblem,
} from '../lib/authRedirect'
import { supabase } from '../lib/supabase'

export type AuthState =
  | { status: 'loading' }
  | { status: 'signed-out'; error: string | null }
  /** Signed in through a reset link: must set a new password before using the workspace. */
  | { status: 'recovery'; session: Session }
  | { status: 'signed-in'; session: Session }

/** A session counts as recovery while the pending flag is set (survives a reload). */
function stateFor(session: Session): AuthState {
  return isRecoveryPending() ? { status: 'recovery', session } : { status: 'signed-in', session }
}

/**
 * Restores the persisted Supabase session and follows sign-in, sign-out,
 * token refresh and password-recovery events. A failed refresh arrives as a
 * sign-out.
 */
export function useAuth(): { auth: AuthState; finishRecovery: () => void } {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let active = true

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active) return
        const linkProblem = recoveryLinkProblem(Boolean(data.session))
        cleanAuthParamsFromUrl()
        if (error) {
          clearRecoveryPending()
          setState({ status: 'signed-out', error: 'Your session could not be restored. Please sign in again.' })
        } else if (data.session) {
          setState(stateFor(data.session))
        } else {
          clearRecoveryPending()
          setState({ status: 'signed-out', error: linkProblem })
        }
      })
      .catch(() => {
        if (active) setState({ status: 'signed-out', error: 'Could not reach the sign-in service. Check your connection.' })
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return
      if (event === 'PASSWORD_RECOVERY' && session) {
        markRecoveryPending()
        setState({ status: 'recovery', session })
      } else if (session) {
        setState(stateFor(session))
      } else {
        clearRecoveryPending()
        setState((current) => (current.status === 'signed-out' ? current : { status: 'signed-out', error: null }))
      }
    })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  /** Called after the new password is saved and the user continues to the workspace. */
  const finishRecovery = useCallback(() => {
    clearRecoveryPending()
    setState((current) => (current.status === 'recovery' ? { status: 'signed-in', session: current.session } : current))
  }, [])

  return { auth: state, finishRecovery }
}
