// Supabase Edge Function: delivery-status webhooks for renewal reminders.
// Deploy with --no-verify-jwt (providers can't send a Supabase JWT); every
// request is authenticated by the provider's signature instead.
//
//   WhatsApp: https://<project>.supabase.co/functions/v1/notification-webhooks?provider=whatsapp
//             secrets WHATSAPP_APP_SECRET, WHATSAPP_WEBHOOK_VERIFY_TOKEN
//   Resend:   https://<project>.supabase.co/functions/v1/notification-webhooks?provider=resend
//             secret RESEND_WEBHOOK_SECRET
//
// Uses the service role only to update notification_log rows matched by the
// provider's message id; it never reads or returns other data.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.118.0'
import { handleWebhook, type DeliveryStatus } from '../_shared/deliveryWebhooks.ts'

const env = (name: string) => Deno.env.get(name)?.trim() || null

/** Statuses a webhook may move a row from, so it never goes backwards (e.g. read → delivered). */
const FROM: Record<DeliveryStatus, string[]> = {
  delivered: ['pending', 'accepted'],
  read: ['pending', 'accepted', 'delivered'],
  failed: ['pending', 'accepted'],
}

let db: SupabaseClient | null = null

Deno.serve((req) =>
  handleWebhook(req, {
    whatsappAppSecret: env('WHATSAPP_APP_SECRET'),
    whatsappVerifyToken: env('WHATSAPP_WEBHOOK_VERIFY_TOKEN'),
    resendWebhookSecret: env('RESEND_WEBHOOK_SECRET'),
    store: {
      async apply(channel, providerMessageId, status, error) {
        db ??= createClient(env('SUPABASE_URL')!, env('SUPABASE_SERVICE_ROLE_KEY')!, {
          auth: { persistSession: false, autoRefreshToken: false },
        })
        const { data, error: dbError } = await db
          .from('notification_log')
          .update({ status, retryable: false, ...(error ? { error } : {}) })
          .eq('channel', channel)
          .eq('provider_message_id', providerMessageId)
          .in('status', FROM[status])
          .select('id')
        if (dbError) throw dbError
        return data?.length ?? 0
      },
    },
  }),
)
