import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  collectExtensionEntries,
  createDeterministicZip,
  packExtension,
  validateExtensionEntries,
} from '../scripts/pack-extension.mjs'

const CENTRAL_DIRECTORY_HEADER = 0x02014b50
const END_OF_CENTRAL_DIRECTORY = 0x06054b50

function listZip(buffer) {
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= 0; offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      endOffset = offset
      break
    }
  }
  assert.notEqual(endOffset, -1, 'ZIP end-of-central-directory record should exist')
  const count = buffer.readUInt16LE(endOffset + 10)
  let offset = buffer.readUInt32LE(endOffset + 16)
  const entries = []
  for (let index = 0; index < count; index++) {
    assert.equal(buffer.readUInt32LE(offset), CENTRAL_DIRECTORY_HEADER)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    entries.push({
      name: buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
      method: buffer.readUInt16LE(offset + 10),
      compressedBytes: buffer.readUInt32LE(offset + 20),
      bytes: buffer.readUInt32LE(offset + 24),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function fixtureManifest(version = '1.2.3') {
  return {
    manifest_version: 3,
    name: 'Fixture',
    version,
    permissions: ['debugger', 'tabs', 'storage'],
    optional_permissions: ['downloads'],
    background: { service_worker: 'background.js', type: 'module' },
    action: { default_popup: 'popup.html', default_icon: { 16: 'icons/icon16.png' } },
    options_ui: { page: 'options.html', open_in_tab: true },
    icons: { 16: 'icons/icon16.png' },
  }
}

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-relay-extension-pack-'))
  const extensionDir = join(root, 'extension')
  await writeFile(join(root, 'package.json'), '{"version":"9.9.9"}\n')
  await mkdir(join(extensionDir, 'icons'), { recursive: true })
  await writeFile(join(extensionDir, 'manifest.json'), `${JSON.stringify(fixtureManifest(), null, 2)}\n`)
  await writeFile(join(extensionDir, 'background.js'), "import './worker.js'\n")
  await writeFile(join(extensionDir, 'worker.js'), 'export const ready = true\n')
  await writeFile(join(extensionDir, 'popup.html'), '<!doctype html><title>Popup</title>\n')
  await writeFile(join(extensionDir, 'options.html'), '<!doctype html><title>Options</title>\n')
  await writeFile(join(extensionDir, 'icons/icon16.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { root, extensionDir }
}

test('extension pack is byte-for-byte deterministic with manifest at ZIP root', async (t) => {
  const fixture = await makeFixture()
  t.after(() => rm(fixture.root, { recursive: true, force: true }))
  const firstDir = join(fixture.root, 'first')
  const secondDir = join(fixture.root, 'second')

  const first = await packExtension({
    extensionDir: fixture.extensionDir,
    outputDir: firstDir,
  })
  await utimes(join(fixture.extensionDir, 'background.js'), new Date(), new Date('2035-05-06T07:08:09Z'))
  const second = await packExtension({
    extensionDir: fixture.extensionDir,
    outputDir: secondDir,
  })

  const firstBytes = await readFile(first.archivePath)
  const secondBytes = await readFile(second.archivePath)
  assert.deepEqual(firstBytes, secondBytes)
  assert.equal(first.digest, second.digest)
  assert.equal(first.version, '1.2.3')
  assert.match(first.archivePath, /browser-relay-extension-1\.2\.3\.zip$/)
  assert.equal(createHash('sha256').update(firstBytes).digest('hex'), first.digest)
  assert.equal(await readFile(first.checksumPath, 'utf8'), `${first.digest}  browser-relay-extension-1.2.3.zip\n`)

  const entries = listZip(firstBytes)
  assert.deepEqual(entries.map((entry) => entry.name), [
    'background.js',
    'icons/icon16.png',
    'manifest.json',
    'options.html',
    'popup.html',
    'worker.js',
  ])
  assert.ok(entries.every((entry) => entry.method === 0 && entry.compressedBytes === entry.bytes))
  assert.equal(entries.some((entry) => entry.name.startsWith('extension/')), false)
})

test('extension pack keeps its Store version independent and rejects invalid versions, required downloads, and missing assets', () => {
  const base = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(fixtureManifest())) },
    { name: 'background.js', data: Buffer.from('') },
    { name: 'popup.html', data: Buffer.from('') },
    { name: 'options.html', data: Buffer.from('') },
    { name: 'icons/icon16.png', data: Buffer.from('') },
  ]
  assert.equal(validateExtensionEntries(base).version, '1.2.3')

  assert.throws(
    () => validateExtensionEntries(base.map((entry) => entry.name === 'manifest.json'
      ? { ...entry, data: Buffer.from(JSON.stringify(fixtureManifest('1.2.3-beta'))) }
      : entry)),
    /Invalid Chrome extension version/,
  )

  const requiredDownloads = fixtureManifest()
  requiredDownloads.permissions.push('downloads')
  assert.throws(
    () => validateExtensionEntries(base.map((entry) => entry.name === 'manifest.json'
      ? { ...entry, data: Buffer.from(JSON.stringify(requiredDownloads)) }
      : entry)),
    /non-minimal required permission: downloads/,
  )

  assert.throws(
    () => validateExtensionEntries(base
      .filter((entry) => entry.name !== 'options.html')
      .map((entry) => entry.name === 'manifest.json'
        ? { ...entry, data: Buffer.from(JSON.stringify(fixtureManifest())) }
        : entry)),
    /missing Options page/,
  )
})

test('extension pack rejects hidden files, symlinks, and remote script imports', async (t) => {
  const hiddenFixture = await makeFixture()
  t.after(() => rm(hiddenFixture.root, { recursive: true, force: true }))
  await writeFile(join(hiddenFixture.extensionDir, '.DS_Store'), 'metadata')
  await assert.rejects(() => collectExtensionEntries(hiddenFixture.extensionDir), /hidden or platform metadata/)

  const linkFixture = await makeFixture()
  t.after(() => rm(linkFixture.root, { recursive: true, force: true }))
  try {
    await symlink(join(linkFixture.extensionDir, 'worker.js'), join(linkFixture.extensionDir, 'linked.js'))
    await assert.rejects(() => collectExtensionEntries(linkFixture.extensionDir), /symbolic link/)
  } catch (error) {
    if (error?.code !== 'EPERM') throw error
  }

  const entries = [
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(fixtureManifest())) },
    { name: 'background.js', data: Buffer.from("import 'https://example.com/remote.js'\n") },
    { name: 'popup.html', data: Buffer.from('') },
    { name: 'options.html', data: Buffer.from('') },
    { name: 'icons/icon16.png', data: Buffer.from('') },
  ]
  assert.throws(() => validateExtensionEntries(entries), /Remote JavaScript import/)
})

test('deterministic ZIP rejects duplicate paths instead of emitting ambiguous entries', () => {
  assert.throws(
    () => validateExtensionEntries([
      { name: 'manifest.json', data: Buffer.from('{}') },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]),
    /Duplicate extension archive path/,
  )
  const archive = createDeterministicZip([{ name: 'only.txt', data: Buffer.from('value') }])
  assert.deepEqual(listZip(archive).map((entry) => entry.name), ['only.txt'])
})
