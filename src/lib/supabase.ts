import { createClient } from '@supabase/supabase-js'

// Strip a byte-order mark (U+FEFF) that some shells add when piping values into a
// host's env settings; browsers reject it in request headers. It is removed
// explicitly because the minifier's build-time trim() does not treat it as whitespace.
const cleanEnv = (value: string | undefined) => value?.replace(/\uFEFF/g, '').trim()

const rawSupabaseUrl = cleanEnv(import.meta.env.VITE_SUPABASE_URL)
const supabasePublishableKey = cleanEnv(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY)

if (!rawSupabaseUrl || !supabasePublishableKey) {
	throw new Error('Missing Supabase environment variables. Check your .env file.')
}
if (!/^[\x21-\x7e]+$/.test(supabasePublishableKey)) {
	throw new Error('VITE_SUPABASE_PUBLISHABLE_KEY contains invalid characters. Re-enter it in your environment settings.')
}

// The client needs the bare project URL (https://<ref>.supabase.co). Tolerate a
// copied REST endpoint such as ".../rest/v1/" so requests don't 404.
const supabaseUrl = rawSupabaseUrl.trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '')

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
	auth: {
		persistSession: true,
		autoRefreshToken: true,
		// PKCE: a password-reset link only completes in the browser that requested
		// it, and the one-time code is exchanged (then removed from the URL) here.
		flowType: 'pkce',
		detectSessionInUrl: true,
	},
})
