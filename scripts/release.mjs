#!/usr/bin/env node
/**
 * Release helpers (see RELEASING.md), adapted from Magnolia's.
 *
 *   node scripts/release.mjs collect <mac-arm64|mac-x64|win-x64|linux-x64> <target-release-dir> <out-dir>
 *     Copy one platform's Tauri bundles into <out-dir> under the stable,
 *     version-less names the README's download links and the update
 *     manifest use, with their update signatures. The Release workflow
 *     runs this after each build.
 *
 *   node scripts/release.mjs finish [notes-file]
 *     (npm run release:finish.) Once the Release workflow has uploaded every
 *     platform to the draft for package.json's version: download its
 *     signatures, write latest.json (the update manifest) and upload it. The
 *     release notes in it, which the update window shows, come from
 *     notes-file, or else from the draft's description on GitHub.
 *
 *   node scripts/release.mjs manifests <version> <dir> [notes-file] [--base-url <url>]
 *     Write latest.json from the assets (or just their .sig files) in <dir>.
 *     --base-url points the download links at <url> instead of the GitHub
 *     release, for rehearsing an update against a local server.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = 'caledavis/Outline'
const root = fileURLToPath(new URL('..', import.meta.url))
const isWin = process.platform === 'win32'

/** The newest file in `dir` matching `pattern`. Tauri doesn't clear old
 *  versions' bundles between builds, so the first match could be stale. */
function findOne(dir, pattern) {
  if (!existsSync(dir)) throw new Error(`No bundle directory ${dir}: run the build first.`)
  const hits = readdirSync(dir).filter((f) => pattern.test(f))
  if (!hits.length) throw new Error(`No file matching ${pattern} in ${dir}`)
  return hits.map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function collect(platform, releaseDir, out) {
  const bundle = join(releaseDir, 'bundle')
  mkdirSync(out, { recursive: true })
  const copy = (from, name) => {
    copyFileSync(from, join(out, name))
    console.log(`  ${name}`)
  }
  /** An installer, and the signature the updater checks it against. */
  const signed = (dir, pattern, name) => {
    const file = findOne(join(bundle, dir), pattern)
    copy(file, name)
    copy(`${file}.sig`, `${name}.sig`)
  }
  if (platform === 'mac-arm64' || platform === 'mac-x64') {
    const arch = platform.slice(4)
    copy(findOne(join(bundle, 'dmg'), /\.dmg$/), `Outline-mac-${arch}.dmg`)
    signed('macos', /\.app\.tar\.gz$/, `Outline-mac-${arch}.app.tar.gz`)
  } else if (platform === 'win-x64') {
    signed('nsis', /-setup\.exe$/, 'Outline-win-x64-setup.exe')
    signed('msi', /\.msi$/, 'Outline-win-x64.msi')
    // The app on its own, for computers where installing isn't allowed. It
    // can't update itself, so it has no signature (see updater.rs).
    copy(join(releaseDir, 'outline.exe'), 'Outline-win-portable-x64.exe')
  } else if (platform === 'linux-x64') {
    signed('appimage', /\.AppImage$/, 'Outline-linux-x86_64.AppImage')
    signed('deb', /\.deb$/, 'Outline-linux-amd64.deb')
    signed('rpm', /\.rpm$/, 'Outline-linux-x86_64.rpm')
  } else {
    throw new Error(`Unknown platform "${platform}" (mac-arm64, mac-x64, win-x64, linux-x64)`)
  }
}

/**
 * The updater looks for `{os}-{arch}-{installer}` and then `{os}-{arch}`,
 * so each kind of install gets the payload it can install: a .deb install
 * a .deb, an MSI install an .msi, and so on.
 */
const TARGETS = [
  ['darwin-aarch64', 'Outline-mac-arm64.app.tar.gz'],
  ['darwin-x86_64', 'Outline-mac-x64.app.tar.gz'],
  ['windows-x86_64', 'Outline-win-x64-setup.exe'],
  ['windows-x86_64-nsis', 'Outline-win-x64-setup.exe'],
  ['windows-x86_64-msi', 'Outline-win-x64.msi'],
  ['linux-x86_64', 'Outline-linux-x86_64.AppImage'],
  ['linux-x86_64-appimage', 'Outline-linux-x86_64.AppImage'],
  ['linux-x86_64-deb', 'Outline-linux-amd64.deb'],
  ['linux-x86_64-rpm', 'Outline-linux-x86_64.rpm'],
]

function manifests(version, dir, notesFile, baseUrl) {
  const v = version.replace(/^v/, '')
  const base = baseUrl ? baseUrl.replace(/\/?$/, '/') : `https://github.com/${REPO}/releases/download/v${v}/`
  const platforms = {}
  for (const [target, file] of TARGETS) {
    const sig = join(dir, `${file}.sig`)
    if (existsSync(sig)) platforms[target] = { signature: readFileSync(sig, 'utf-8').trim(), url: `${base}${file}` }
  }
  if (!Object.keys(platforms).length) throw new Error(`No update signatures (.sig files) in ${dir}.`)
  const notes = notesFile ? readFileSync(notesFile, 'utf-8') : ''
  const manifest = { version: v, notes, pub_date: new Date().toISOString(), platforms }
  writeFileSync(join(dir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`  latest.json (${Object.keys(platforms).join(', ')})`)
}

const version = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit', shell: isWin, cwd: root })
}

/** Write the update manifest from the draft's signatures and upload it. */
function finish(notesFile) {
  const tag = `v${version()}`
  const dir = join(tmpdir(), `outline-${tag}-signatures`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  console.log(`Downloading the ${tag} signatures…`)
  run('gh', ['release', 'download', tag, '-D', dir, '--pattern', '*.sig', '--clobber', '--repo', REPO])
  let notes = notesFile ? resolve(notesFile) : undefined
  if (!notes) {
    const body = execFileSync('gh', ['release', 'view', tag, '--json', 'body', '--jq', '.body', '--repo', REPO], {
      encoding: 'utf-8',
      shell: isWin,
    }).trim()
    if (!body) throw new Error(`The ${tag} draft has no release notes yet: write them on GitHub, or pass a notes file.`)
    notes = join(dir, 'release-notes.md')
    writeFileSync(notes, body + '\n')
    console.log(`Using the ${tag} draft's release notes (${body.length} characters).`)
  }
  manifests(version(), dir, notes)
  run('gh', ['release', 'upload', tag, join(dir, 'latest.json'), '--clobber', '--repo', REPO])
  console.log('\nDone. Check the draft on GitHub, then publish it.')
}

const argv = process.argv.slice(2)
const flag = argv.indexOf('--base-url')
const baseUrl = flag >= 0 ? argv.splice(flag, 2)[1] : undefined
const [cmd, ...args] = argv
try {
  if (cmd === 'collect' && args.length === 3) collect(args[0], resolve(args[1]), resolve(args[2]))
  else if (cmd === 'finish') finish(args[0])
  else if (cmd === 'manifests' && args[0] && args[1]) manifests(args[0], resolve(args[1]), args[2], baseUrl)
  else {
    console.error(
      'usage: release.mjs collect <mac-arm64|mac-x64|win-x64|linux-x64> <target-release-dir> <out-dir>\n' +
        '       release.mjs finish [notes-file]\n' +
        '       release.mjs manifests <version> <dir> [notes-file] [--base-url <url>]',
    )
    process.exit(1)
  }
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
