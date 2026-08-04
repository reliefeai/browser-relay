#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ZIP_LOCAL_FILE_HEADER = 0x04034b50
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const ZIP_VERSION = 20
const ZIP_UTF8_FLAG = 0x0800
const ZIP_STORE_METHOD = 0
const ZIP_DOS_TIME = 0
const ZIP_DOS_DATE = 0x0021 // 1980-01-01, the earliest ZIP timestamp.
const ZIP_FILE_MODE = (0o100644 << 16) >>> 0
const FORBIDDEN_NAMES = new Set(['.DS_Store', 'Thumbs.db'])
const FORBIDDEN_SUFFIXES = ['.env', '.key', '.log', '.map', '.pem', '.p12', '.pfx', '~']

const crcTable = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let value = n
  for (let bit = 0; bit < 8; bit++) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
  }
  crcTable[n] = value >>> 0
}

export function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function normalizeArchivePath(value) {
  const normalized = String(value).split(sep).join('/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\\')) {
    throw new Error(`Invalid extension archive path: ${value}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid extension archive path: ${value}`)
  }
  return normalized
}

function assertSafeSourcePath(archivePath) {
  const segments = archivePath.split('/')
  const name = segments.at(-1)
  if (segments.some((segment) => segment.startsWith('.')) || FORBIDDEN_NAMES.has(name)) {
    throw new Error(`Refusing to package hidden or platform metadata file: ${archivePath}`)
  }
  if (FORBIDDEN_SUFFIXES.some((suffix) => name.endsWith(suffix))) {
    throw new Error(`Refusing to package sensitive or generated file: ${archivePath}`)
  }
}

export async function collectExtensionEntries(extensionDir) {
  const root = resolve(extensionDir)
  const entries = []

  async function walk(directory) {
    const children = await readdir(directory, { withFileTypes: true })
    children.sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      const absolutePath = join(directory, child.name)
      const archivePath = normalizeArchivePath(relative(root, absolutePath))
      assertSafeSourcePath(archivePath)
      if (child.isSymbolicLink()) {
        throw new Error(`Refusing to package symbolic link: ${archivePath}`)
      }
      if (child.isDirectory()) {
        await walk(absolutePath)
        continue
      }
      if (!child.isFile()) throw new Error(`Unsupported extension entry: ${archivePath}`)
      entries.push({ name: archivePath, data: await readFile(absolutePath) })
    }
  }

  await walk(root)
  if (!entries.length) throw new Error(`Extension directory is empty: ${root}`)
  return entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

function manifestReference(manifest, value, label, available) {
  if (!value) return
  const archivePath = normalizeArchivePath(value)
  if (!available.has(archivePath)) throw new Error(`manifest.json references missing ${label}: ${archivePath}`)
}

