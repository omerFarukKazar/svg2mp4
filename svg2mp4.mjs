#!/usr/bin/env node
// Render an animated SVG (CSS animations and SMIL) to a video, frame by frame.
//
// Nothing plays in real time. Each frame sets the SVG's clock to an exact
// moment and takes a screenshot, so the result is smooth however slow the
// machine is, and several browsers can draw different frames at once.
//
// Needs Node 22 or later, Chrome and ffmpeg. No npm packages.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HELP = `Render an animated SVG (CSS animations and SMIL) to a video.

  node svg2mp4.mjs in.svg out.mp4 [options]

The output format follows the file name: .mp4, .mov, .webm or .gif.

Time
  --duration <s>     length of the video in seconds (default 20)
  --start <s>        where on the SVG's own clock the video begins (default 0)
  --fps <n>          frames per second (default 30)

Size
  --preset <name>    1080p, 720p, 4k, square, portrait or vertical
  --width <px>       output width (default: the viewBox width)
  --height <px>      output height (default: the viewBox height)
  --scale <n>        draw the same picture n times larger, e.g. 2 (default 1)
  --fit <mode>       what to do when the output is not the SVG's shape:
                       auto     as the SVG itself asks (default)
                       cover    fill the frame, cropping the overflow
                       contain  show all of it, bars in the background color
                       blur     show all of it over a blurred copy of itself
  --background <c>   color behind the SVG, any CSS color (default black)

Quality and speed
  --crf <n>          encoder quality, lower is better (default 18)
  --lossless         pass PNG frames to the encoder instead of JPEG (slower)
  --jobs <n>         browsers drawing at once (default: half the cores, at most 4)

