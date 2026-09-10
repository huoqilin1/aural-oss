# Offline speech route

This is a local integration candidate, not a production acceptance certificate.
The current production release still uses Volcengine speech. No automatic
fallback from offline speech to a paid provider is implemented or allowed.

The validated test configuration uses open-source SenseVoice/Silero recognition
and the installed Windows Huihui offline voice. Windows speech is NOT an
open-source model. It invokes no paid API. Set `OFFLINE_VOICE_TTS_ENGINE=windows`
on the Windows test host. Keep production interviews on Volcengine. A private
SSH reverse forward may connect the server's loopback port5211 to the Windows
sidecar during an authorized test batch. This requires the test host to remain
awake and connected; loss of the tunnel fails the test, never enables paid
fallback. Never use this desktop-dependent setup as an unattended production
speech replacement. Do not expose the sidecar on a public interface.

Cross-check on 2026-09-10: the same ten distinct texts synthesized by Windows
and transcribed by the real offline service all completed and all ten matched
the original text after punctuation normalization. This isolates the major
previous mismatch to the selected TTS path. It does not prove arbitrary ASR
accuracy or replace the ten-interview acceptance gate.

## Routing

The authenticated interview creation API accepts `voiceTest: true` from HR.
It stores `oprunVoiceRoute` with the interview. Tests always select `offline`.
New production interviews use `VOICE_PRODUCTION_PROVIDER` (default `volcengine`).
Existing interviews retain their saved route across browser reconnects and
configuration changes. Interviews created before this feature retain Volcengine.
Database lookup failures stop initialization rather than guess a paid route.
The browser cannot select the provider. Camera/microphone entry is unchanged.

Deploy Aural before enabling the new HR test marker. Keep all production QA
dispatches held until the exact deployed pair and offline service are verified.
Do not turn on the production offline default based on local smoke results.

## Local sidecar

Install `requirements.txt` in an isolated Python environment. Download models
from the sherpa-onnx project's documented release assets, then set
`OFFLINE_VOICE_MODEL_DIR` to their parent directory:

- `sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/`
- `vits-melo-tts-zh_en/` (MeloTTS, with dictionary and lexicon)
- `silero_vad.onnx`

Run `python tools/offline_voice/service.py`. It listens only on
`127.0.0.1:5211`. `/health` checks loaded models; `/tts` accepts JSON `text` and
returns PCM WAV. `/asr` accepts the relay's existing 16kHz mono PCM binary
transport and returns definite speech segments using Silero VAD + SenseVoice.
Inference is CPU-only and does not invoke an external API. The existing server
and electricity/network costs still exist. Model licenses remain separate from
the inference engine license. The experimental Matcha Baker model is excluded
from this service because its included README states non-commercial data use.

Identical TTS requests share an in-flight computation and a bounded 32MiB
in-memory audio cache. There is no disk transcript cache. ASR uses two workers;
TTS uses one worker to limit model memory. Different text still queues: passing
ten identical prompts is not proof that ten different interviews meet latency.

## Evidence on 2026-09-10

Evidence directory:
`D:/GGGG/kiro/oprun-hr-main-wt/.artifacts/offline-voice-pilot/`.

- AISHELL3 first pilot: connected but substantial word errors, rejected.
- MeloTTS three direct synthetic roundtrips: text matched except punctuation;
  longer TTS generation was 3.5-5.8s for 4-7s audio.
- MeloTTS initial ten simultaneous requests: 10 completed, 6 exact normalized
  transcripts; maximum TTS queue+generation 71.2s. Not accepted for rollout.
- Experimental Matcha ten: 10 completed, 7 exact transcripts, maximum TTS5.2s;
  excluded from the release candidate because of the model's stated restriction.
- MeloTTS shared computation: ten requests complete, but a shared synthesis
  pronunciation error is repeated in transcription. Cache does not improve
  accuracy and does not prove distinct-prompt concurrency.

Remaining acceptance: distinct long utterances, numbers, technical vocabulary,
noise, silence, barge-in, abort/disconnect, real browser audio playback and
recording, Linux server memory/CPU, and full ten-resume HR interviews. Preserve
raw failures. Do not claim the ten sidecar requests are ten interview passes.
