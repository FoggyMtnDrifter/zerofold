'use client'

import { Plus } from 'lucide-react'
import { useState } from 'react'
import { AddAccountForm } from '@/app/plans/[planId]/add-account-form'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '@/components/ui/dialog'

/**
 * Adding an account, from the sidebar the accounts are listed in.
 *
 * It lived on the plan page until the budget took that screen over. The sidebar is where it
 * belongs anyway: next to the list it adds to, reachable from anywhere in the plan.
 */
export function AddAccountDialog({ planId }: { planId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-full justify-start gap-1.5 text-ink-muted"
        >
          <Plus className="size-3.5" aria-hidden />
          Add account
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle className="sr-only">Add an account</DialogTitle>
        <AddAccountForm planId={planId} onCreated={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  )
}
