## What this changes

<!-- One or two sentences. -->

## Why

<!-- What problem does it solve? Link an issue if there is one. -->

## Testing

<!-- How did you verify it? For anything touching the audio path, include numbers. -->

- [ ] `npm run typecheck`
- [ ] `dotnet build native/AudioTap/AudioTap.csproj -c Release -warnaserror` (if AudioTap changed)
- [ ] `dotnet build desktop/BridgeApp/BridgeApp.csproj -c Release -warnaserror` (if the app changed)
- [ ] Streamed to a real voice channel and listened to it

## Audio path

<!-- Delete this section if you did not touch capture, encoding, or pacing. -->

- What did you measure, and how?
- Does `/status` still show a stable jitter buffer with no overruns after a few minutes?
- Does the stream survive pausing and resuming the source app?
