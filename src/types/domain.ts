export type PaymentStatus = 'paid' | 'pending'

export interface Domain {
  id: string
  name: string
  client: string
  registrar: string
  /** ISO date string (YYYY-MM-DD) */
  expiryDate: string
  paymentStatus: PaymentStatus
}

/** Status shown in the UI, derived from expiry date and payment status. */
export type DomainStatus = 'active' | 'renewal-due' | 'payment-pending' | 'expired'
