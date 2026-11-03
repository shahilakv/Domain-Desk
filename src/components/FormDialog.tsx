import { useEffect, useRef, type FormEvent, type ReactNode } from 'react'
import { Button } from './Button'

interface FormDialogProps {
  title: string
  submitLabel: string
  /** Editing an existing record (shows a check instead of a plus). */
  editing?: boolean
  submitting: boolean
  error: string | null
  onSubmit: () => void
  onClose: () => void
  children: ReactNode
}

/**
 * Modal form on the native <dialog>, styled like ConfirmDialog. Mount it only
 * while open; it opens itself and can't be dismissed mid-save.
 */
export function FormDialog({ title, submitLabel, editing = false, submitting, error, onSubmit, onClose, children }: FormDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
  }, [])

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!submitting) onSubmit()
  }

  return (
    <dialog
      ref={dialogRef}
      className="confirm-dialog form-dialog"
      aria-labelledby="form-dialog-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!submitting) onClose()
      }}
    >
      <form className="confirm-panel" onSubmit={handleSubmit} noValidate>
        <h2 id="form-dialog-title">{title}</h2>
        <div className="form-grid">{children}</div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="confirm-actions">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="submit" icon={editing ? 'check' : 'plus'} disabled={submitting}>
            {submitting ? 'Saving…' : submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  )
}

interface FieldProps {
  label: string
  htmlFor: string
  hint?: string
  full?: boolean
  children: ReactNode
}

export function Field({ label, htmlFor, hint, full, children }: FieldProps) {
  return (
    <div className={`field${full ? ' field-full' : ''}`}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
