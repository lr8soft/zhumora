// Optional production-bundle smoke check: run after `npm run build`.
// It opens a hidden, sandboxed Electron window with the Avatar CSP.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const smokeProfile = path.resolve(__dirname, '../../.temp/electron-avatar-smoke')
fs.mkdirSync(smokeProfile, { recursive: true })
app.setPath('userData', smokeProfile)
app.commandLine.appendSwitch('disable-gpu')

async function main() {
  const renderer = path.resolve(__dirname, '../../out/renderer')
  const worker = fs.readdirSync(path.join(renderer, 'assets')).find(name => /^motionWorker-.*\.js$/.test(name))
  if (!worker) throw new Error('The production build contains no motion worker.')
  const smokeHtml = path.join(renderer, 'avatar-worker-smoke.html')
  fs.writeFileSync(smokeHtml, `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; worker-src 'self' blob:">`)
  const window = new BrowserWindow({ show: false, webPreferences: {
    contextIsolation: true, nodeIntegration: false, sandbox: false
  } })
  try {
    await window.loadURL(pathToFileURL(smokeHtml).toString())
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const worker = new Worker(new URL('assets/${worker}', location.href), { type: 'module' })
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('motion worker timed out')) }, 10000)
      let classes = null
      worker.onmessage = event => {
        // The worker announces its trained vocabulary before it answers requests.
        if (event.data && event.data.classes) { classes = event.data.classes; return }
        clearTimeout(timer)
        const { motion, error } = event.data
        worker.terminate()
        if (error) reject(new Error(error))
        else resolve({ classes, name: motion?.name, frames: motion?.frames, values: motion?.rotations?.length })
      }
      worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)) }
      worker.postMessage({ id: 1, text: '挥手' })
    })`)
    if (!Array.isArray(result.classes) || !result.classes.includes('wave')) throw new Error('Worker did not announce its trained vocabulary.')
    if (result.name !== 'wave' || result.frames < 2 || result.values < 100) throw new Error('Invalid worker motion response.')
    process.stdout.write(`Avatar sandboxed CPU worker: ${JSON.stringify(result)}\n`)
  } finally {
    window.destroy()
    fs.rmSync(smokeHtml, { force: true })
  }
}

app.whenReady().then(main).then(() => app.quit(), error => {
  process.stderr.write(`${error.stack || error}\n`)
  app.exit(1)
})
