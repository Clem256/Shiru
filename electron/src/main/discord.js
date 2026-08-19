import { Client, CUSTOM_RPC_ERROR_CODE } from '@xhayper/discord-rpc'
import { debounce } from '@/modules/util.js'
import { ipcMain } from 'electron'
import log from 'electron-log'

/**
 * Logs errors from Discord RPC requests, ignoring expected disconnect-related rejections.
 *
 * @param {Error & { code?: number }} error
 */
const logError = (error) => {
  if (error?.code !== CUSTOM_RPC_ERROR_CODE.CONNECTION_ENDED && error?.code !== CUSTOM_RPC_ERROR_CODE.CONNECTION_TIMEOUT) {
    log.error('Discord RPC request failed:', error)
  }
}

export default class Discord {

  /** @type {{ activity: object }} */
  defaultStatus = {
    activity: {
      timestamps: { start: Date.now() },
      details: 'Streaming anime instantly',
      state: 'Enjoying an anime episode...',
      assets: {
        large_image: 'icon',
        large_text: 'https://shiru.app/',
        small_image: 'sail',
        small_text: 'Watching anime on Shiru'
      },
      buttons: [
        {
          label: 'Download Shiru',
          url: 'https://latest.shiru.app/'
        }
      ],
      instance: true,
      type: 3
    }
  }

  /** @type {Client} */
  discord = new Client({ transport: { type: 'ipc' }, clientId: '1301772260780019742' })

  /** @type {string} */
  enableRPC = 'disabled'
  /** @type {Discord['defaultStatus'] | undefined} */
  cachedPresence

  /** @param {import('electron').BrowserWindow} window */
  constructor (window) {
    ipcMain.on('electron:setPresence', (event, data) => {
      this.cachedPresence = data
      this.debouncedDiscordRPC(this.enableRPC === 'full' ? this.cachedPresence : undefined, this.enableRPC === 'disabled')
    })

    ipcMain.on('electron:setDiscordRPC', (event, data) => {
      if (this.enableRPC !== data) {
        this.enableRPC = data
        if (data !== 'disabled') {
          if (!this.discord?.user) this.loginRPC()
          else this.debouncedDiscordRPC(this.enableRPC === 'full' ? this.cachedPresence : undefined)
        } else if (this.discord?.user) {
          this.debouncedDiscordRPC(undefined, true)
        }
      }
    })

    ipcMain.on('electron:clearPresence', () => this.debouncedDiscordRPC(undefined, true))

    this.discord.on('ready', async () => {
      this.setDiscordRPC(this.enableRPC === 'full' ? this.cachedPresence : undefined)
      this.discord.subscribe('ACTIVITY_JOIN_REQUEST').catch(logError)
      this.discord.subscribe('ACTIVITY_JOIN').catch(logError)
      this.discord.subscribe('ACTIVITY_SPECTATE').catch(logError)
    })

    this.discord.on('disconnected', () => { if (this.enableRPC !== 'disabled') this.loginRPC() })

    this.discord.on('ACTIVITY_JOIN', ({ secret }) => window.webContents.send('common:onLobbyInvite', secret))
    this.debouncedDiscordRPC = debounce((status, clearActivity) => this.setDiscordRPC(status, clearActivity), 4_500)
  }

  /**
   * Attempts to log in to Discord's local RPC socket.
   * Retries every 5 seconds on failure until a connection succeeds.
   */
  loginRPC() {
    this.discord.login().catch(() => setTimeout(() => this.loginRPC(), 5_000).unref?.())
  }

  /**
   * Updates or clears the Discord rich presence activity for the connected client.
   *
   * @param {object} [data=this.defaultStatus] the activity payload
   * @param {boolean} [clearActivity=false]
   */
  setDiscordRPC(data = this.defaultStatus, clearActivity = false) {
    if (clearActivity) {
      if (this.discord?.user) this.discord.user.clearActivity(process.pid).catch(logError)
    } else if (this.discord.user && data && this.enableRPC !== 'disabled') {
      data.pid = process.pid
      this.discord.request('SET_ACTIVITY', data).catch(logError)
    }
  }
}