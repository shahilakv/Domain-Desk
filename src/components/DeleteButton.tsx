import { Icon } from './Icon'

interface RowActionButtonProps {
  /** Name of the record, used in the accessible label. */
  itemName: string
  onClick: () => void
}

/** Subtle icon-only delete action with an accessible label. */
export function DeleteButton({ itemName, onClick }: RowActionButtonProps) {
  const label = `Delete ${itemName}`
  return (
    <button type="button" className="icon-button delete-button" onClick={onClick} aria-label={label} title={label}>
      <Icon name="trash" size={18} />
    </button>
  )
}

/** Matching icon-only edit action. */
export function EditButton({ itemName, onClick }: RowActionButtonProps) {
  const label = `Edit ${itemName}`
  return (
    <button type="button" className="icon-button edit-button" onClick={onClick} aria-label={label} title={label}>
      <Icon name="edit" size={18} />
    </button>
  )
}

interface RowActionsProps {
  itemName: string
  onEdit?: () => void
  onDelete?: () => void
}

export function RowActions({ itemName, onEdit, onDelete }: RowActionsProps) {
  return (
    <span className="row-actions">
      {onEdit && <EditButton itemName={itemName} onClick={onEdit} />}
      {onDelete && <DeleteButton itemName={itemName} onClick={onDelete} />}
    </span>
  )
}
