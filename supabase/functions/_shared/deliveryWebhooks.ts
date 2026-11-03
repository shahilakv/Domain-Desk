/*
 * Delivery-status webhooks for renewal reminders. Only these provider
 * confirmations move a notification past 'accepted':
 *
 *   ?provider=whatsapp  Meta WhatsApp Cloud API. GET = subscription check
 *                       (hub.verify_token); POST signed with X-Hub-Signature-256
 *                       (HMAC-SHA256 of the raw body with the app secret).
 *                       statuses[].status: sent | delivered | read | failed.
 *   ?provider=resend    Resend (Svix). Signed with svix-id / svix-timestamp /
 *                       svix-signature. email.delivered, email.bounced,
 *                       email.opened.
 *
 * Unsigned or wrongly signed requests are rejected; nothing is written.
 */

export type DeliveryStatus = 'delivered' | 'read' | 'failed'

export interface DeliveryStore {
  /** Applies a status to the log row with this provider id, never moving backwards. Returns rows changed. */
  apply(channel: 'email' | 'whatsapp', providerMessageId: string, status: DeliveryStatus, error: string | null): Promise<number>
}

export interface WebhookDeps {
  whatsappAppSecret: string | null
  whatsappVerifyToken: string | null
  resendWebhookSecret: string | null
  store: DeliveryStore
  now?: () => Date
}

const MAX_SKEW_SECONDS = 5 * 60
const encoder = new TextEncoder()

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)))
}

const toHex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function verifyMetaSignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header ?? '')
  if (!match) return false
  const expected = toHex(await hmac(encoder.encode(appSecret), rawBody))
  return timingSafeEqual(expected, match[1].toLowerCase())
}

export async function verifySvixSignature(
  secret: string,
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
  now: Date,
): Promise<boolean> {
  if (!headers.id || !headers.timestamp || !headers.signature) return false
  const ts = Number(headers.timestamp)
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > MAX_SKEW_SECONDS) return false
  const key = fromBase64(secret.replace(/^whsec_/, ''))
  if (!key) return false
  const expected = toBase64(await hmac(key, `${headers.id}.${headers.timestamp}.${rawBody}`))
  return headers.signature.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    return version === 'v1' && typeof sig === 'string' && timingSafeEqual(sig, expected)
  })
}

const text = (status: number, body: string) => new Response(body, { status, headers: { 'Content-Type': 'text/plain' } })

const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, 300) : null)

async function whatsapp(req: Request, url: URL, deps: WebhookDeps): Promise<Response> {
  if (req.method === 'GET') {
    // Meta's one-time subscription check.
    const token = url.searchParams.get('hub.verify_token')
    if (url.searchParams.get('hub.mode') === 'subscribe' && deps.whatsappVerifyToken && token && timingSafeEqual(token, deps.whatsappVerifyToken)) {
      return text(200, url.searchParams.get('hub.challenge') ?? '')
    }
    return text(403, 'Verification failed.')
  }
  if (!deps.whatsappAppSecret) return text(503, 'WhatsApp webhooks are not configured (WHATSAPP_APP_SECRET).')
  const raw = await req.text()
  if (!(await verifyMetaSignature(deps.whatsappAppSecret, raw, req.headers.get('x-hub-signature-256')))) {
    return text(401, 'Invalid signature.')
  }
  let payload: { entry?: { changes?: { value?: { statuses?: unknown[] } }[] }[] }
  try {
    payload = JSON.parse(raw)
  } catch {
    return text(400, 'Invalid JSON.')
  }
  let applied = 0
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const raw of change.value?.statuses ?? []) {
        const s = raw as { id?: unknown; status?: unknown; errors?: { title?: unknown; message?: unknown; error_data?: { details?: unknown } }[] }
        if (typeof s.id !== 'string') continue
        const status: DeliveryStatus | null = s.status === 'delivered' ? 'delivered' : s.status === 'read' ? 'read' : s.status === 'failed' ? 'failed' : null
        if (!status) continue // 'sent' only repeats what the API call already told us.
        const e = s.errors?.[0]
        const error = status === 'failed' ? `WhatsApp could not deliver: ${clip(e?.error_data?.details) ?? clip(e?.message) ?? clip(e?.title) ?? 'unknown reason'}` : null
        applied += await deps.store.apply('whatsapp', s.id, status, error)
      }
    }
  }
  return text(200, `ok ${applied}`)
}

async function resend(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== 'POST') return text(405, 'Use POST.')
  if (!deps.resendWebhookSecret) return text(503, 'Resend webhooks are not configured (RESEND_WEBHOOK_SECRET).')
  const raw = await req.text()
  const ok = await verifySvixSignature(
    deps.resendWebhookSecret,
    raw,
    { id: req.headers.get('svix-id'), timestamp: req.headers.get('svix-timestamp'), signature: req.headers.get('svix-signature') },
    deps.now?.() ?? new Date(),
  )
  if (!ok) return text(401, 'Invalid signature.')
  let event: { type?: unknown; data?: { email_id?: unknown; bounce?: { message?: unknown } } }
  try {
    event = JSON.parse(raw)
  } catch {
    return text(400, 'Invalid JSON.')
  }
  const id = event.data?.email_id
  if (typeof id !== 'string') return text(200, 'ignored')
  const status: DeliveryStatus | null =
    event.type === 'email.delivered' ? 'delivered' : event.type === 'email.opened' ? 'read' : event.type === 'email.bounced' ? 'failed' : null
  if (!status) return text(200, 'ignored')
  const error = status === 'failed' ? `Email bounced${clip(event.data?.bounce?.message) ? `: ${clip(event.data?.bounce?.message)}` : '.'}` : null
  return text(200, `ok ${await deps.store.apply('email', id, status, error)}`)
}

export async function handleWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  const url = new URL(req.url)
  const provider = url.searchParams.get('provider')
  try {
    if (provider === 'whatsapp') return await whatsapp(req, url, deps)
    if (provider === 'resend') return await resend(req, deps)
    return text(404, 'Unknown provider.')
  } catch {
    // Providers retry on 5xx, which is what we want for a database hiccup.
    return text(500, 'Could not record the status.')
  }
}
