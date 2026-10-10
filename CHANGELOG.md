# Changelog

All notable changes to this package. It follows [semantic versioning](https://semver.org);
while on 0.x, a breaking change bumps the minor version.

## 0.1.0

First release.

- Connections for Chrome extensions (Manifest V3): Anthropic API keys, Claude
  Pro/Max sign-in and setup tokens; ChatGPT sign-in (Codex backend); Ollama
  Cloud device keys; any OpenAI-compatible server (OpenAI, OpenRouter, local
  Ollama, LM Studio).
- Keys and tokens encrypted at rest with a non-extractable key, used only in
  the background worker; UI surfaces see redacted connections.
- `chat()`: one model turn with native tool calling, streamed and validated to
  the provider's terminal event, with images and PDF documents.
- `complete()` for one-shot text, and `listModels()` per connection (the Codex
  catalog for ChatGPT).
- Network errors marked `retryable` when sending again is safe.
- One message-passing API between UI and worker, carrying
  `PROTOCOL_VERSION`.
- Public API recorded in `api/*.api.md` and checked in CI.
- A demo extension in `example/demo`.
