// Tests for svg2mp4.mjs. Run with: node --test
// They need Chrome and ffmpeg, the same as the tool.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const TOOL = join(dirname(fileURLToPath(import.meta.url)), 'svg2mp4.mjs')
const dir = mkdtempSync(join(tmpdir(), 'svg2mp4-test-'))
const fixture = join(dir, 'fixture.svg')

// 200x100, black. A white square slides right by CSS, a red dot by SMIL,
// both linear over 4 seconds, so every moment has one right picture.
writeFileSync(
  fixture,
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <style>
    @keyframes slide { from { transform: translateX(0) } to { transform: translateX(160px) } }
    #square { animation: slide 4s linear forwards }
  </style>
  <rect width="200" height="100" fill="#000"/>
  <rect id="square" x="0" y="0" width="20" height="20" fill="#fff"/>
  <circle cx="10" cy="80" r="8" fill="#f00">
    <animate attributeName="cx" from="10" to="190" dur="4s" fill="freeze"/>
  </circle>
</svg>`,
)

after(() => rmSync(dir, { recursive: true, force: true }))

function run(...args) {
  return spawnSync('node', [TOOL, ...args], { encoding: 'utf8' })
}

function render(name, ...args) {
  const output = join(dir, name)
  const result = run(fixture, output, ...args)

  assert.equal(result.status, 0, result.stderr)

  return output
}

function probe(file) {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=width,height,nb_read_frames', '-of', 'json', file],
    { encoding: 'utf8' },
  )
  const [stream] = JSON.parse(result.stdout).streams

  return { width: stream.width, height: stream.height, frames: Number(stream.nb_read_frames) }
}

// Returns a function giving the [r, g, b] of a pixel in one frame of a video.
function frameOf(file, index, width, height) {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${index})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 28 },
  )

  assert.equal(result.stdout.length, width * height * 3, 'ffmpeg returned one whole frame')

  return (x, y) => [...result.stdout.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)]
}

const isWhite = ([r, g, b]) => r > 200 && g > 200 && b > 200
const isBlack = ([r, g, b]) => r < 50 && g < 50 && b < 50
const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80

test('CSS and SMIL are both at the right place in the right frame', () => {
  const output = render('motion.mp4', '--fps', '10', '--duration', '4', '--jobs', '3')

  assert.deepEqual(probe(output), { width: 200, height: 100, frames: 40 })

  // Frame 20 is t = 2s: the square covers x 80..100, the dot is at x = 100.
  const middle = frameOf(output, 20, 200, 100)

  assert.ok(isWhite(middle(90, 10)), `square at 2s: ${middle(90, 10)}`)
  assert.ok(isBlack(middle(50, 10)), `left of the square at 2s: ${middle(50, 10)}`)
  assert.ok(isRed(middle(100, 80)), `dot at 2s: ${middle(100, 80)}`)

  // Frame 0 is t = 0: both are still at the left edge.
  const first = frameOf(output, 0, 200, 100)

  assert.ok(isWhite(first(10, 10)), `square at 0s: ${first(10, 10)}`)
  assert.ok(isRed(first(10, 80)), `dot at 0s: ${first(10, 80)}`)
  assert.ok(isBlack(first(100, 80)), `middle of the dot's path at 0s: ${first(100, 80)}`)
})

test('frames come out in order whatever the number of browsers', () => {
  const one = render('jobs1.mp4', '--fps', '10', '--duration', '4', '--jobs', '1')
  const four = render('jobs4.mp4', '--fps', '10', '--duration', '4', '--jobs', '4')

  for (const index of [0, 7, 13, 26, 39]) {
    // The square's left edge is at 4 * index px, so its middle is 10 px on.
    const x = 4 * index + 10

    assert.ok(isWhite(frameOf(one, index, 200, 100)(x, 10)), `jobs 1, frame ${index}`)
    assert.ok(isWhite(frameOf(four, index, 200, 100)(x, 10)), `jobs 4, frame ${index}`)
  }
})

test('--start begins partway through the animation', () => {
  const output = render('start.mp4', '--fps', '10', '--duration', '1', '--start', '2')
  const first = frameOf(output, 0, 200, 100)

  assert.ok(isWhite(first(90, 10)))
  assert.ok(isBlack(first(10, 10)))
})

