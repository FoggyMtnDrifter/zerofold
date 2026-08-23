import { RegisterHarness } from './harness'

/**
 * A development harness for the register.
 *
 * Renders 50,000 generated rows so the virtualiser and the render half of the §6 budget can be
 * measured against the same volume the query benchmark uses. Not linked from anywhere and not
 * part of the product; it exists so the performance claim is something observed rather than
 * asserted.
 */
export default function DevRegisterPage() {
  return <RegisterHarness count={50_000} />
}
