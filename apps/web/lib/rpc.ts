'use client'

import type { ProcedureName } from '@zerofold/commands'

export type RpcResult<T> = { data: T } | { error: { code: string; message: string } }

/**
 * Call a procedure.
 *
 * Errors come back as values rather than exceptions, because at a call site every one of them
 * is something to show the user — an authorization refusal, a validation failure, a domain
 * rule — and wrapping each call in try/catch to reach the message is noise.
 */
export async function rpc<T = unknown>(
  procedure: ProcedureName,
  input: unknown,
): Promise<RpcResult<T>> {
  const response = await fetch(`/api/rpc/${procedure}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = (await response.json()) as RpcResult<T>
  return body
}
