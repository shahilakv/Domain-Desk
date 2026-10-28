import { Icon } from './Icon'

interface DeleteButtonProps {
  domainName: string
  onClick: () => void
}

/** Subtle icon-only delete action with an accessible label. */
export function DeleteButton({ domainName, onClick }: DeleteButtonProps) {
  const label = `Delete ${domainName}`
  return (
    <button type="button" className="icon-button delete-button" onClick={onClick} aria-label={label} title={label}>
      <Icon name="trash" size={18} />
    </button>
  )
}
