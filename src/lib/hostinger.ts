import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import type { OwnershipType } from '../types/domain'
import { supabase } from './supabase'

/*
 * Browser side of the Hostinger import. The browser only talks to the
 * hostinger-import Edge Function; the Hostinger API token lives in that
 * function's secrets and is never sent here. Response shapes mirror
 * supabase/functions/_shared/handler.ts.
 */

const FUNCTION_NAME = 'hostinger-import'

export type MatchKind = 'new' | 'update' | 'unchanged'

export interface HostingerPreviewItem {
  name: string
  providerId: string
  /** 'domain', 'free_domain', 'domain_transfer', 'free_domain_transfer' */
  type: string
  /** Raw Hostinger status: active, expired, pending_setup, … */
  status: string
  expiryDate: string | null
  registeredDate: string | null
  createdDate: string | null
  entryCount: number
  match: MatchKind
  changes: string[]
  notes: string[]
  ownershipEditable: boolean
  existing: { id: string; hasClient: boolean; registrar: string | null; expiryDate: string | null; ownershipType: string | null } | null
}

export interface HostingerPreview {
  fetchedAt: string
  schemaReady: boolean
  items: HostingerPreviewItem[]
  skipped: { entry: string; reason: string }[]
  warnings: string[]
}

export type ImportOutcome = 'inserted' | 'updated' | 'unchanged' | 'failed'

export interface HostingerImportResult {
  results: { name: string; outcome: ImportOutcome; message?: string }[]
  summary: Record<ImportOutcome, number>
  warnings: string[]
}

export class HostingerImportError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'HostingerImportError'
    this.code = code
  }
}

async function invoke<T>(body: object): Promise<T> {
  const { data, error } = await supabase.functions.invoke<T>(FUNCTION_NAME, { body })
  if (!error) {
    if (data === null) throw new HostingerImportError('empty_response', 'The import service returned no data.')
    return data
  }
  if (error instanceof FunctionsHttpError) {
    const res = error.context as Response
    let payload: { error?: { code?: string; message?: string } } | null = null
    try {
      payload = await res.json()
    } catch {
      // Not our JSON (e.g. a gateway error page).
    }
    if (payload?.error?.message) throw new HostingerImportError(payload.error.code ?? 'error', payload.error.message)
    if (res.status === 401) {
      throw new HostingerImportError('unauthorized', 'Your session has expired. Please sign in again.')
    }
    if (res.status === 404) {
      throw new HostingerImportError(
        'not_deployed',
        'The hostinger-import Edge Function is not deployed to this Supabase project yet.',
      )
    }
    throw new HostingerImportError('error', `The import service returned HTTP ${res.status}.`)
  }
  if (error instanceof FunctionsRelayError || error instanceof FunctionsFetchError) {
    throw new HostingerImportError(
      'unreachable',
      'Could not reach the import service. Check your connection, and that the hostinger-import function is deployed.',
    )
  }
  throw new HostingerImportError('error', error.message || 'Something went wrong. Please try again.')
}

export const fetchHostingerPreview = () => invoke<HostingerPreview>({ action: 'preview' })

export const importHostingerDomains = (domains: { name: string; ownershipType: OwnershipType }[]) =>
  invoke<HostingerImportResult>({ action: 'import', domains })
