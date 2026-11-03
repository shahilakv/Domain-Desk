import { useCallback, useEffect, useState } from 'react'
import { describeError, fetchWorkspace, type WorkspaceData } from '../lib/api'

export type WorkspaceState =
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; data: WorkspaceData }

/**
 * Loads every record for the signed-in user. Call `reload` after a successful
 * write; the previous data stays on screen until the refreshed data arrives.
 */
export function useWorkspaceData(userId: string) {
  const [state, setState] = useState<WorkspaceState>({ status: 'loading' })
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let active = true
    fetchWorkspace(userId)
      .then((data) => active && setState({ status: 'ready', data }))
      .catch((error: unknown) => {
        if (!active) return
        // Keep showing stale data if a background refresh fails.
        setState((current) =>
          current.status === 'ready' ? current : { status: 'error', error: describeError(error) },
        )
      })
    return () => {
      active = false
    }
  }, [userId, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const retry = useCallback(() => {
    setState({ status: 'loading' })
    setVersion((v) => v + 1)
  }, [])

  return { state, reload, retry }
}
