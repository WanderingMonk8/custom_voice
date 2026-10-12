# Chat Voice for Lumiverse

A [Lumiverse Spindle](https://docs.lumiverse.chat/) extension that detects character-card speakers and named NPC dialogue, then gives every speaker an individual TTS voice.

## Features

- Reads the active character card only when you click **Scan**; chat history is never sent for cast detection.
- Uses one short language-model request to identify the primary persona and recurring speaking NPCs represented by the card.
- Automatically adds an unambiguous first name as an alias when a card scan returns a full character name.
- Assigns each quoted passage locally during playback using explicit speaker labels, dialogue tags, and the saved card cast.
- Uses one shared TTS connection for the entire chat.
- Assigns a different custom voice name or provider voice ID to every detected character.
- Allows every detected or manually added character to be renamed or deleted. Slash-separated aliases share that character's voice.
- Assigns a separate narrator voice.
- Routes quoted text to the speaking character and text outside quotations to the narrator.
- Carries a confidently identified speaker across same-paragraph narration for later unattributed quotes, unless another roster character is introduced.
- Resolves multi-character paragraphs with confidence-scored main-clause subject detection while discounting objects, passive agents, possessives, and subordinate references.
- Recognizes confidently seeded two-character dialogue chains and alternates otherwise unattributed back-to-back speech turns.
- Routes Lumiverse's native message TTS button through ordered multi-voice playback.
- Overrides the matching native context-menu action instead of adding duplicate playback controls.
- Merges adjacent same-voice passages within each paragraph, splits multi-paragraph passages into smaller requests, and maintains a four-segment rolling playback buffer to avoid gaps and API bursts.
- Paces request starts and automatically honors `Retry-After` when a TTS provider responds with HTTP 429.
- Uses Lumiverse's selected TTS connection, falling back to the profile marked as the default, when a chat has no saved connection.
- Provides a global, opt-in **Save generated audio** setting. It is disabled by default to avoid consuming storage, and retains at most 50 extension recordings by default (user configurable).
- When enabled, saves the exact synthesized custom-voice segments as a native Lumiverse audio attachment for the active message swipe, with a browser-generated WAV fallback when the server cannot mux their source formats.
- When saving is enabled, continues bounded background synthesis and saves the complete recording even when audible playback is stopped early.
- Removes HTML/escaped tags and Markdown emphasis markers before sending readable text to TTS.
- Provides a global, autosaved list of paired tracker tags whose tags and enclosed contents are removed before playback generation.
- Automatically excludes well-formed HTML comments (`<!-- ... -->`) from playback and speaker detection.
- Alternates short unattributed dialogue turns after two speakers have been confidently established, including chains preceded by same-speaker continuation paragraphs.
- Auto-saves every setting to the current chat.
- Saves the detected cast and reloads it with the correct settings whenever the active chat changes.
- Keeps active-chat settings and playback requests isolated between multiple open Lumiverse browser tabs.
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
4. Optionally enter comma-separated paired tags under **Skipped tracker tags**, such as `<tracker></tracker>, <status></status>`. These global exclusions remove both the tags and everything enclosed by them before TTS generation.
5. Choose one TTS connection for the chat.
6. Enter the narrator voice and a voice for each detected character. Add characters manually, or rename and delete any roster entry as needed. Separate aliases with `/` (for example, `Scott / The sergeant`) to route every name to the same voice; use the rename button to add aliases later without losing the assigned voice.
7. Optionally enable **Save generated audio** to attach completed recordings to messages across every chat. This global setting is off by default. Set **Maximum saved recordings** to control global retention (default: 50); the oldest extension-created attachments are removed first.
8. Use Lumiverse's normal **Play with TTS** button or context-menu action to play the message with all configured voices.

The card scan result, manually managed NPC roster, and all voice settings save automatically for that chat. Switching chats loads the previously saved cast and settings without scanning or calling the language model again. Click **Scan** after changing the card. Manual NPCs remain in the roster across later scans until you delete them. Clear a voice field to use the TTS connection's default/fallback voice; clear the connection to disable every custom voice managed by the extension for that chat.

Playback assigns quotes from explicit labels and common dialogue tags. Clear attribution gives the most reliable routing:

```text
The lamps flickered as the door opened.
Alice: "I was wondering when you'd arrive."
Bob: "We should leave before midnight."
```

Only text inside straight or curly quotation marks is treated as character speech. Everything outside quotes uses the narrator voice. While the extension is enabled, Lumiverse's native **Play with TTS** button and matching context-menu action resolve the current output locally and send narration, Alice, and Bob in order through the shared connection. This supports any number of configured cast voices and does not require another language-model request.

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
