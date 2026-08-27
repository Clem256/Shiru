import { ipcRenderer } from 'electron'
import { statfs } from 'fs/promises'

async function diskSpace(directory) {
  const { bsize, blocks, bavail } = await statfs(directory)
  return { total: bsize * blocks, free: bsize * bavail }
}

let heartbeatId
function setHeartBeat() {
  heartbeatId = setInterval(() => ipcRenderer.send('webtorrent-heartbeat'), 500)
}

setHeartBeat()
ipcRenderer.on('main-heartbeat', async (event, settings) => {
  clearInterval(heartbeatId)
  const { default: TorrentClient } = await import('webtorrent-client')
  globalThis.client = new TorrentClient(ipcRenderer, diskSpace, 'node', settings)
})
ipcRenderer.on('torrent:reload', async () => {
  globalThis.client?.destroy()
  await new Promise(resolve => {
    ipcRenderer.once('destroyed', resolve)
    setTimeout(resolve, 5000).unref?.()
  })
  setHeartBeat()
})