test('sizes: default, one side, preset, scale', () => {
  const short = ['--fps', '5', '--duration', '0.4']

  assert.deepEqual(probe(render('w.mp4', ...short, '--width', '400')), { width: 400, height: 200, frames: 2 })
  assert.deepEqual(probe(render('h.mp4', ...short, '--height', '50')), { width: 100, height: 50, frames: 2 })
  assert.deepEqual(probe(render('square.mp4', ...short, '--preset', 'square')), { width: 1080, height: 1080, frames: 2 })
  assert.deepEqual(probe(render('scale.mp4', ...short, '--scale', '2')), { width: 400, height: 200, frames: 2 })
  // An odd size is rounded to an even one, which yuv420p needs.
  assert.deepEqual(probe(render('odd.mp4', ...short, '--width', '201', '--height', '101')), { width: 202, height: 102, frames: 2 })
})

test('--scale draws the same picture with more pixels', () => {
  const output = render('scale-picture.mp4', '--fps', '10', '--duration', '4', '--scale', '2')
  const middle = frameOf(output, 20, 400, 200)

  assert.ok(isWhite(middle(180, 20)))
  assert.ok(isRed(middle(200, 160)))
})

test('fit modes in a square frame', () => {
  const args = ['--fps', '5', '--duration', '0.2', '--width', '200', '--height', '200']

  // contain: the 200x100 picture sits in the middle, bars above and below.
  const contain = frameOf(render('contain.mp4', ...args, '--fit', 'contain', '--background', '#00f'), 0, 200, 200)
  const [r, g, b] = contain(100, 10)

  assert.ok(b > 180 && r < 80 && g < 80, `bar is the background color: ${[r, g, b]}`)
  assert.ok(isWhite(contain(10, 60)), `square at the picture's top left: ${contain(10, 60)}`)

  // cover: the picture is twice as large and its sides are cropped, so the
  // square (x 0..20 of 200) is off the left edge.
  const cover = frameOf(render('cover.mp4', ...args, '--fit', 'cover'), 0, 200, 200)

  assert.ok(isBlack(cover(10, 10)), `square is cropped away: ${cover(10, 10)}`)
  assert.ok(isBlack(cover(100, 100)))

  // blur: the whole picture in the middle, and the bars are not flat color
  // but the blurred copy, so they are black here and not the blue asked for.
  const blur = frameOf(render('blur.mp4', ...args, '--fit', 'blur', '--background', '#00f'), 0, 200, 200)

  assert.ok(isWhite(blur(10, 60)), `square at the picture's top left: ${blur(10, 60)}`)
  assert.ok(blur(100, 10)[2] < 80, `bar is the blurred picture, not the background: ${blur(100, 10)}`)
})

test('gif, webm and lossless', () => {
  const short = ['--fps', '5', '--duration', '0.4']

  assert.deepEqual(probe(render('out.gif', ...short)), { width: 200, height: 100, frames: 2 })
  assert.deepEqual(probe(render('out.webm', ...short)), { width: 200, height: 100, frames: 2 })
  assert.deepEqual(probe(render('lossless.mp4', ...short, '--lossless')), { width: 200, height: 100, frames: 2 })
})

test('a missing output folder is made', () => {
  const output = render('new/folder/out.mp4', '--fps', '5', '--duration', '0.4')

  assert.deepEqual(probe(output), { width: 200, height: 100, frames: 2 })
})

test('usage errors exit 1 and say what is wrong', () => {
  const cases = [
    [[], /one input SVG and one output/],
    [[join(dir, 'missing.svg'), join(dir, 'x.mp4')], /no such file/],
    [[fixture, join(dir, 'x.mp4'), '--speed', '2'], /unknown option --speed/],
    [[fixture, join(dir, 'x.mp4'), '--fps'], /--fps needs a value/],
    [[fixture, join(dir, 'x.mp4'), '--fps', 'fast'], /--fps needs a number/],
    [[fixture, join(dir, 'x.mp4'), '--fps', '0'], /--fps must be more than 0/],
    [[fixture, join(dir, 'x.mp4'), '--preset', '8k'], /--preset must be one of/],
    [[fixture, join(dir, 'x.mp4'), '--fit', 'stretch'], /--fit must be one of/],
    [[fixture, join(dir, 'x.mp4'), '--background', 'red}body{display:none'], /not a color/],
  ]

  for (const [args, message] of cases) {
    const result = run(...args)

    assert.equal(result.status, 1, args.join(' '))
    assert.match(result.stderr, message)
  }
})

test('--help prints the options and exits 0', () => {
  const result = run('--help')

  assert.equal(result.status, 0)
  assert.match(result.stdout, /--preset/)
  assert.match(result.stdout, /--fit/)
})
