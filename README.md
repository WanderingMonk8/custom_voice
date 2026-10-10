# Chat Voice for Lumiverse

A [Lumiverse Spindle](https://docs.lumiverse.chat/) extension that detects character-card speakers and named NPC dialogue, then gives every speaker an individual TTS voice.

## Features

- Reads the active character card only when you click **Scan**; chat history is never sent for cast detection.
- Uses one short language-model request to identify the primary persona and recurring speaking NPCs represented by the card.
- Assigns each quoted passage locally during playback using explicit speaker labels, dialogue tags, and the saved card cast.
- Uses one shared TTS connection for the entire chat.
- Assigns a different custom voice name or provider voice ID to every detected character.
- Allows unlimited manually added NPCs, each with its own voice and delete control.
- Assigns a separate narrator voice.
- Routes quoted text to the speaking character and text outside quotations to the narrator.
- Adds a custom music-note action to each message for ordered multi-voice playback.
- Auto-saves every setting to the current chat.
- Saves the detected cast and reloads it with the correct settings whenever the active chat changes.
- Never scans automatically when a chat loads, changes, or receives new messages.
- Uses Lumiverse's native themed controls.

## Requirements

- Lumiverse 1.2.5 or newer
- At least one configured TTS connection
- An active language-model connection for AI-assisted speaker detection
- The extension's `chats`, `chat_mutation`, `characters`, and `generation` permissions

## Installation

1. Open **Settings → Extensions → Install** in Lumiverse.
2. Enter `https://github.com/WanderingMonk8/custom_voice.git` as the repository URL.
3. Enable **Chat Voice** and grant all four requested permissions.

The compiled frontend and backend bundles are committed under `dist/`, so users do not need Node.js or a local build environment.

## Usage

1. Open a chat.
2. Select **Voice** in the Lumiverse drawer.
3. Click **Scan** to read the active character card and save its speaking cast.
4. Choose one TTS connection for the chat.
5. Enter the narrator voice and a voice for each detected character. Add or delete NPCs manually as needed.
6. Use the **♫** action on a character message to play it with all configured voices.

The card scan result, manually managed NPC roster, and all voice settings save automatically for that chat. Switching chats loads the previously saved cast and settings without scanning or calling the language model again. Click **Scan** after changing the card. Manual NPCs remain in the roster across later scans until you delete them. Clear a voice field to use the TTS connection's default/fallback voice; clear the connection to disable every custom voice managed by the extension for that chat.

Playback assigns quotes from explicit labels and common dialogue tags. Clear attribution gives the most reliable routing:

```text
The lamps flickered as the door opened.
Alice: "I was wondering when you'd arrive."
Bob: "We should leave before midnight."
```

Only text inside straight or curly quotation marks is treated as character speech. Everything outside quotes uses the narrator voice. The extension-owned **♫** action resolves the current output locally and sends narration, Alice, and Bob in order through the shared connection. This supports any number of configured cast voices and does not require another language-model request. Lumiverse's native TTS action still has its native two-voice-per-message behavior, so use **♫** when a message contains multiple same-card NPCs.

AI parsing happens only when **Scan** is clicked and only receives card fields such as description, scenario, greeting, and example dialogue. Model output is validated before it is saved; if parsing is unavailable, the primary card character remains available as a fallback.

Chat Voice configures Lumiverse's speech detection so quoted text is classified as character speech and both asterisked and undecorated text are classified as narration. Other Voice & Speech preferences are preserved.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Source files live in `src/`; `npm run build` writes the release bundles to `dist/`.
