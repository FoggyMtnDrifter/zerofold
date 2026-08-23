'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'

type Theme = 'light' | 'dark' | 'system'
const ORDER: Theme[] = ['system', 'light', 'dark']
const ICON = { system: Monitor, light: Sun, dark: Moon }

/**
 * Three-state theme control.
 *
 * "System" is a real state, not the absence of a choice: it stamps no `data-theme` attribute
 * and lets `prefers-color-scheme` decide, which is why the stylesheet defines dark under both
 * a media query and an explicit attribute.
 */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system')

  useEffect(() => {
    const stored = localStorage.getItem('zerofold-theme') as Theme | null
    if (stored && ORDER.includes(stored)) setTheme(stored)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', theme)
    localStorage.setItem('zerofold-theme', theme)
  }, [theme])

  const Icon = ICON[theme]
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] as Theme

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => setTheme(next)}
      aria-label={`Theme: ${theme}. Switch to ${next}.`}
      title={`Theme: ${theme}`}
    >
      <Icon className="size-4" />
    </Button>
  )
}
