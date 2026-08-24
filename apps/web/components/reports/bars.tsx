/**
 * A proportional bar.
 *
 * Deliberately not a chart library. One rectangle whose width is a percentage conveys "this
 * category is twice that one" perfectly well, costs nothing to render, and cannot disagree with
 * the number printed beside it. §7's shadcn Chart earns its place where a chart has axes and a
 * time dimension; a ranked list of totals does not.
 */
export function Bars({ value, max }: { value: number; max: number }) {
  const percentage = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0
  return (
    <span className="h-2 flex-1 overflow-hidden rounded-full bg-hairline" aria-hidden>
      <span className="block h-full rounded-full bg-brand" style={{ width: `${percentage}%` }} />
    </span>
  )
}
