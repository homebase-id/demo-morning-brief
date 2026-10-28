import { useState, type FormEvent } from 'react'
import { appDefinition } from './appDefinition'
import { getIdentity, login } from './auth'

export function Login({ error }: { error?: string }) {
  const [odinId, setOdinId] = useState(getIdentity() ?? '')
  const [busy, setBusy] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await login(odinId)
    } catch (err) {
      console.error(err)
      setBusy(false)
    }
  }

  return (
    <section className="login">
      <h1>{appDefinition.name}</h1>
      <p>Sign in with your Homebase identity. Morning Brief asks for read access to your Chat drive.</p>
      {error && <p className="login-error">{error}</p>}
      <form onSubmit={onSubmit}>
        <input
          type="text"
          placeholder="you.homebase.id"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={odinId}
          onChange={(e) => setOdinId(e.target.value)}
        />
        <button type="submit" className="counter" disabled={busy || !odinId.trim()}>
          {busy ? 'Redirecting…' : 'Log in with Homebase'}
        </button>
      </form>
    </section>
  )
}
