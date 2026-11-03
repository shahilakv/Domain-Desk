import { createClient } from '@supabase/supabase-js'

const rawSupabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

if (!rawSupabaseUrl || !supabasePublishableKey) {
	throw new Error('Missing Supabase environment variables. Check your .env file.')
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
