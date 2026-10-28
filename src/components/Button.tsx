import type { ButtonHTMLAttributes } from 'react'
import { Icon, type IconName } from './Icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger'
  icon?: IconName
  iconPosition?: 'start' | 'end'
}

export function Button({
  variant = 'primary',
  icon,
  iconPosition = 'start',
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconEl = icon ? <Icon name={icon} size={18} /> : null
  return (
    <button type={type} className={`btn btn-${variant} ${className}`.trim()} {...rest}>
      {iconPosition === 'start' && iconEl}
      <span>{children}</span>
      {iconPosition === 'end' && iconEl}
    </button>
  )
}
