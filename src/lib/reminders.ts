import { invokeEdgeFunction } from './hostinger'

/*
 * Browser side of the renewal-reminders Edge Function. Provider keys live in
 * that function's secrets; the browser only learns whether each one is set.
 */

const FUNCTION_NAME = 'renewal-reminders'

export interface ProviderStatus {
  configured: boolean
  /** Names of the missing Edge Function secrets, e.g. RESEND_API_KEY. */
  missing: string[]
}

export interface ReminderServiceStatus {
  email: ProviderStatus
  whatsapp: ProviderStatus
  scheduler: { scheduled: boolean; schedule: string | null; lastRunAt: string | null; lastRunStatus: string | null } | null
}

export const fetchReminderStatus = () => invokeEdgeFunction<ReminderServiceStatus>(FUNCTION_NAME, { action: 'status' })

/** Email goes to the signed-in user's own address; WhatsApp to the number given. */
export const sendTestReminder = (channel: 'email' | 'whatsapp', to?: string) =>
  invokeEdgeFunction<{ ok: true; message: string }>(FUNCTION_NAME, { action: 'test', channel, to })
