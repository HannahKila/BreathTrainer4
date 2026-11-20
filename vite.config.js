import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import sensorBridge from './sensor-bridge.js'

// https://vite.dev/config/
export default defineConfig({
  // sensorBridge: reads the Arduino over USB and streams it to every browser
  // (this computer and phones on the same network) at /sensor/stream
  plugins: [react(), sensorBridge()],
  // Let phones on the same network open http://<this computer's IP>:5173
  server: { host: true },
})
