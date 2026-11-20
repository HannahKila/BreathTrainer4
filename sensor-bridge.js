// Sensor bridge (Vite plugin)
//
// Reads the Arduino over USB on the computer running `npm run dev`, and
// re-broadcasts every reading to all browsers that open the app — the
// computer's own browser AND phones on the same network — as Server-Sent
// Events at  /sensor/stream  (same origin as the app, so no CORS / IP setup).
//
// macOS / Linux: no extra dependency (uses `stty` + `cat`).
// Windows: run `npm install serialport` once; it is picked up automatically.
// Override the port with SENSOR_PORT=/dev/cu.usbmodemXXXX npm run dev

import fs from 'node:fs'
import { spawn } from 'node:child_process'

const BAUD = 115200
const RETRY_MS = 2000

function findPortUnix() {
  if (process.env.SENSOR_PORT) return process.env.SENSOR_PORT
  try {
    const name = fs
      .readdirSync('/dev')
      .find(n => /^(cu\.usbmodem|cu\.usbserial|ttyACM|ttyUSB)/.test(n))
    return name ? `/dev/${name}` : null
  } catch {
    return null
  }
}

export default function sensorBridge() {
  const clients = new Set()
  let state = { connected: false, port: null }
  let reader = null // { stop() }
  let retryTimer = null
  let buffer = ''

  const send = (res, chunk) => {
    try {
      res.write(chunk)
    } catch {
      clients.delete(res)
    }
  }
  const broadcast = chunk => clients.forEach(res => send(res, chunk))
  const statusEvent = () => `event: status\ndata: ${JSON.stringify(state)}\n\n`

  function setState(next) {
    state = next
    broadcast(statusEvent())
  }

  function onData(chunk) {
    buffer += chunk.toString()
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const value = line.trim()
      if (value !== '') broadcast(`data: ${value}\n\n`)
    }
  }

  function onClosed(log) {
    reader = null
    buffer = ''
    if (state.connected) log(`[sensor] disconnected from ${state.port}`)
    setState({ connected: false, port: null })
    scheduleRetry(log)
  }

  function scheduleRetry(log) {
    clearTimeout(retryTimer)
    retryTimer = setTimeout(() => open(log), RETRY_MS)
  }

  async function openWindows(log) {
    let SerialPort
    try {
      ;({ SerialPort } = await import('serialport'))
    } catch {
      log('[sensor] On Windows, run `npm install serialport` to read the Arduino.')
      return
    }
    const ports = await SerialPort.list()
    const info =
      ports.find(p => p.path === process.env.SENSOR_PORT) ||
      ports.find(p => p.vendorId?.toLowerCase() === '2341' || /arduino/i.test(p.manufacturer ?? ''))
    if (!info) return scheduleRetry(log)
    const port = new SerialPort({ path: info.path, baudRate: BAUD })
    port.on('open', () => {
      log(`[sensor] reading ${info.path}`)
      setState({ connected: true, port: info.path })
    })
    port.on('data', onData)
    port.on('close', () => onClosed(log))
    port.on('error', () => port.isOpen ? port.close() : onClosed(log))
    reader = { stop: () => port.isOpen && port.close() }
  }

  function openUnix(log) {
    const path = findPortUnix()
    if (!path) return scheduleRetry(log)
    // Keep the device open on fd 3, set the baud rate on that same fd, then read it.
    const child = spawn(
      'sh',
      ['-c', 'exec 3<"$1" && stty ' + BAUD + ' raw -echo <&3 && exec cat <&3', 'sh', path],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let errText = ''
    child.stdout.on('data', chunk => {
      if (!state.connected) {
        log(`[sensor] reading ${path}`)
        setState({ connected: true, port: path })
      }
      onData(chunk)
    })
    child.stderr.on('data', chunk => (errText += chunk))
    child.on('exit', () => {
      if (/busy/i.test(errText)) {
        log(`[sensor] ${path} is busy — close the Arduino Serial Monitor or any browser tab using "Connect USB".`)
      }
      onClosed(log)
    })
    reader = { stop: () => child.kill() }
  }

  function open(log) {
    if (reader) return
    if (process.platform === 'win32') openWindows(log).catch(() => scheduleRetry(log))
    else openUnix(log)
  }

  function handler(req, res, next) {
    if (!req.url?.startsWith('/sensor/stream')) return next()
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive'
    })
    res.write('retry: 1500\n\n')
    res.write(statusEvent())
    clients.add(res)
    req.on('close', () => clients.delete(res))
  }

  function setup(server) {
    const log = msg => server.config.logger.info(msg, { timestamp: true })
    server.middlewares.use(handler)
    open(log)
    server.httpServer?.on('close', () => {
      clearTimeout(retryTimer)
      reader?.stop()
    })
  }

  return {
    name: 'sensor-bridge',
    configureServer: setup,
    configurePreviewServer: setup
  }
}
