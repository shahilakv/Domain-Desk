import { useState } from 'react'
import { normalizeWhatsApp } from '../../../supabase/functions/_shared/reminderRules.ts'
import { describeError, saveClient } from '../../lib/api'
import type { Client } from '../../types/domain'
import { nullIfEmpty } from '../../utils/format'
import { Field, FormDialog } from '../FormDialog'

interface ClientFormProps {
  userId: string
  client?: Client
  /** False until the reminders migration is applied; the reminder fields are then hidden. */
  remindersAvailable: boolean
  onSaved: (message: string) => void
  onClose: () => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ClientForm({ userId, client, remindersAvailable, onSaved, onClose }: ClientFormProps) {
  const [name, setName] = useState(client?.name ?? '')
  const [contactName, setContactName] = useState(client?.contactName ?? '')
  const [email, setEmail] = useState(client?.email ?? '')
  const [phone, setPhone] = useState(client?.phone ?? '')
  const [notes, setNotes] = useState(client?.notes ?? '')
  const [emailReminders, setEmailReminders] = useState(client?.emailReminders ?? true)
  const [whatsappNumber, setWhatsappNumber] = useState(client?.whatsappNumber ?? '')
  const [whatsappOptIn, setWhatsappOptIn] = useState(client?.whatsappOptIn ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Enter the client or business name.')
    if (email.trim() && !EMAIL_PATTERN.test(email.trim())) return setError('Enter a valid email address.')
    const waNumber = whatsappNumber.trim() ? normalizeWhatsApp(whatsappNumber) : null
    if (whatsappNumber.trim() && !waNumber) {
      return setError('Enter the WhatsApp number in international format with country code, e.g. +61 400 000 000.')
    }
    if (whatsappOptIn && !waNumber) return setError('Add the WhatsApp number the client agreed to be messaged on.')

    setError(null)
    setSubmitting(true)
    try {
      await saveClient(
        userId,
        {
          name: trimmedName,
          contact_name: nullIfEmpty(contactName),
          email: nullIfEmpty(email),
          phone: nullIfEmpty(phone),
          notes: nullIfEmpty(notes),
          ...(remindersAvailable && {
            email_reminders: emailReminders,
            whatsapp_number: waNumber,
            whatsapp_opt_in: whatsappOptIn,
            // Consent time: kept while consent stays on, set when it is first given.
            whatsapp_opt_in_at: whatsappOptIn ? (client?.whatsappOptIn ? client.whatsappOptInAt : new Date().toISOString()) : null,
          }),
        },
        client?.id,
      )
      onSaved(client ? `Saved ${trimmedName}.` : `Added ${trimmedName}.`)
    } catch (err) {
      setError(describeError(err))
      setSubmitting(false)
    }
  }

  return (
    <FormDialog
      title={client ? 'Edit client' : 'Add client'}
      submitLabel={client ? 'Save changes' : 'Add client'}
      editing={Boolean(client)}
      submitting={submitting}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <Field label="Client name *" htmlFor="client-name" full>
        <input
          id="client-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={200}
          required
          autoFocus
        />
      </Field>
      <Field label="Contact person" htmlFor="client-contact">
        <input id="client-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} maxLength={200} />
      </Field>
      <Field label="Phone" htmlFor="client-phone">
        <input id="client-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={50} />
      </Field>
      <Field label="Email" htmlFor="client-email" full>
        <input id="client-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={320} />
      </Field>
      {remindersAvailable && (
        <>
          <div className="field field-full field-checkbox">
            <label>
              <input type="checkbox" checked={emailReminders} onChange={(e) => setEmailReminders(e.target.checked)} />
              Send renewal reminders to this email
            </label>
          </div>
          <Field
            label="WhatsApp number"
            htmlFor="client-whatsapp"
            hint={phone && !whatsappNumber ? 'Use the international format, e.g. +61 400 000 000.' : 'International format with country code.'}
          >
            <input
              id="client-whatsapp"
              type="tel"
              value={whatsappNumber}
              onChange={(e) => setWhatsappNumber(e.target.value)}
              placeholder="+61 400 000 000"
              maxLength={20}
            />
          </Field>
          <div className="field field-checkbox">
            <label>
              <input type="checkbox" checked={whatsappOptIn} onChange={(e) => setWhatsappOptIn(e.target.checked)} />
              Client agreed to WhatsApp reminders
            </label>
          </div>
        </>
      )}
      <Field label="Notes" htmlFor="client-notes" full>
        <textarea id="client-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormDialog>
  )
}
