/**
 * Host half of the voice-live bundle.
 *
 * M1 keeps the whole loop in the browser: the Client half records, asks the
 * Host's existing speech service for a transcript, prompts the current Session,
 * and speaks the reply through a local Qwen3-TTS server. No Host route, no
 * extra RPC surface, nothing to secure.
 */
export function apply() {}
