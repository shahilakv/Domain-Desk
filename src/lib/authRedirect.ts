/*
 * Password-recovery redirect handling (PKCE).
 *
 * "Forgot password?" sends a reset email whose link returns to
 * `<origin>/?recovery=1&code=…`. supabase-js exchanges the code (only possible
 * in the browser that requested the reset, which holds the PKCE verifier) and
 * removes `code` from the URL. Everything here only reads the URL and a
 * yes/no flag; no token is ever stored or logged by the app.
 */

const RECOVERY_PARAM = 'recovery'
/** sessionStorage flag: a recovery session is open and a new password has not been set yet. */
const RECOVERY_FLAG = 'domaindesk.passwordRecoveryPending'
const AUTH_PARAMS = [RECOVERY_PARAM, 'code', 'error', 'error_code', 'error_description', 'sb']

// Captured once at load, before the Supabase client rewrites the URL.
const initialUrl = new URL(window.location.href)
const hashParams = new URLSearchParams(initialUrl.hash.replace(/^#/, ''))

function param(name: string): string | null {
  return initialUrl.searchParams.get(name) ?? hashParams.get(name)
}

/** The page was opened from a reset email sent by this app. */
export const openedFromRecoveryLink = initialUrl.searchParams.get(RECOVERY_PARAM) === '1'

const linkErrorCode = param('error_code') ?? param('error')

function readFlag(): boolean {
  try {
    return window.sessionStorage.getItem(RECOVERY_FLAG) === '1'
  } catch {
    return false
  }
}

export function markRecoveryPending(): void {
  try {
    window.sessionStorage.setItem(RECOVERY_FLAG, '1')
  } catch {
    // Storage unavailable: the in-memory auth state still shows the reset screen.
  }
}

export function clearRecoveryPending(): void {
  try {
    window.sessionStorage.removeItem(RECOVERY_FLAG)
  } catch {
    // Nothing to clear.
  }
}

export const isRecoveryPending = readFlag

// Set before any auth event fires so the dashboard never flashes on a recovery link.
if (openedFromRecoveryLink && !linkErrorCode) markRecoveryPending()

/** Plain-language message for a reset link that could not be used, or null. */
export function recoveryLinkProblem(gotSession: boolean): string | null {
  if (linkErrorCode === 'otp_expired') {
    return 'This password reset link has expired or was already used. Request a new one below and open only the newest email.'
  }
  if (linkErrorCode) {
    return 'This password reset link could not be used. Request a new one below.'
  }
  if (openedFromRecoveryLink && !gotSession) {
    return 'This reset link must be opened in the same browser where you requested it, and only once. Request a new one below.'
  }
  return null
}

/** Removes auth parameters from the address bar so a reload or shared URL carries nothing. */
export function cleanAuthParamsFromUrl(): void {
  const url = new URL(window.location.href)
  let changed = false
  for (const name of AUTH_PARAMS) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name)
      changed = true
    }
  }
  if (url.hash && /(^|[#&])(error|error_code|error_description|access_token)=/.test(url.hash)) {
    url.hash = ''
    changed = true
  }
  if (changed) window.history.replaceState(window.history.state, '', url.toString())
}

/** Where reset emails send the user back to. Must match an allowed Redirect URL in Supabase. */
export function recoveryRedirectUrl(): string {
  return `${window.location.origin}/?${RECOVERY_PARAM}=1`
}
