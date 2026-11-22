# Update notes — 3.34.1

**Released against 3.34.0.** Speaker-assignment fixes only; no settings or UI changes.

## Headline changes

- **Unnamed speakers keep their own sex.** The nearest narration paragraph that is about exactly one person now decides that person's sex, however the paragraph refers to them — instead of a growing list of per-phrase special cases.
- **Possessive descriptions count.** "The boy's head snaps upright" or "the girl's voice cracks" anchors an unnamed speaker's sex like a direct noun does, so an unnamed boy is no longer offered only female voices.
- **Introductions with modifiers count.** "a middle-aged man in a pressed windbreaker" is now read as one noun phrase; the old rule only recognised a bare "a man" at the start of a paragraph.
- **A cast name in the same paragraph no longer erases the introduction.** In "The store manager—a middle-aged man … steps behind the counter. Aiko steps aside", only the pronouns defer to the named character now, so the manager keeps his own sex and voice shortlist.
- **A known speaker's delivery stays with that speaker.** "Her voice is flat, sanded down to its exact retail register" after Aiko's quotation describes Aiko, not whoever speaks next.
- **Speech-tag-only paragraphs are skipped.** A paragraph that only tags the current quotation ("she says, her voice dropping…") no longer lends its pronoun class to the next new character.
- **Mixed-gender paragraphs abstain.** A paragraph that mentions both sexes describes more than one person, so it carries no evidence either way.
- **No more phantom unnamed speaker.** In a single-character scene, an uncertain line can no longer be guessed as a "distinct unnamed person" when the narration describes nobody unnamed and the turn chain already points at the known character. This used to add the connection-default voice as a third voice in a two-person conversation.
- **Clearer diagnostics.** The debug trace now says when an uncast guess was overruled and the chain answer kept.

## Notes for upgraders

- Nothing to configure or migrate; no settings changed.
- Existing chats are unaffected until their messages are re-parsed; regenerate audio on a message to apply the new assignment.
