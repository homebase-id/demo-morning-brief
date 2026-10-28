import { useEffect, useRef, useState } from 'react'
import './App.css'
import { FINALIZE_PATH, finalizeLogin, getIdentity, hasCredentials, logout, verifyToken } from './auth/auth'
import { Login } from './auth/Login'
import { BriefPage } from './BriefPage'
import { MOCK_MODE } from './config'

type AuthState = 'checking' | 'anonymous' | 'authenticated' | 'finalizing'

function App() {
  return MOCK_MODE ? <BriefPage /> : <LiveApp />
}

/** Live Homebase chat needs a login first; mock mode skips straight to the brief. */
function LiveApp() {
  const isFinalize = window.location.pathname === FINALIZE_PATH
  const [state, setState] = useState<AuthState>(
    isFinalize ? 'finalizing' : hasCredentials() ? 'checking' : 'anonymous',
  )
  const [error, setError] = useState<string>()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    if (isFinalize) {
      const q = new URLSearchParams(window.location.search)
      const identity = q.get('identity')
      const publicKey = q.get('public_key')
      const salt = q.get('salt')
      const done = (next: AuthState, message?: string) => {
        window.history.replaceState(null, '', '/')
        setError(message)
        setState(next)
      }
      if (!identity || !publicKey || !salt) {
        done('anonymous', 'Login was cancelled or the response was incomplete.')
        return
      }
      finalizeLogin(identity, publicKey, salt)
        .then(() => done('authenticated'))
        .catch((e) => {
          console.error(e)
          done('anonymous', 'Could not finish logging in. Please try again.')
        })
      return
    }

    if (hasCredentials()) {
      // null = identity unreachable; keep the session rather than log out offline.
      verifyToken().then((valid) => setState(valid === false ? 'anonymous' : 'authenticated'))
    }
  }, [isFinalize])

  const onLogout = async () => {
    await logout()
    setState('anonymous')
  }

  return (
    <>
      {state === 'checking' || state === 'finalizing' ? (
        <section className="login">
          <p>{state === 'finalizing' ? 'Finishing login…' : 'Loading…'}</p>
        </section>
      ) : state === 'anonymous' ? (
        <Login error={error} />
      ) : (
        <>
          <section className="login">
            <h1>Morning Brief</h1>
            <p>
              Signed in as <code>{getIdentity()}</code>
            </p>
            <button type="button" className="counter" onClick={onLogout}>
              Log out
            </button>
          </section>
          <BriefPage />
        </>
      )}
    </>
  )
}

export default App
