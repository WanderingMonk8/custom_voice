# Chat Voice for Lumiverse

A [Lumiverse Spindle](https://docs.lumiverse.chat/) extension that detects character-card speakers and named NPC dialogue, then gives every speaker an individual TTS voice.

## Features

- Reads the active character card only when you click **Scan**; chat history is never sent for cast detection.
- Uses one short language-model request to identify the primary persona and recurring speaking NPCs represented by the card.
- Automatically adds an unambiguous first name as an alias when a card scan returns a full character name.
- Uses Jev through Lumiverse Decisions to classify paragraph and quotation identities, then applies deterministic inheritance and fallback policy.
- Uses one shared TTS connection for the entire chat.
- Assigns a different custom voice name or provider voice ID to every detected character.
- Allows every detected or manually added character to be renamed or deleted. Slash-separated aliases share that character's voice.
- Assigns a separate narrator voice.
- Routes quoted text to the speaking character and text outside quotations to the narrator.
- Carries a confidently identified speaker across same-paragraph narration for later unattributed quotes, unless another roster character is introduced.
- Resolves multi-character paragraphs with confidence-scored main-clause subject detection while discounting objects, passive agents, possessives, and subordinate references.
- Recognizes confidently seeded two-character dialogue chains and alternates otherwise unattributed back-to-back speech turns.
- When quotations lack a coherent current identity, locally uses the immediately preceding assistant speaker to resolve identity-free or conflicting narrative candidates; explicit current attribution and conflicting pronoun speakers disable this fallback.
- Routes Lumiverse's native message TTS button through ordered multi-voice playback.
- Overrides the matching native context-menu action instead of adding duplicate playback controls.
- Splits playback into paragraph-sized TTS requests, further divides paragraphs longer than 360 characters at sentence, clause, or word boundaries, and dynamically adjusts generation concurrency from median length and short-segment density to reduce gaps without bursting short requests.
- Adds up to two leading emotion cues to Gemini and Fish S2 speeches, plus up to two thresholded sound cues and two pause cues. Emotion is placed deterministically at the start; all sound and pause placement for a speech is grouped into one chunked LLM request. Fish S2 additionally supports a sustained voice style, a custom context-aware emotion cue refined by the placement LLM, and, with LLM exact placement, one mid-speech modulation refined by the placement LLM. Fish repeats the leading or active modulation cue at each sentence start to respect S2's sentence-level tag scoping. Gemini 3.8 uses its documented angle-bracket vocal events and pauses, without inline emotion or style because those require the separate `speech_metadata` field. Tags are injected only into the speech sent to TTS, never into the message.
- Paces request starts and automatically pauses and resumes unfinished generation when a TTS provider responds with HTTP 429. It honors `Retry-After`, keeps completed segments, and uses a configurable cumulative rate-limit wait budget.
- Automatically balances differing TTS voice levels with silence-gated RMS analysis, a rolling profile for each voice, ±6 dB gain limits, and a -1 dBFS peak ceiling.
- Uses Lumiverse's selected TTS connection, falling back to the profile marked as the default, when a chat has no saved connection.
- Provides a global, opt-in **Save generated audio** setting. It is disabled by default to avoid consuming storage, and retains at most 50 extension recordings by default (user configurable).
- When enabled, saves the exact synthesized custom-voice segments as a native Lumiverse audio attachment for the active message swipe, with a browser-generated WAV fallback when the server cannot mux their source formats.
- When saving is enabled, continues bounded background synthesis and saves the complete recording even when audible playback is stopped early.
- Removes HTML/escaped tags and Markdown emphasis markers before sending readable text to TTS.
- Provides a global, autosaved list of tracker tag names or full asymmetric tag pairs whose tags and enclosed contents are removed before playback generation.
- Automatically excludes well-formed HTML comments (`<!-- ... -->`) from playback and speaker detection.
- Alternates short unattributed dialogue turns after two speakers have been confidently established, including chains preceded by same-speaker continuation paragraphs.
- Optionally reviews ambiguous—or all—dialogue with an LLM, using a selectable Lumiverse connection and an optional searchable model override drawn from that connection's available models. Results are cached per message and safely fall back to local parsing.
- Auto-saves every setting to the current chat.
- Saves the detected cast and reloads it with the correct settings whenever the active chat changes.
- Keeps active-chat settings and playback requests isolated between multiple open Lumiverse browser tabs.
- Never scans automatically when a chat loads, changes, or receives new messages.
- Uses Lumiverse's native themed controls.

## Requirements

- Lumiverse 1.2.5 or newer
- At least one configured TTS connection
- A default Lumiverse Decision model connection for Jev speaker assignment
- The extension's `chats`, `chat_mutation`, `characters`, `generation`, and `decisions` permissions

## Installation

1. Open **Settings → Extensions → Install** in Lumiverse.
2. Enter `https://github.com/WanderingMonk8/custom_voice.git` as the repository URL.
3. Enable **Chat Voice** and grant all requested permissions.

The compiled frontend and backend bundles are committed under `dist/`, so users do not need Node.js or a local build environment.

## Usage

1. Open a chat.
2. Select **Voice** in the Lumiverse drawer.
3. Click **Scan** to read the active character card and save its speaking cast.
4. Optionally enter comma-separated tag names under **Skipped tracker tags**, such as `tracker, status, o_scene`. For asymmetric tags, enter the full pair, such as `<o_ledger></o_l>`. These global exclusions remove both the opening/closing tags and everything enclosed by them before TTS generation. Previously saved paired-tag entries remain compatible.
5. Global **Jev speaker assignment** defaults to **On** and uses the account's default Lumiverse Decision connection. Switch it off to use only the local parser. The On option is available only when Lumiverse has at least one Decision model connection; without one it stays Off.
6. Optionally enable **TTS vocal tags** and choose **Gemini**, **Gemini 3.8**, or **Fish S2**. Gemini and Fish S2 give every quoted speech one leading emotion from the 24 basic emotions, with a weak winner falling back to `calm`, plus an optional second emotion; Jev may add up to two sounds and two short/long pauses above strict strength thresholds. Fish S2 also selects an optional sustained voice style, uses S2 pause/sound forms, asks the placement LLM for a custom context-aware leading emotion cue of fewer than 10 words, and repeats the leading cues at each sentence start so the delivery persists through multi-sentence speeches. With **LLM exact placement**, Fish S2 can also select one mid-speech modulation and ask the placement LLM for a short free-form remainder emotion; that cue persists to the end of the speech and is shown in diagnostics. The fixed Jev emotion remains the fallback if the custom leading cue is invalid. Existing cues using any of the 49 Fish emotions are preserved. Legacy Gemini and Fish S2 use square brackets, for example `[happy]`, `[gasp]`, `[short pause]`, and `[long pause]`; legacy Gemini keeps its existing `[break]` / `[long-break]` pause forms. Gemini 3.8 uses angle brackets, for example `<sigh>`, `<gasp>`, `<short pause>`, and `<long pause>`, and omits inline emotion/style because those need the separate `speech_metadata` field that the current TTS request does not expose. Choose **LLM exact placement** to place all of a speech’s sounds and pauses together at the exact words; otherwise Jev uses sentence boundaries. The fixed leading emotion never needs the placement LLM; the Fish custom leading and modulation cues do. Placement is resolved in small chunks while playback proceeds.
7. Choose one TTS connection for the chat.
8. Enter the narrator voice and a voice for each detected character. Add characters manually, or rename and delete any roster entry as needed. Separate aliases with `/` (for example, `Scott / The sergeant`) to route every name to the same voice; use the rename button to add aliases later without losing the assigned voice.
9. Optionally enable **Save generated audio** to attach completed recordings to messages across every chat. This global setting is off by default. Set **Maximum saved recordings** to control global retention (default: 50); the oldest extension-created attachments are removed first.
10. Use Lumiverse's normal **Play with TTS** button or context-menu action to play the message with all configured voices.

The collapsed **Advanced settings** section at the bottom of the drawer controls how many synthesized segments are buffered before playback starts (default: 2), the maximum generation concurrency (default: 4), and the cumulative rate-limit wait budget in seconds (default: 60, maximum: 3600). Every message starts at concurrency 1. A six-segment window keeps concurrency at 1 when it contains at least three short segments or has a short median, and only increases toward the configured maximum after two consecutive all-long windows. Any HTTP 429 keeps the rest of that message at concurrency 1. A longer wait budget lets interrupted generation keep retrying for longer. Voice-volume normalization is always active. Normalized saved recordings use assembled PCM WAV audio and may consume more storage.

The card scan result, manually managed NPC roster, and all voice settings save automatically for that chat. Switching chats loads the previously saved cast and settings without scanning or calling the language model again. Click **Scan** after changing the card. Manual NPCs remain in the roster across later scans until you delete them. Clear a voice field to use the TTS connection's default/fallback voice; clear the connection to disable every custom voice managed by the extension for that chat.

Playback assigns quotes from explicit labels and common dialogue tags. Clear attribution gives the most reliable routing:

```text
The lamps flickered as the door opened.
Alice: "I was wondering when you'd arrive."
Bob: "We should leave before midnight."
```

Only text inside straight or curly quotation marks is treated as character speech. Everything outside quotes uses the narrator voice. While the extension is enabled, Lumiverse's native **Play with TTS** button and matching context-menu action send narration, Alice, and Bob in order through the shared connection. This supports any number of configured cast voices. With Jev speaker assignment off, attribution is entirely local. When it is on, one cached Lumiverse Decision request classifies the message before the extension applies its speaker-resolution rules. That request also scores each quotation against the previous one as a continuation or a response; a deterministic chain decode combines those scores with the narration around each quote. An ambiguous cross-paragraph dialogue run may trigger one additional discourse-level request before those rules run.

Card-cast AI parsing happens only when **Scan** is clicked and receives card fields such as description, scenario, greeting, and example dialogue. Jev receives the cleaned current message as numbered paragraphs and quotations plus the saved roster. It can identify a known speaker, an uncast character, or no clear identity; confidence gates and deterministic policy decide the final route. When a message never names its speaker, a unique card match still owns the dialogue unless a speech identity clears the card-block confidence thresholds or the text explicitly introduces an anonymous role such as “the clerk,” an indefinite person such as “an older woman,” or an unnamed second speaker. Missing Decision capability, errors, low-confidence answers, and oversized requests fall back safely to deterministic parsing.

Chat Voice configures Lumiverse's speech detection so quoted text is classified as character speech and both asterisked and undecorated text are classified as narration. Other Voice & Speech preferences are preserved.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```

Source files live in `src/`; `npm run build` writes the release bundles to `dist/`.
