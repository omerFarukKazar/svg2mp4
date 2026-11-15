# svg2mp4

Render an animated SVG to a video. CSS animations and SMIL both move in the output.

Most converters hand an SVG to a still-image renderer, so the MP4 they give back is one frozen
frame. This one opens the SVG in Chrome, sets its clock to the exact moment of each frame and
takes a screenshot. Nothing plays in real time, so the video is smooth however slow the machine
is, and the same input always gives the same file.

One file, no npm packages.

## Requirements

- Node 22 or later
- Chrome or Chromium
- ffmpeg

## Use

```bash
node svg2mp4.mjs in.svg out.mp4 --duration 24
```

The output format follows the file name: `.mp4`, `.mov`, `.webm` or `.gif`.

Try it on the example in this repository:

```bash
node svg2mp4.mjs examples/fireside.svg fireside.mp4 --duration 24
```

## Options

| Option | What it does | Default |
| --- | --- | --- |
| `--duration <s>` | Length of the video in seconds | `20` |
| `--start <s>` | Where on the SVG's own clock the video begins | `0` |
| `--fps <n>` | Frames per second | `30` |
| `--preset <name>` | `1080p`, `720p`, `4k`, `square`, `portrait` or `vertical` | none |
| `--width <px>` | Output width | the viewBox width |
| `--height <px>` | Output height | the viewBox height |
| `--scale <n>` | Draw the same picture n times larger, for example `2` | `1` |
| `--fit <mode>` | What to do when the output is not the SVG's shape, see below | `auto` |
| `--background <color>` | Color behind the SVG, any CSS color | `#000` |
| `--crf <n>` | Encoder quality, lower is better | `18` |
| `--lossless` | Pass PNG frames to the encoder instead of JPEG (slower) | off |
| `--jobs <n>` | Browsers drawing at once | half the cores, at most 4 |

A width or height given alone keeps the SVG's shape. Either one wins over a preset.

Set `CHROME` or `FFMPEG` to use a binary that is not on the usual path.

### Fit modes

| Mode | Result |
| --- | --- |
| `auto` | As the SVG's own `preserveAspectRatio` asks |
| `cover` | Fill the frame and crop the overflow |
| `contain` | Show all of it, with bars in the background color |
| `blur` | Show all of it over a blurred copy of itself |

A wide picture for a vertical feed:

```bash
node svg2mp4.mjs in.svg out.mp4 --preset vertical --fit blur
```

### Presets

| Name | Size |
| --- | --- |
| `1080p` | 1920x1080 |
| `720p` | 1280x720 |
| `4k` | 3840x2160 |
| `square` | 1080x1080 |
| `portrait` | 1080x1350 |
| `vertical` | 1080x1920 |

## Speed

Frames are independent, so several browsers draw at once. A 24 second, 1600x1000, 30 fps render
of the example (720 frames) on a 10-core Mac:

| `--jobs` | Time |
| --- | --- |
| 1 | 77 s |
| 4 | 20 s |

Both runs give a byte-identical file.

## Limits

- An SVG moved by JavaScript is not supported. Only CSS and SMIL have a clock that can be set.
- No audio.
- Fonts come from the machine doing the render. Embed the font, or turn text into paths, if the
  result has to look the same everywhere.

## Tests

```bash
node --test
```

The tests render a small SVG and check that the CSS and SMIL parts are at the right pixel in the
right frame. They need Chrome and ffmpeg, the same as the tool.

## License

MIT