export function validateExtensionEntries(entries) {
  const byName = new Map()
  for (const entry of entries) {
    const name = normalizeArchivePath(entry.name)
    assertSafeSourcePath(name)
    if (byName.has(name)) throw new Error(`Duplicate extension archive path: ${name}`)
    byName.set(name, Buffer.from(entry.data))
  }

  const manifestBuffer = byName.get('manifest.json')
  if (!manifestBuffer) throw new Error('manifest.json must be at the ZIP root')
  let manifest
  try {
    manifest = JSON.parse(manifestBuffer.toString('utf8'))
  } catch (error) {
    throw new Error(`Invalid extension/manifest.json: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (manifest.manifest_version !== 3) throw new Error('Chrome Web Store package must use Manifest V3')
  const versionParts = typeof manifest.version === 'string' ? manifest.version.split('.') : []
  if (
    versionParts.length < 1
    || versionParts.length > 4
    || versionParts.some((part) => !/^(0|[1-9]\d*)$/.test(part) || Number(part) > 65535)
    || versionParts.every((part) => Number(part) === 0)
  ) {
    throw new Error(`Invalid Chrome extension version: ${manifest.version || '(missing)'}`)
  }

  const requiredPermissions = new Set(Array.isArray(manifest.permissions) ? manifest.permissions : [])
  for (const permission of ['activeTab', 'webNavigation', 'downloads']) {
    if (requiredPermissions.has(permission)) {
      throw new Error(`Chrome Web Store package keeps non-minimal required permission: ${permission}`)
    }
  }
  if (!Array.isArray(manifest.optional_permissions) || !manifest.optional_permissions.includes('downloads')) {
    throw new Error('Chrome Web Store package must keep downloads optional')
  }

  const available = new Set(byName.keys())
  manifestReference(manifest, manifest.background?.service_worker, 'service worker', available)
  manifestReference(manifest, manifest.action?.default_popup, 'popup', available)
  manifestReference(manifest, manifest.options_ui?.page, 'Options page', available)
  for (const [size, icon] of Object.entries(manifest.icons || {})) {
    manifestReference(manifest, icon, `${size}px icon`, available)
  }
  for (const [size, icon] of Object.entries(manifest.action?.default_icon || {})) {
    manifestReference(manifest, icon, `${size}px action icon`, available)
  }

  for (const [name, data] of byName) {
    const source = data.toString('utf8')
    if (name.endsWith('.html') && /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(source)) {
      throw new Error(`Remote script reference is not allowed in Chrome Web Store package: ${name}`)
    }
    if (name.endsWith('.js') && (
      /\bimport\s*\(\s*["']https?:\/\//i.test(source)
      || /\bimport\s*["']https?:\/\//i.test(source)
      || /\b(?:import|export)\s+[^;\n]*\bfrom\s*["']https?:\/\//i.test(source)
    )) {
      throw new Error(`Remote JavaScript import is not allowed in Chrome Web Store package: ${name}`)
    }
  }

  return manifest
}

export function createDeterministicZip(entries) {
  const sorted = [...entries]
    .map((entry) => ({ name: normalizeArchivePath(entry.name), data: Buffer.from(entry.data) }))
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  if (!sorted.length) throw new Error('Cannot create an empty extension ZIP')
  if (sorted.length > 0xffff) throw new Error('ZIP64 is not supported by the deterministic extension packer')

  const localParts = []
  const centralParts = []
  let localOffset = 0

  for (const entry of sorted) {
    const name = Buffer.from(entry.name, 'utf8')
    if (name.length > 0xffff) throw new Error(`Extension archive path is too long: ${entry.name}`)
    const checksum = crc32(entry.data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0)
    localHeader.writeUInt16LE(ZIP_VERSION, 4)
    localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6)
    localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8)
    localHeader.writeUInt16LE(ZIP_DOS_TIME, 10)
    localHeader.writeUInt16LE(ZIP_DOS_DATE, 12)
    localHeader.writeUInt32LE(checksum, 14)
    localHeader.writeUInt32LE(entry.data.length, 18)
    localHeader.writeUInt32LE(entry.data.length, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localHeader.writeUInt16LE(0, 28)
    localParts.push(localHeader, name, entry.data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0)
    centralHeader.writeUInt16LE((3 << 8) | ZIP_VERSION, 4)
    centralHeader.writeUInt16LE(ZIP_VERSION, 6)
    centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8)
    centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10)
    centralHeader.writeUInt16LE(ZIP_DOS_TIME, 12)
    centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14)
    centralHeader.writeUInt32LE(checksum, 16)
    centralHeader.writeUInt32LE(entry.data.length, 20)
    centralHeader.writeUInt32LE(entry.data.length, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(ZIP_FILE_MODE, 38)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)

    localOffset += localHeader.length + name.length + entry.data.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(sorted.length, 8)
  end.writeUInt16LE(sorted.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, end])
}

export async function packExtension({
  extensionDir,
  outputDir,
} = {}) {
  if (!extensionDir || !outputDir) {
    throw new Error('extensionDir and outputDir are required')
  }
  const entries = await collectExtensionEntries(extensionDir)
  const manifest = validateExtensionEntries(entries)
  const archive = createDeterministicZip(entries)
  const digest = createHash('sha256').update(archive).digest('hex')
  const filename = `browser-relay-extension-${manifest.version}.zip`
  const archivePath = join(resolve(outputDir), filename)
  const checksumPath = `${archivePath}.sha256`
  await mkdir(dirname(archivePath), { recursive: true })
  await writeFile(archivePath, archive)
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`)
  return {
    archivePath,
    checksumPath,
    version: manifest.version,
    digest,
    entries: entries.map((entry) => entry.name),
    bytes: archive.length,
  }
}

function parseArgs(argv) {
  const args = { outputDir: null }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]
    if (value === '--output-dir') {
      args.outputDir = argv[++index]
      if (!args.outputDir) throw new Error('--output-dir requires a path')
      continue
    }
    if (value === '--help' || value === '-h') {
      args.help = true
      continue
    }
    throw new Error(`Unknown option: ${value}`)
  }
  return args
}

async function main() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('Usage: npm run pack:extension -- [--output-dir <directory>]')
    return
  }
  const result = await packExtension({
    extensionDir: join(root, 'extension'),
    outputDir: args.outputDir ? resolve(args.outputDir) : join(root, 'dist'),
  })
  console.log(`[pack-extension] ${result.archivePath}`)
  console.log(`[pack-extension] ${result.entries.length} files, ${result.bytes} bytes`)
  console.log(`[pack-extension] sha256 ${result.digest}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`[pack-extension] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
