# Synthetic video fixture

`synthetic.mp4` is a programmatically generated four-second FFmpeg `testsrc2`
pattern with a sine tone (720×1280, H.264, 24fps, AAC 48kHz). It contains no project
artwork or user media and is **not** an AgnesAI-generated video.

Equivalent command with a local FFmpeg installation:

```text
ffmpeg -f lavfi -i testsrc2=size=720x1280:rate=24 -f lavfi -i sine=frequency=440:sample_rate=48000 -t 4 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest synthetic.mp4
```

Encoder versions can produce different bytes; tests assert decoded behavior, not
one specific fixture hash.
