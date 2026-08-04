import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const promoPngUrl = new URL('../docs/chrome-web-store/assets/promo-small.png', import.meta.url)
const promoSvgUrl = new URL('../docs/chrome-web-store/assets/promo-small.svg', import.meta.url)
const screenshotPngUrl = new URL('../docs/chrome-web-store/assets/01-explicit-consent.png', import.meta.url)
const assetReadmeUrl = new URL('../docs/chrome-web-store/assets/README.md', import.meta.url)
const submissionUrl = new URL('../docs/chrome-web-store/submission.md', import.meta.url)
const privacyUrl = new URL('../PRIVACY.md', import.meta.url)

test('Chrome Web Store promotional tile is the required 440x280 RGB PNG', async () => {
  const png = await readFile(promoPngUrl)
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(png.readUInt32BE(16), 440)
  assert.equal(png.readUInt32BE(20), 280)
  assert.equal(png[24], 8, 'promo PNG should use 8-bit channels')
  assert.equal(png[25], 2, 'promo PNG should be RGB without an alpha channel')

  const svg = await readFile(promoSvgUrl, 'utf8')
  assert.match(svg, /<svg[^>]*\bwidth="440"[^>]*\bheight="280"[^>]*\bviewBox="0 0 440 280"/)
  assert.match(svg, /<title[^>]*>Browser Relay promotional tile<\/title>/)
})

test('Store packet records exact candidate evidence while keeping upload approval pending', async () => {
  const [submission, assets, screenshot] = await Promise.all([
    readFile(submissionUrl, 'utf8'),
    readFile(assetReadmeUrl, 'utf8'),
    readFile(screenshotPngUrl),
  ])

  assert.match(submission, /Store upload: \*\*not started\*\*/)
  assert.doesNotMatch(submission, /PENDING_/)
  assert.match(submission, /Compatible daemon version: `@linsoai\/browser-relay@1\.4\.1`/)
  assert.match(submission, /Candidate ZIP SHA-256:\s+`[a-f0-9]{64}`/)
  assert.match(submission, /Submitted ZIP SHA-256: [a-f0-9]{64}/)
  assert.match(submission, /Developer account, fee, upload, visibility, and submission have separate[\s\S]*written owner approval/)
  assert.match(submission, /Select \*\*Yes\*\*[\s\S]*`Runtime\.evaluate`[\s\S]*`debugger` API/)
  assert.equal(screenshot.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(screenshot.readUInt32BE(16), 1280)
  assert.equal(screenshot.readUInt32BE(20), 800)
  assert.equal(screenshot[25], 2, 'screenshot should be RGB without an alpha channel')
  assert.match(assets, /minimum one truthful product screenshot/)
  assert.ok(assets.includes(createHash('sha256').update(screenshot).digest('hex')))
  assert.match(assets, /CDP permission overrides do not grant the extension real loopback[\s\S]*access/)
})

test('public privacy policy includes the Chrome Web Store Limited Use statement', async () => {
  const privacy = await readFile(privacyUrl, 'utf8')
  assert.match(privacy, /use of information received from Google APIs, including Chrome APIs,[\s\S]*Limited Use requirements/)
  assert.match(privacy, /operators do not intentionally read browser command payloads or results transiting the default Hub/)
})
