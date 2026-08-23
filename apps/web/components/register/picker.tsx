'use client'

import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface PickerOption {
  readonly id: string
  readonly label: string
  /** Optional heading to group under, e.g. a category group or "Transfer to". */
  readonly group?: string
}

/**
 * A searchable picker — `Command` inside `Popover`, per §7.
 *
 * Typing filters rather than scrolling, which is the difference between a picker that works at
 * twelve categories and one that works at two hundred. The trigger keeps its own width so the
 * register's columns do not shift as a selection changes length.
 */
export function Picker({
  value,
  options,
  label,
  placeholder,
  emptyText = 'Nothing matches.',
  onChange,
  className,
}: {
  value: string | null
  options: readonly PickerOption[]
  /** Names the control for assistive technology. The visible heading above it is not associated
   *  with this button, so without it the control announces only its current value. */
  label: string
  placeholder: string
  emptyText?: string
  onChange: (id: string | null) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = options.find((o) => o.id === value)

  const groups = new Map<string, PickerOption[]>()
  for (const option of options) {
    const key = option.group ?? ''
    const bucket = groups.get(key)
    if (bucket) bucket.push(option)
    else groups.set(key, [option])
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          className={cn(
            'h-8 w-full justify-between px-2 font-normal',
            !selected && 'text-ink-subtle',
            className,
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={placeholder} className="h-9" />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            {[...groups].map(([group, items]) => (
              <CommandGroup key={group} heading={group || undefined}>
                {items.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={`${option.group ?? ''} ${option.label}`}
                    onSelect={() => {
                      // Selecting the current value clears it, so a category can be removed
                      // without hunting for a separate "none" entry.
                      onChange(option.id === value ? null : option.id)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 size-3.5',
                        option.id === value ? 'opacity-100' : 'opacity-0',
                      )}
                      aria-hidden
                    />
                    {option.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
