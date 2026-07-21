# Repo notes

Settings to apply when the repository is created on GitHub. Not part of the
project itself.

## Description

> Ask a question out loud on your Galaxy Watch and a server on your own machine answers. Wear OS app plus a pluggable Node backend, including headless Claude Code at $0 in API cost.

That is 214 characters. GitHub allows 350.

Shorter, if the above feels long:

> Talk to your Galaxy Watch, get an answer from an LLM running on your own machine.

## Topics

```
wear-os
galaxy-watch
smartwatch
kotlin
android
speech-recognition
text-to-speech
voice-assistant
llm
claude
claude-code
nodejs
self-hosted
```

## Settings

- **Website:** leave empty for now.
- **Issues:** on.
- **Discussions:** off until there is traffic to justify it.
- **Wiki:** off. The README is the documentation.
- **Projects:** off.
- **Social preview image:** `docs/architecture.svg` rendered to PNG at 1280x640
  works. A photo of the watch mid-answer works better.

## Before making it public

- [ ] `server/.env` and `watch/local.properties` are absent from the working
      tree and from the history. Both are gitignored. Verify with
      `git log --all --name-only | sort -u | grep -E "\.env|local\.properties$"`.
- [ ] History is the single initial commit and carries nothing from the private
      project it grew out of.
- [ ] The only IP addresses in the tree are `192.0.2.x` (RFC 5737
      documentation range) and loopback.
- [ ] No absolute paths from a real machine, no usernames.

## Release checklist for later

- A demo recording is worth more than any amount of README. Fifteen seconds of
  a wrist, a spoken question and a spoken answer.
- Screenshot of the three pulse states side by side.