Set CHROME or FFMPEG to use a binary that is not on the usual path.
An SVG moved by JavaScript is not supported: only CSS and SMIL have a clock to set.`

const PRESETS = {
  '1080p': [1920, 1080],
  '720p': [1280, 720],
  '4k': [3840, 2160],
  square: [1080, 1080],
  portrait: [1080, 1350],
  vertical: [1080, 1920],
}

const FITS = ['auto', 'cover', 'contain', 'blur']

// name: [kind, default]
const OPTIONS = {
  duration: ['number', 20],
  start: ['number', 0],
  fps: ['number', 30],
  preset: ['string', undefined],
  width: ['number', undefined],
  height: ['number', undefined],
  scale: ['number', 1],
  fit: ['string', 'auto'],
  background: ['string', '#000'],
  crf: ['number', 18],
  lossless: ['flag', false],
  jobs: ['number', Math.min(4, Math.max(1, Math.floor(availableParallelism() / 2)))],
}

const CHROME_PATHS = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
]

class UsageError extends Error {}

function parseArgs(argv) {
  const paths = []
  const options = Object.fromEntries(Object.entries(OPTIONS).map(([name, [, initial]]) => [name, initial]))

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { help: true }
    }
    if (!arg.startsWith('--')) {
      paths.push(arg)
      continue
    }

    const name = arg.slice(2)
    const kind = OPTIONS[name]?.[0]

    if (!kind) {
      throw new UsageError(`unknown option ${arg}`)
    }
    if (kind === 'flag') {
      options[name] = true
      continue
    }

    const value = argv[++i]

    if (value === undefined) {
      throw new UsageError(`${arg} needs a value`)
    }
    if (kind === 'number') {
      const number = Number(value)

      if (!Number.isFinite(number) || number < 0) {
        throw new UsageError(`${arg} needs a number, got "${value}"`)
      }
      options[name] = number
    } else {
      options[name] = value
    }
  }

  if (paths.length !== 2) {
    throw new UsageError('give one input SVG and one output file')
  }
  if (options.preset !== undefined && !(options.preset in PRESETS)) {
    throw new UsageError(`--preset must be one of: ${Object.keys(PRESETS).join(', ')}`)
  }
  if (!FITS.includes(options.fit)) {
    throw new UsageError(`--fit must be one of: ${FITS.join(', ')}`)
  }
  // The color goes into the page's stylesheet, so keep it to what a color needs.
  if (!/^[#\w(),.%\s/-]+$/.test(options.background)) {
    throw new UsageError(`--background is not a color: "${options.background}"`)
  }
  for (const name of ['duration', 'fps', 'scale', 'jobs']) {
    if (options[name] <= 0) {
      throw new UsageError(`--${name} must be more than 0`)
    }
  }

  return { input: resolve(paths[0]), output: resolve(paths[1]), ...options }
}

// The size the SVG asks for: its viewBox, else its width and height.
function naturalSize(svg) {
  const root = svg.match(/<svg\b[^>]*>/)

  if (!root) {
    throw new UsageError('the input has no <svg> element')
  }

  const viewBox = root[0].match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/)

  if (viewBox) {
    return { width: Number(viewBox[1]), height: Number(viewBox[2]) }
  }

  const width = root[0].match(/\bwidth\s*=\s*["']([\d.]+)/)
  const height = root[0].match(/\bheight\s*=\s*["']([\d.]+)/)

  return width && height ? { width: Number(width[1]), height: Number(height[1]) } : { width: 1280, height: 720 }
}

// The frame in CSS pixels, before --scale. An explicit width or height wins
// over the preset, and one given alone keeps the SVG's shape.
function frameSize(args, natural) {
  const [presetWidth, presetHeight] = PRESETS[args.preset] ?? []
  const shape = natural.width / natural.height
  let width = args.width
  let height = args.height

  if (width === undefined && height === undefined) {
    width = presetWidth ?? natural.width
    height = presetHeight ?? natural.height
  } else if (width === undefined) {
    width = height * shape
  } else if (height === undefined) {
    height = width / shape
  }

  // yuv420p video needs even dimensions in output pixels.
  const even = css => Math.max(2, Math.round((css * args.scale) / 2) * 2) / args.scale

  return { width: even(width), height: even(height) }
}

// The page each browser draws: the SVG filling the frame, and for `blur` a
// second, blurred copy behind it.
function pageHtml(svg, args, natural) {
  const css =
    `html,body{margin:0;height:100%;overflow:hidden;background:${args.background}}` +
    'div{position:absolute;inset:0}' +
    'div>svg{display:block;width:100%;height:100%}' +
    '.back{filter:blur(40px) brightness(.7);transform:scale(1.15)}'
  // `auto` leaves preserveAspectRatio as the SVG has it.
  const ratio = { cover: 'xMidYMid slice', contain: 'xMidYMid meet', blur: 'xMidYMid meet' }[args.fit]
  const setup = `
    for (const svg of document.querySelectorAll('div>svg')) {
      if (!svg.hasAttribute('viewBox')) {
        svg.setAttribute('viewBox', '0 0 ${natural.width} ${natural.height}')
      }
      svg.removeAttribute('width')
      svg.removeAttribute('height')
      const ratio = svg.parentElement.className === 'back' ? 'xMidYMid slice' : ${JSON.stringify(ratio ?? null)}
      if (ratio) {
        svg.setAttribute('preserveAspectRatio', ratio)
      }
    }`

  return (
    `<!doctype html><style>${css}</style>` +
    (args.fit === 'blur' ? `<div class="back">${svg}</div>` : '') +
    `<div class="front">${svg}</div><script>${setup}</script>`
  )
}

// Runs in the page: put every clock in the document at `seconds`, then wait
// for the frame to be drawn.
const SEEK = `(seconds => {
  for (const svg of document.querySelectorAll('svg')) {
    svg.pauseAnimations()
    svg.setCurrentTime(seconds)
  }
  for (const animation of document.getAnimations()) {
    animation.pause()
    animation.currentTime = seconds * 1000
  }
  return new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)))
})`

function launchChrome(profileDir) {
  const binary = CHROME_PATHS.find(path => path && existsSync(path))

  if (!binary) {
    throw new Error('Chrome not found. Set CHROME to its path.')
  }

  const chrome = spawn(
    binary,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--force-color-profile=srgb',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )

  const endpoint = new Promise((found, reject) => {
    let log = ''

    chrome.stderr.on('data', chunk => {
      log += chunk
      const match = log.match(/DevTools listening on (ws:\/\/\S+)/)

      if (match) {
        found(match[1])
      }
    })
    chrome.on('error', reject)
    setTimeout(() => reject(new Error('Chrome did not start within 20 seconds')), 20000).unref()
  })

  endpoint.catch(() => {})

  return { chrome, endpoint }
}

// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket.
async function connect(endpoint) {
  const socket = new WebSocket(endpoint)
  const pending = new Map()
  let nextId = 1

  await new Promise((opened, reject) => {
    socket.addEventListener('open', opened, { once: true })
    socket.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true })
  })

  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    const waiter = pending.get(message.id)

    if (!waiter) {
      return
    }
    pending.delete(message.id)

    if (message.error) {
      waiter.reject(new Error(message.error.message))
    } else {
      waiter.resolve(message.result)
    }
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((answered, reject) => {
      const id = nextId++

      pending.set(id, { resolve: answered, reject })
      socket.send(JSON.stringify({ id, method, params, sessionId }))
    })

  return { send, close: () => socket.close() }
}

// Chrome now and then refuses a screenshot while it is busy. The clock is
// already set, so asking again gives the same frame.
async function capture(page, lossless) {
  const params = lossless
    ? { format: 'png', optimizeForSpeed: true }
    : { format: 'jpeg', quality: 95, optimizeForSpeed: true }

  for (let attempt = 1; ; attempt++) {
    try {
      return await page('Page.captureScreenshot', params)
    } catch (error) {
      if (attempt === 5 || error.message === 'Chrome quit') {
        throw error
      }
      await new Promise(done => setTimeout(done, 200 * attempt))
    }
  }
}

// One browser. It takes frames off the shared queue until none are left, and
// throws if Chrome goes away, having put its unfinished frame back.
async function drawInOneChrome(job) {
  const profileDir = mkdtempSync(join(tmpdir(), 'svg2mp4-chrome-'))
  const { chrome, endpoint } = launchChrome(profileDir)
  // The socket does not always report that Chrome has gone, so every call
  // races against the process itself.
  const gone = new Promise((_, reject) => chrome.once('exit', () => reject(new Error('Chrome quit'))))
  const alive = promise => Promise.race([promise, gone])
  let cdp

  gone.catch(() => {})

  try {
    cdp = await alive(endpoint.then(connect))

    const { targetId } = await alive(cdp.send('Target.createTarget', { url: 'about:blank' }))
    const { sessionId } = await alive(cdp.send('Target.attachToTarget', { targetId, flatten: true }))
    const page = (method, params) => alive(cdp.send(method, params, sessionId))

    await page('Page.bringToFront')
    await page('Emulation.setDeviceMetricsOverride', {
      width: job.size.width,
      height: job.size.height,
      deviceScaleFactor: job.args.scale,
      mobile: false,
    })

    const { frameTree } = await page('Page.getFrameTree')

    await page('Page.setDocumentContent', { frameId: frameTree.frame.id, html: job.html })

    for (let frame = job.queue.pop(); frame !== undefined; frame = job.queue.pop()) {
      try {
        const seconds = job.args.start + frame / job.args.fps

        await page('Runtime.evaluate', { expression: `${SEEK}(${seconds})`, awaitPromise: true })

        const { data } = await capture(page, job.args.lossless)

        writeFileSync(job.framePath(frame), Buffer.from(data, 'base64'))
        job.onFrame()
      } catch (error) {
        job.queue.push(frame)
        throw error
      }
    }
  } finally {
    cdp?.close()
    // Chrome is still writing to its profile until it has exited.
    if (chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(done => chrome.once('exit', done))

      chrome.kill()
      await exited
    }
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}

// One worker: keeps a browser drawing until the queue is empty. Headless
// Chrome can quit in the middle of a long render. Every frame is set by the
// clock, not played, so a new Chrome carries on where the last one stopped.
// It gives up only when a Chrome draws nothing at all.
async function worker(job) {
  while (job.queue.length > 0) {
    const before = job.done()

    try {
      await drawInOneChrome(job)
    } catch (error) {
      if (job.done() === before) {
        throw error
      }
    }
  }
}

function encode(args, framesDir, extension) {
  const input = ['-y', '-loglevel', 'error', '-framerate', String(args.fps), '-i', join(framesDir, `%06d.${extension}`)]
  let output

  if (args.output.endsWith('.gif')) {
    output = ['-vf', 'split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a']
  } else if (args.output.endsWith('.webm')) {
    output = ['-c:v', 'libvpx-vp9', '-pix_fmt', 'yuv420p', '-crf', String(args.crf), '-b:v', '0']
  } else {
    output = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', String(args.crf), '-preset', 'medium', '-movflags', '+faststart']
  }

  return new Promise((done, reject) => {
    const ffmpeg = spawn(process.env.FFMPEG ?? 'ffmpeg', [...input, ...output, args.output], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })

    ffmpeg.on('error', () => reject(new Error('ffmpeg not found. Install it or set FFMPEG to its path.')))
    ffmpeg.on('exit', code => (code === 0 ? done() : reject(new Error(`ffmpeg failed (code ${code})`))))
  })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    console.log(HELP)
    return
  }
  if (!existsSync(args.input)) {
    throw new UsageError(`no such file: ${args.input}`)
  }

  const svg = readFileSync(args.input, 'utf8').replace(/^\s*<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/i, '')
  const natural = naturalSize(svg)
  const size = frameSize(args, natural)
  const frames = Math.max(1, Math.round(args.duration * args.fps))
  const jobs = Math.max(1, Math.min(Math.floor(args.jobs), frames))
  const extension = args.lossless ? 'png' : 'jpg'
  const framesDir = mkdtempSync(join(tmpdir(), 'svg2mp4-frames-'))
  let drawn = 0

  const job = {
    args,
    size,
    html: pageHtml(svg, args, natural),
    // Popped from the end, so the queue is in reverse: early frames first.
    queue: Array.from({ length: frames }, (_, i) => frames - 1 - i),
    framePath: frame => join(framesDir, `${String(frame).padStart(6, '0')}.${extension}`),
    done: () => drawn,
    onFrame: () => {
      drawn++
      if (process.stderr.isTTY) {
        process.stderr.write(`\rframe ${drawn}/${frames}`)
      }
    },
  }

  try {
    // Before any drawing, so a bad output path fails at once.
    mkdirSync(dirname(args.output), { recursive: true })
    await Promise.all(Array.from({ length: jobs }, () => worker(job)))

    if (process.stderr.isTTY) {
      process.stderr.write('\n')
    }
    await encode(args, framesDir, extension)

    const pixels = `${Math.round(size.width * args.scale)}x${Math.round(size.height * args.scale)}`

    console.log(`${args.output}: ${pixels}, ${frames} frames, ${args.fps} fps, ${frames / args.fps}s`)
  } finally {
    rmSync(framesDir, { recursive: true, force: true })
  }
}

main().catch(error => {
  console.error(`svg2mp4: ${error.message}`)
  if (error instanceof UsageError) {
    console.error('Run with --help for the options.')
  }
  process.exit(1)
})
