'use client'

import { Upload } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Money } from '@/components/money'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { rpc } from '@/lib/rpc'
import { cn } from '@/lib/utils'

interface PreviewRow {
  importId: string
  date: string
  amount: string
  payeeName: string | null
  memo: string | null
  matchedTransactionId: string | null
  matchReason: 'external-id' | 'same-amount-and-date' | null
}

interface Preview {
  importerId: string
  rows: PreviewRow[]
  warnings: string[]
  newCount: number
  duplicateCount: number
}

/**
 * Import, as three steps on one screen.
 *
 * The file is read in the browser and posted as text: it never lands on disk, which is the
 * right default for a bank statement on a machine somebody else administers.
 *
 * Nothing is written until the last button. The preview's duplicate detection is a *guess* —
 * the strong kind when the bank supplied its own identifier, the weak kind when it did not —
 * so every row keeps its own checkbox and the guess only sets the initial state.
 */
export function ImportFlow({ planId, accountId }: { planId: string; accountId: string }) {
  const router = useRouter()
  const [filename, setFilename] = useState<string | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onFile(file: File) {
    setError(null)
    setPreview(null)
    setBusy(true)

    const text = await file.text()
    setFilename(file.name)
    setContent(text)

    const result = await rpc<Preview>('import.preview', {
      planId,
      accountId,
      content: text,
      filename: file.name,
    })
    setBusy(false)

    if ('error' in result) {
      setError(result.error.message)
      return
    }
    setPreview(result.data)
    // Everything the preview did not recognise, pre-ticked. The rest is one click away.
    setAccepted(
      new Set(result.data.rows.filter((r) => !r.matchedTransactionId).map((r) => r.importId)),
    )
  }

  async function commit() {
    if (!content) return
    setError(null)
    setBusy(true)

    const result = await rpc<{ created: number }>('import.commit', {
      planId,
      accountId,
      content,
      ...(filename === null ? {} : { filename }),
      acceptImportIds: [...accepted],
    })
    setBusy(false)

    if ('error' in result) {
      setError(result.error.message)
      return
    }
    router.push(`/plans/${planId}/accounts/${accountId}`)
    router.refresh()
  }

  const toggle = (importId: string) =>
    setAccepted((current) => {
      const next = new Set(current)
      if (next.has(importId)) next.delete(importId)
      else next.add(importId)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-6 py-4">
        <label className="flex w-fit cursor-pointer items-center gap-2 rounded-md border border-dashed px-4 py-3 text-sm hover:bg-surface-sunken">
          <Upload className="size-4 text-ink-subtle" aria-hidden />
          <span>{filename ?? 'Choose a file from your bank'}</span>
          <input
            type="file"
            className="sr-only"
            accept=".csv,.tsv,.txt,.ofx,.qfx,.qbo,.qif"
            onChange={(event) => {
              const file = event.target.files?.[0]
              if (file) void onFile(file)
            }}
          />
        </label>
        <p className="mt-2 text-xs text-ink-subtle">
          CSV, OFX, QFX or QIF. The file is read here and never stored.
        </p>
      </div>

      {error && (
        <p role="alert" className="border-b bg-negative-wash px-6 py-2 text-sm text-negative">
          {error}
        </p>
      )}

      {preview && (
        <>
          <div className="flex flex-wrap items-center gap-4 border-b px-6 py-2 text-sm">
            <span className="font-medium">
              {preview.newCount} new, {preview.duplicateCount} already here
            </span>
            <span className="text-xs uppercase tracking-wide text-ink-subtle">
              read as {preview.importerId}
            </span>
            <Button size="sm" disabled={busy || accepted.size === 0} onClick={commit}>
              {busy ? 'Importing…' : `Import ${accepted.size}`}
            </Button>
          </div>

          {preview.warnings.length > 0 && (
            <ul className="border-b bg-underfunded-wash px-6 py-2 text-xs text-ink">
              {preview.warnings.slice(0, 5).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
              {preview.warnings.length > 5 && (
                <li className="text-ink-muted">…and {preview.warnings.length - 5} more like it.</li>
              )}
            </ul>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {preview.rows.map((row) => (
              // biome-ignore lint/a11y/noLabelWithoutControl: the Checkbox inside is the control
              <label
                key={row.importId}
                className={cn(
                  'flex cursor-pointer items-center gap-3 border-b border-hairline/60 px-6 py-1.5 text-sm hover:bg-surface-sunken',
                  row.matchedTransactionId && 'text-ink-muted',
                )}
              >
                <Checkbox
                  checked={accepted.has(row.importId)}
                  onCheckedChange={() => toggle(row.importId)}
                  aria-label={`Import ${row.payeeName ?? row.memo ?? 'transaction'} on ${row.date}`}
                />
                <span className="w-28 tabular-nums text-ink-muted">{row.date}</span>
                <span className="flex-1 truncate">{row.payeeName ?? row.memo ?? '—'}</span>
                {row.matchedTransactionId && (
                  <span className="text-2xs text-ink-subtle">
                    {row.matchReason === 'external-id'
                      ? 'already imported'
                      : 'looks like one you already have'}
                  </span>
                )}
                <Money amount={BigInt(row.amount)} className="w-28 text-right" />
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
