// import.meta.env is undefined outside Vite (e.g. scripts run under Node), hence the `?.`.
export const OLLAMA_URL: string =
  import.meta.env?.VITE_OLLAMA_URL ?? 'http://localhost:11434'

export const OLLAMA_MODEL: string =
  import.meta.env?.VITE_OLLAMA_MODEL ?? 'qwen3.5:9b'

/** true: the brief reads src/fixtures/scenario-lotr.json. false: live Homebase chat. */
export const MOCK_MODE: boolean = (import.meta.env?.VITE_MOCK_MODE ?? 'true') !== 'false'
