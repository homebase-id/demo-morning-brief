import { useEffect, useRef, useState } from 'react'
import './App.css'
import { FINALIZE_PATH, finalizeLogin, getIdentity, hasCredentials, logout, verifyToken } from './auth/auth'
import { Login } from './auth/Login'
import { BriefPage } from './BriefPage'
import { DATA_SOURCE, type DataSource } from './config'
import { displayName } from './scenario'

type AuthState = 'checking' | 'anonymous' | 'authenticated' | 'finalizing'

const SOURCE_KEY = 'morning-brief:data-source'

const initialSource = (): DataSource => {
  // Coming back from the Homebase sign-in only makes sense in live mode.
  if (window.location.pathname === FINALIZE_PATH) return 'live'
  const saved = localStorage.getItem(SOURCE_KEY)
  return saved === 'mock' || saved === 'live' ? saved : DATA_SOURCE
}

/** Homebase sign-in state: finishes a YouAuth return, otherwise checks the stored token. */
function useHomebaseAuth() {
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

  const signOut = async () => {
    await logout()
    setState('anonymous')
  }

  return { state, error, signOut, needSignIn: () => setState('anonymous') }
}

function SourceToggle({ source, onChange }: { source: DataSource; onChange: (s: DataSource) => void }) {
  return (
    <div className="source-toggle" role="group" aria-label="Data source">
      {(['mock', 'live'] as const).map((s) => (
        <button key={s} type="button" aria-pressed={source === s} onClick={() => onChange(s)}>
          {s === 'mock' ? 'Mock' : 'Live'}
        </button>
      ))}
    </div>
  )
}

/** Avatar + display name of the signed-in identity, from its public profile. */
function IdentityBadge({ odinId, onSignOut }: { odinId: string; onSignOut: () => void }) {
  const [name, setName] = useState(odinId)
  const [avatarFailed, setAvatarFailed] = useState(false)

  useEffect(() => {
    displayName(odinId).then(setName)
  }, [odinId])

  return (
    <div className="identity">
      {avatarFailed ? (
        <span className="avatar avatar-initial" aria-hidden>
          {name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <img className="avatar" src={`https://${odinId}/pub/image`} alt="" onError={() => setAvatarFailed(true)} />
      )}
      <span className="identity-text">
        <span className="identity-name">{name}</span>
        <span className="identity-id">{odinId}</span>
      </span>
      <button type="button" className="sign-out" onClick={onSignOut}>
        Sign out
      </button>
    </div>
  )
}

function App() {
  const [source, setSource] = useState<DataSource>(initialSource)
  const auth = useHomebaseAuth()
  const identity = auth.state === 'authenticated' ? getIdentity() : undefined

  const choose = (s: DataSource) => {
    localStorage.setItem(SOURCE_KEY, s)
    setSource(s)
  }

  const live = () => {
    if (auth.state === 'checking' || auth.state === 'finalizing')
      return (
        <section className="login">
          <p>{auth.state === 'finalizing' ? 'Finishing login…' : 'Loading…'}</p>
        </section>
      )
    if (auth.state === 'anonymous') return <Login error={auth.error} />
    return (
      <BriefPage key="live" source="live" onSwitchToMock={() => choose('mock')} onNeedSignIn={auth.needSignIn} />
    )
  }

  return (
    <>
      <header className="app-header">
        <div className="header-left">
          <strong className="app-title">Morning Brief</strong>
          <SourceToggle source={source} onChange={choose} />
        </div>
        {identity && <IdentityBadge odinId={identity} onSignOut={auth.signOut} />}
      </header>
      {source === 'mock' ? <BriefPage key="mock" source="mock" /> : live()}
    </>
  )
}

export default App
