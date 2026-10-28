# Morning Brief

A private morning brief built from your Homebase chats. It reads your recent conversations,
finds scheduling **conflicts** and the **promises** you've made, and drafts a reply to each
person. The model runs locally in Ollama, so nothing leaves your machine.

Two data sources, picked from the dropdown in the header:

- **Mock**: a built-in Lord of the Rings scenario (`src/fixtures/scenario-lotr.json`). No
  sign-in needed. Use it as the fallback if the network fails on stage.
- **Live**: the signed-in identity's Homebase chat, last 7 days (at most 60 messages).

## Setup

### 1. Ollama and the model

Install [Ollama](https://ollama.com), then pull the model:

```sh
ollama pull qwen3.5:9b
```

Let the app's address call Ollama, and keep the model in memory for the whole demo:

```sh
launchctl setenv OLLAMA_ORIGINS "https://dev.vidence.co:3444"
launchctl setenv OLLAMA_KEEP_ALIVE -1
```

Quit and reopen the Ollama app so it picks these up.

### 2. The dev host

Homebase won't accept `localhost` as an app's address, so the app runs at
`https://dev.vidence.co:3444`. Check that `/etc/hosts` has:

```
127.0.0.1   dev.vidence.co
```

The HTTPS certificates are read from Guideflow's checkout, at
`../../../northlight/guideflow/ssl/dev.vidence.co{,-key}.pem` relative to this folder. If yours
live elsewhere, change `sslDir` in `vite.config.ts`.

### 3. Install and run

```sh
npm install
npm run dev
```

This opens `https://dev.vidence.co:3444`.

## Running the demo

1. Check the chip at the top of the page says **qwen3.5:9b ready** (green). The page loads the
   model as soon as it opens.
2. Pick **Live** from the header dropdown and sign in with your Homebase identity. The first
   time, Homebase asks you to approve the "Morning Brief" app with read access to your Chat drive.
3. Click **Find conflicts**. The progress list shows each step: reading chats, waiting for the
   model, analyzing your chats (with a live token count), checking.
4. Conflicts appear first as red banners, then one card per person, most urgent first. Open
   **source** on any item to see the messages it's based on.
5. Click **✍️ Draft reply** on a card, or **✍️ Draft all replies**. Drafts follow the conflict
   decisions, can be edited, and have a **Copy** button.
6. Open **Input** at the bottom to show exactly what was sent to the model.

If live chat fails, the error offers **Switch to mock data**; the **Mock / Live** dropdown does
the same at any time.

## Configuration

Optional, in a `.env.local` file:

| Variable | Default | |
|---|---|---|
| `VITE_DATA_SOURCE` | `live` | Starting source, `mock` or `live`. The header dropdown overrides it and remembers your choice. |
| `VITE_OLLAMA_URL` | `http://localhost:11434` | Where Ollama runs. |
| `VITE_OLLAMA_MODEL` | `qwen3.5:9b` | Which model to use. |

## Troubleshooting

| Symptom | Fix |
|---|---|
| Chip says **not reachable** | Ollama isn't running, or `OLLAMA_ORIGINS` doesn't include `https://dev.vidence.co:3444`. Set it, then restart Ollama. |
| First brief is slow | The model was loading. Check `ollama ps` shows UNTIL **Forever**; if not, set `OLLAMA_KEEP_ALIVE` as above. |
| "The app registration is invalid" when approving | The app isn't running at `dev.vidence.co`. Homebase rejects `localhost`. |
| "No chat messages in the last 7 days" | The identity has no recent plain-text chats. Send a few, or switch to Mock. |
| Names show as the first part of the domain, e.g. "Frodo" | That identity's public profile couldn't be read. The brief still works. |
| "Invalid reply" with the model's raw text | The model failed twice. Click **Start over**. |
