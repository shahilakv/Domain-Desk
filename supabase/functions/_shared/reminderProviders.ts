/*
 * Senders for renewal reminders. Keys come from Edge Function secrets and
 * are never included in results, errors or logs.
 *
 *   Email:    Resend — POST https://api.resend.com/emails
 *   WhatsApp: WhatsApp Business Platform Cloud API (Meta) —
 *             POST https://graph.facebook.com/{version}/{phone-number-id}/messages
 *             with an approved message template (required for
 *             business-initiated messages outside the 24-hour service window).
 *
 * A successful call means the provider ACCEPTED the message, not that it was
 * delivered; delivery is only recorded from provider webhooks.
 */

import type { EmailMessage } from './reminderRules.ts'

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; retryable: boolean; error: string }

const TIMEOUT_MS = 15_000

export interface EmailConfig {
  apiKey: string
}

export interface WhatsAppConfig {
  accessToken: string
  phoneNumberId: string
  apiVersion: string
}

async function post(fetchImpl: FetchLike, url: string, headers: Record<string, string>, body: unknown): Promise<Response | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const readJson = async (res: Response): Promise<Record<string, unknown> | null> => {
  try {
    const body = await res.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const clip = (value: unknown) => (typeof value === 'string' ? value.slice(0, 300) : '')

export async function sendEmail(
  fetchImpl: FetchLike,
  config: EmailConfig,
  message: EmailMessage & { from: string; to: string; replyTo?: string | null },
  idempotencyKey: string,
): Promise<SendResult> {
  const res = await post(
    fetchImpl,
    'https://api.resend.com/emails',
    // Resend ignores a repeated request with the same key for 24 hours.
    { Authorization: `Bearer ${config.apiKey}`, 'Idempotency-Key': idempotencyKey },
    {
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    },
  )
  if (!res) return { ok: false, retryable: true, error: 'Could not reach Resend (network error or timeout).' }
  const body = await readJson(res)
  if (res.ok) return { ok: true, providerMessageId: typeof body?.id === 'string' ? body.id : null }
  const detail = clip(body?.message) || clip(body?.name) || `HTTP ${res.status}`
  const retryable = res.status === 429 || res.status >= 500
  const hint =
    res.status === 401 || res.status === 403
      ? ' Check RESEND_API_KEY and that the sender domain is verified in Resend.'
      : ''
  return { ok: false, retryable, error: `Resend rejected the email (HTTP ${res.status}): ${detail}.${hint}` }
}

/** Graph API error codes worth retrying later: throttling and temporary service problems. */
const WHATSAPP_RETRYABLE_CODES = new Set([1, 2, 4, 17, 341, 80007, 130429, 131000, 131016, 131048, 131056, 133004])

const WHATSAPP_HINTS: Record<number, string> = {
  190: 'The access token is invalid or expired (WHATSAPP_ACCESS_TOKEN).',
  132000: 'The template parameters do not match the approved template (it needs 5 body variables).',
  132001: 'The template does not exist in this language or is not approved yet.',
  132015: 'The template is paused by Meta.',
  132016: 'The template is disabled by Meta.',
  131026: 'The number is not on WhatsApp or cannot receive messages.',
  131047: 'Outside the 24-hour window: a template message is required.',
  131050: 'The client has stopped marketing messages from this business.',
}

export async function sendWhatsApp(
  fetchImpl: FetchLike,
  config: WhatsAppConfig,
  message: { to: string; templateName: string; language: string; params: string[] },
): Promise<SendResult> {
  const url = `https://graph.facebook.com/${encodeURIComponent(config.apiVersion)}/${encodeURIComponent(config.phoneNumberId)}/messages`
  const res = await post(fetchImpl, url, { Authorization: `Bearer ${config.accessToken}` }, {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    // Cloud API takes the number without the leading "+".
    to: message.to.replace(/^\+/, ''),
    type: 'template',
    template: {
      name: message.templateName,
      language: { code: message.language },
      components: [{ type: 'body', parameters: message.params.map((text) => ({ type: 'text', text })) }],
    },
  })
  if (!res) return { ok: false, retryable: true, error: 'Could not reach the WhatsApp Cloud API (network error or timeout).' }
  const body = await readJson(res)
  if (res.ok) {
    const messages = Array.isArray(body?.messages) ? (body.messages as { id?: unknown }[]) : []
    const id = typeof messages[0]?.id === 'string' ? messages[0].id : null
    return { ok: true, providerMessageId: id }
  }
  const err = (body?.error ?? {}) as { message?: unknown; code?: unknown; error_data?: { details?: unknown } }
  const code = typeof err.code === 'number' ? err.code : null
  const retryable = res.status === 429 || res.status >= 500 || (code !== null && WHATSAPP_RETRYABLE_CODES.has(code))
  const detail = clip(err.error_data?.details) || clip(err.message) || `HTTP ${res.status}`
  const hint = code !== null && WHATSAPP_HINTS[code] ? ` ${WHATSAPP_HINTS[code]}` : ''
  return {
    ok: false,
    retryable,
    error: `WhatsApp rejected the message (${code !== null ? `error ${code}` : `HTTP ${res.status}`}): ${detail}.${hint}`,
  }
}
