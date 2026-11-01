# Voice input

Voice input inserts text into a composer draft. Mobile confirmation does not submit
an agent turn; desktop's explicit Voice Send action can submit only after the final
transcript commits successfully. Audio is temporary input. Remote transcription sends
it to the recording's GOAT environment, which uses its configured transcription
backend; the client never receives upstream account credentials.

Desktop Variant 2 captures microphone audio with Web Audio, converts the actual
capture sample rate to canonical 24 kHz mono 16-bit little-endian PCM WAV, and uses
the environment's authenticated voice HTTP API. The inline recorder shows a waveform
and temporary transcript previews. Preview work is bounded to one request in flight
and one latest pending clip, and stale responses cannot replace newer text. Confirm
and Voice Send retire previews and transcribe the full recording before committing
once. A changed environment, thread, or provider invalidates outstanding work; a
changed draft revision prevents insertion and Voice Send. Normal submission stays
blocked while voice input is active.

Mobile Variant 3 uses the global session so a recording can finish into its original
draft after navigation. iOS records canonical PCM WAV for both local Apple
transcription and remote fallback. Local transcription wins whenever available;
remote preparation is allowed only when Apple transcription is unavailable or
preparation reports an unavailable device or unsupported locale. Cancellation,
permission denial, asset download failures, and errors during transcription never
trigger a remote upload. Android remains unavailable because its compressed M4A
capture cannot satisfy the WAV contract.

The [shared controller](../../packages/client-runtime/src/voice-input/controller.ts)
owns the operation while the client supplies capture and transcription. Preparation
binds the transcriber and resolved locale for the whole recording. Draft ownership,
text, and revision are captured before recording and checked before insertion, so
a late transcript cannot overwrite a draft that was edited or replaced.

The mobile session also captures the environment, provider instance, working
directory, and thread at start. Navigation does not redirect transcription to the
new screen's environment. Worktree paths take priority over the project directory,
and unsent draft threads have no server thread identifier. The remote transcriber
resolves fresh connection and authentication state for the captured environment on
every request, preserving DPoP renewal, rejected-credential retry, relay route changes,
and hub path prefixes. Availability is checked for the composer's environment, so
an iOS device without local Apple transcription can still use a connected server.

The [remote transcriber](../../packages/client-runtime/src/voice-input/remoteTranscription.ts)
uses `/api/voice/prewarm` as a nonfatal preparation hint and `/api/voice/transcribe`
for WAV uploads. Both require the environment's operate scope. The server checks
streaming request limits before JSON parsing and validates WAV headers, frame
alignment, and duration before contacting an upstream backend. OpenCodex is the
first route when configured, using its admission key; a missing key or refused
connection permits fallback to the selected Codex instance's ChatGPT session.
An OpenCodex authentication rejection fails without switching accounts. ChatGPT
401/403 responses permit one refresh of the same account, and upstream response
streams are bounded. See the [voice contract](../../packages/contracts/src/voice.ts)
for wire limits and error codes.

Cancellation invalidates a result immediately, but resources stay owned until the
underlying work settles. Apple's native transcription call cannot be interrupted
once started. Releasing the session or deleting its recording when the abort signal
fires would race that work. The [transcription contract](../../packages/client-runtime/src/voice-input/transcription.ts)
therefore requires implementations to settle only after their work has stopped;
the [Apple binding](../../apps/mobile/src/native/voiceTranscription.ios.ts) checks
cancellation between native calls and discards late results.
