'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { rpc } from '@/lib/rpc'

export function NewPlanForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  /**
   * The browser's timezone is offered as the default because it is almost always right, but it
   * is stored on the plan rather than read per request — "today" has exactly one definition
   * and it belongs to the plan, not to whichever device is looking at it (ADR-0005).
   */
  const guessedZone = Intl.DateTimeFormat().resolvedOptions().timeZone

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const result = await rpc('plan.create', {
      name: String(form.get('name')),
      timezone: String(form.get('timezone')),
    })
    setBusy(false)
    if ('error' in result) {
      setError(result.error.message)
      return
    }
    router.push(`/plans/${(result.data as { planId: string }).planId}`)
    router.refresh()
  }

  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle asChild>
            {/* A real heading: shadcn's CardTitle is a div, and a page whose entire
                content is one card would otherwise have no heading at all for a
                screen reader to navigate by. */}
            <h1>Create your first plan</h1>
          </CardTitle>
          <CardDescription>
            A plan is one budget — its accounts, categories and history.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" defaultValue="Household" required />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="timezone">Time zone</Label>
              <Input id="timezone" name="timezone" defaultValue={guessedZone} required />
              <p className="text-2xs text-ink-subtle">
                Decides which day a transaction belongs to, and therefore which month it budgets
                against.
              </p>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create plan'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
