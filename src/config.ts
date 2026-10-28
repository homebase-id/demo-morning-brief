// import.meta.env is undefined outside Vite (e.g. scripts run under Node), hence the `?.`.
export const OLLAMA_URL: string =
  import.meta.env?.VITE_OLLAMA_URL ?? 'http://localhost:11434'

export const OLLAMA_MODEL: string =
  import.meta.env?.VITE_OLLAMA_MODEL ?? 'qwen3.5:9b'

/** mock: src/fixtures/scenario-lotr.json. live: the signed-in identity's Homebase chat. */
export type DataSource = 'mock' | 'live'

/** The starting source; the header toggle overrides it and remembers the choice. */
export const DATA_SOURCE: DataSource = import.meta.env?.VITE_DATA_SOURCE === 'mock' ? 'mock' : 'live'
