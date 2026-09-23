# Recording the README demo

The demo uses invented transcripts for two fictional projects. The normal log
parsers, server, and UI render those transcripts; no personal sessions are copied.

With the project dependencies installed and FFmpeg available on `PATH`, run:

```sh
pnpm run demo:capture
```

On Windows, FFmpeg can be installed with:

```powershell
winget install --id Gyan.FFmpeg --exact --source winget
```

Open a new terminal after installation. `FFMPEG_PATH` may instead point to an
existing FFmpeg executable. FFmpeg is a recording tool and is not shipped with
Agentarium Space.

The command creates three files in the ignored `dist/demo/` directory:

| File | Contents |
|---|---|
| `agentarium-space-demo.mp4` | 24-second silent H.264 video, 1440 × 900, 30 fps |
| `agentarium-space-demo.png` | Still image from the same application view |
| `snapshots.json` | Broadcast session fields used for privacy review |

Both watcher roots and Electron's profile are created in a fresh temporary
directory, which is removed after Electron exits. Offscreen rendering captures
only the application content. Recording begins after layout settles, selects the
forecast session at 12 seconds, and returns to the overview at 18 seconds.

Before publishing, inspect the complete video and still, check their metadata,
and review `snapshots.json`. Internal watcher keys are temporary log paths used
only for identity and layout; they are omitted from this audit file. Upload the
reviewed MP4 as a GitHub attachment and use its URL in both READMEs. Keep the video
out of Git history; the still image belongs in `docs/media/`. Label the media as a
demo with fictional data.
