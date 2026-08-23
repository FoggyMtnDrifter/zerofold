import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Zerofold',
  description: 'Self-hosted zero-based envelope budgeting.',
}

/**
 * Applies the stored theme before first paint.
 *
 * Without this the page renders in the default theme and then snaps to the chosen one — the
 * flash is brief, bright, and exactly the sort of unpolished detail that makes software feel
 * cheap. It has to be inline and synchronous, because anything deferred is already too late.
 */
const THEME_SCRIPT = `try{var t=localStorage.getItem('zerofold-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: a fixed literal, no interpolation */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  )
}
