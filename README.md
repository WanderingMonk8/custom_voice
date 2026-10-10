# Chat Voice for Lumiverse

A minimal [Lumiverse Spindle](https://docs.lumiverse.chat/) extension that lets you select a TTS connection and enter a custom voice name for the active chat.

## Features

- Lists all TTS connections configured in Lumiverse.
- Accepts any custom voice name or provider voice ID.
- Applies the selected voice to character speech and narration.
- Applies one consistent voice to every member of a group chat.
- Restores Lumiverse's normal character and global voice fallback when cleared.
- Uses Lumiverse's native themed controls.

## Requirements

- Lumiverse 1.2.5 or newer
- At least one configured TTS connection
- The extension's `chats` permission

## Installation

1. Open **Settings → Extensions → Install** in Lumiverse.
2. Enter `https://github.com/WanderingMonk8/custom_voice.git` as the repository URL.
3. Enable **Chat Voice** and grant the requested `chats` permission.

The compiled frontend and backend bundles are committed under `dist/`, so users do not need Node.js or a local build environment.

## Usage

1. Open a chat.
2. Select **Voice** in the Lumiverse drawer.
3. Choose a TTS connection.
4. Enter the exact custom voice name or ID expected by that provider.
5. Select **Save for this chat**.

To return to the normal Lumiverse voice resolution, clear the TTS connection and save again.

## Development

```sh
npm install
npm run typecheck
npm run build
```

Source files live in `src/`; `npm run build` writes the release bundles to `dist/`.
