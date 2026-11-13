# Update notes — 3.34.0

**Released against 3.33.0.** Visual surface change only; reduction behavior itself is unchanged.

## Headline changes

### 1. Reduction components are no longer re-configurable from the Advanced panel
The per-component **Token reduction** toggles are removed. All reduction components remain fully enabled (the shipped default) and are still honored in the global voice settings (`chatVoiceReductionComponents`) for gated internal observation — they just aren't a user-facing control anymore. The previous comparison/report tooling is similarly gone (already retired in 3.32.0).

### 2. Notes for upgraders
- If you previously disabled a component in the Advanced section, your setting persists under the global key but no longer has UI; resetting that key reverts to the default (all-on).
- TTS tag style: nothing to configure. If you notice a regression, the underlying global keys are the fallback (`chatVoiceSpeakerAssignmentDebug`, other `chatVoice*` settings).
