/** Maps Supabase auth errors to plain-language messages. */
export function describeAuthError(error: { message?: string; status?: number; code?: string }): string {
  const message = error.message ?? ''
  if (error.code === 'invalid_credentials' || /invalid login credentials/i.test(message)) {
    return 'Incorrect email or password.'
  }
  if (error.code === 'email_not_confirmed' || /email not confirmed/i.test(message)) {
    return 'This email address has not been confirmed yet.'
  }
  if (error.code === 'over_email_send_rate_limit' || /email rate limit|only request this after/i.test(message)) {
    // Covers both the per-address cooldown and the project's hourly email cap (2/hour on Supabase's built-in email).
    return 'The email limit has been reached, so no reset email was sent. Please try again later (this can take up to an hour).'
  }
  if (error.code === 'same_password') {
    return 'Choose a password different from your current one.'
  }
  if (error.code === 'weak_password') {
    return 'That password is too weak. Use a longer password with a mix of characters.'
  }
  if (error.code === 'session_not_found' || error.code === 'session_expired' || /auth session missing/i.test(message)) {
    return 'Your reset session has expired. Request a new reset link.'
  }
  if (error.status === 429 || /rate limit/i.test(message)) {
    return 'Too many attempts. Please wait a moment and try again.'
  }
  if (/fetch|network/i.test(message)) {
    return 'Could not reach the sign-in service. Check your connection and try again.'
  }
  return message || 'Something went wrong. Please try again.'
}
