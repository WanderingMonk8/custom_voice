# Chat Voice for Lumiverse

A [Lumiverse Spindle](https://docs.lumiverse.chat/) extension that detects the characters speaking in recent chat messages and gives each one an individual TTS voice.

## Features

- Scans a configurable number of recent character messages (20 by default, 1–500) only when you click **Scan**; user messages do not count toward the limit.
- Detects participating characters from the active chat's actual message speakers.
- Uses one shared TTS connection for the entire chat.
- Assigns a different custom voice name or provider voice ID to every detected character.
- Assigns a separate narrator voice.
- Routes quoted text to the speaking character and text outside quotations to the narrator.
- Auto-saves every setting to the current chat.
- Saves the detected cast and reloads it with the correct settings whenever the active chat changes.
- Never scans message history automatically when a chat loads, changes, or receives new messages.
- Uses Lumiverse's native themed controls.

## Requirements

- Lumiverse 1.2.5 or newer
- At least one configured TTS connection
- The extension's `chats`, `chat_mutation`, and `characters` permissions

## Installation

1. Open **Settings → Extensions → Install** in Lumiverse.
2. Enter `https://github.com/WanderingMonk8/custom_voice.git` as the repository URL.
3. Enable **Chat Voice** and grant all three requested permissions.

The compiled frontend and backend bundles are committed under `dist/`, so users do not need Node.js or a local build environment.

## Usage

1. Open a chat.
2. Select **Voice** in the Lumiverse drawer.
3. Choose the number of recent messages to scan and click **Scan**.
4. Choose one TTS connection for the chat.
5. Enter the narrator voice and a voice for each detected character.

The scan result and all voice settings save automatically for that chat. Switching chats loads the previously saved cast and settings without scanning messages again. Click **Scan** whenever you want to update the detected cast. Clear a voice field to let that speaker fall back to Lumiverse's normal voice resolution; clear the connection to disable every custom voice managed by the extension for that chat.

Chat Voice configures Lumiverse's speech detection so quoted text is classified as character speech and both asterisked and undecorated text are classified as narration. Other Voice & Speech preferences are preserved.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Source files live in `src/`; `npm run build` writes the release bundles to `dist/`.
