import { useState } from 'react'
import { describeError, saveClient } from '../../lib/api'
import type { Client } from '../../types/domain'
import { nullIfEmpty } from '../../utils/format'
import { Field, FormDialog } from '../FormDialog'

interface ClientFormProps {
  userId: string
  client?: Client
  onSaved: (message: string) => void
  onClose: () => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function ClientForm({ userId, client, onSaved, onClose }: ClientFormProps) {
  const [name, setName] = useState(client?.name ?? '')
  const [contactName, setContactName] = useState(client?.contactName ?? '')
  const [email, setEmail] = useState(client?.email ?? '')
  const [phone, setPhone] = useState(client?.phone ?? '')
  const [notes, setNotes] = useState(client?.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Enter the client or business name.')
    if (email.trim() && !EMAIL_PATTERN.test(email.trim())) return setError('Enter a valid email address.')

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
      <Field label="Notes" htmlFor="client-notes" full>
        <textarea id="client-notes" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </Field>
    </FormDialog>
  )
}
