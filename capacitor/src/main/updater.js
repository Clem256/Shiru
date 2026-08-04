import ApkUpdater from 'cordova-plugin-apkupdater'
import { App as Capacitor } from '@capacitor/app'
import { development } from './util.js'
import { ipcWire } from './ipc.js'
import semver from 'semver'
import YAML from 'yaml'

const versionCodes = { 'arm64-v8a': 1, 'armeabi-v7a': 2, 'x86': 3, 'universal': 4 }

/**
 * Manages application updates for Capacitor/Android using APK downloads.
 * Supports both stable and nightly release channels with architecture-specific builds.
 */
export default class Updater {
  hasUpdate = false
  updateAvailable = false
  availableInterval

  primarySource
  FALLBACK_SOURCES
  resolvedSource
  skipFallback = false

  build
  currentVersion
  versionCode
  latestRelease
  updateChannel = 'stable'

  /**
   * Creates an updater instance and sets up listeners.
   *
   * @param {object} primarySource Primary update source config
   * @param {object[]} [FALLBACK_SOURCES=[]] Fallback update sources tried if primary is unreachable
   */
  constructor(primarySource, FALLBACK_SOURCES = []) {
    this.primarySource = primarySource
    this.FALLBACK_SOURCES = FALLBACK_SOURCES
    this.getInfo()
    ipcWire.on('common:checkForUpdates', (event, channel) => this.checkForUpdates(channel))
    ipcWire.on('common:setUpdateChannel', (event, channel) => this.setUpdateChannel(channel))
  }

  /** Retrieves and stores app version information and device architecture. */
  async getInfo() {
    const appInfo = await Capacitor.getInfo()
    this.build = appInfo.build
    this.currentVersion = appInfo.version?.replace('-dev', '')
    this.versionCode = await this.parseABI()
  }

  /**
   * Determines device architecture from build string.
   *
   * @returns {Promise<string>} Architecture identifier (arm64-v8a, armeabi-v7a, x86, or universal)
   */
  async parseABI() {
    if (this.build?.length === 7) {
      const versionCode = parseInt(this.build.substring(0, 1))
      if (versionCode < 5) {
        for (const [arch, code] of Object.entries(versionCodes)) {
          if (code === versionCode) return arch
        }
      } else if (versionCode === 5) return 'arm64-v8a'
    }
    return 'universal'
  }

  /**
   * Checks for available updates based on current update channel.
   *
   * @param channel Optionally update the current update channel.
   * */
  async checkForUpdates(channel) {
    if (channel) this.updateChannel = channel
    if (!development) {
      try {
        const source = this.resolvedSource ?? this.primarySource
        let release = null
        try {
          if (this.updateChannel === 'nightly') release = await this.getNightlyUpdate(source)
          else release = await this.getStableRelease(source)
        } catch (error) {
          if (!this.skipFallback && (error.status === 404 || error.status === 451)) {
            const fallback = await this.#tryFallbacks(source)
            if (fallback) {
              this.resolvedSource = fallback.source
              release = fallback.release
            }
          } else throw error
        }

        if (!release) {
          console.debug('Failed to find a reachable update source')
          return
        }

        this.latestRelease = release
        if (this.isOutdated() && !this.updateAvailable && !this.hasUpdate) {
          this.startUpdatePolling()
        }
      } catch (error) {
        console.debug('Failed to check for updates', error)
      }
    } else console.debug('Skip checkForUpdates because application is not packed and dev update config is not forced')
  }

  /**
   * Fetches the latest nightly or stable version.
   *
   * @param {object} source Resolved update source config
   * @returns {Promise<string|null>} Latest version string or null on error
   */
  async getNightlyUpdate(source) {
    try {
      let tagsUrl
      switch (source.provider) {
        case 'github':
          tagsUrl = `https://api.github.com/repos/${source.owner}/${source.repo}/git/refs/tags/`
          break
        case 'generic': {
          // Skip fetching tags as the update channel for generic corresponds to the most recent nightly 'beta' or stable 'latest'.
          return this.#fetchYamlVersion(source)
        }
        default:
          // Unknown provider... only get the stable release.
          return this.getStableRelease(source)
      }
      // Supported provider type for tag-based nightlies
      const response = await fetch(tagsUrl)
      if (!response.ok) {
        console.debug('Failed to fetch tags', response.status, response.statusText)
        return this.getStableRelease(source)
      }
      const tags = await response.json()
      if (!Array.isArray(tags)) {
        console.debug('Tags response is not an array', tags)
        return this.getStableRelease(source)
      }
      if (tags.length === 0) {
        console.debug('No tags found in repository')
        return this.getStableRelease(source)
      }
      const tagNames = tags.map(tag => tag.ref?.replace('refs/tags/v', '')).filter(tag => tag && semver.valid(tag))
      if (tagNames.length === 0) {
        console.debug('No valid semver tags found')
        return this.getStableRelease(source)
      }

      let candidateVersion = null
      const latestStable = this.getLatestTag(tagNames.filter(tag => !semver.prerelease(tag)))
      const latestNightly = this.getLatestTag(tagNames.filter(tag => semver.prerelease(tag)))
      if (!latestStable && !latestNightly) {
        return this.getStableRelease(source)
      } else if (!latestStable) {
        candidateVersion = latestNightly
      } else if (!latestNightly) {
        candidateVersion = latestStable
      } else if (semver.gt(latestStable, latestNightly)) {
        candidateVersion = latestStable
      } else {
        candidateVersion = latestNightly
      }

      const version = await this.#fetchYamlVersion(source, candidateVersion)
      if (!version) throw new Error(`YAML fetch failed for ${candidateVersion}`)
      return version
    } catch (error) {
      console.debug('Failed to get nightly update', error)
      return this.getStableRelease(source)
    }
  }

  /**
   * Fetches the latest stable release version.
   *
   * @param {object} source Resolved update source config
   * @returns {Promise<string|null>} Stable version string or null on error
   */
  async getStableRelease(source) {
    const version = await this.#fetchYamlVersion(source)
    if (!version) console.debug('Failed to fetch stable release from all sources')
    return version
  }

  /**
   * Finds the latest version from a list of tags using semver comparison.
   *
   * @param {string[]} tags Array of version tag strings
   * @returns {string|null} Latest version tag or null if empty
   */
  getLatestTag(tags) {
    if (!tags || tags.length === 0) return null
    return tags.sort((tagA, tagB) => semver.rcompare(tagA, tagB))[0]
  }

  /**
   * Determines if an update is available based on version comparison and channel.
   *
   * @returns {boolean} True if update should be applied
   */
  isOutdated() {
    if (!this.latestRelease || !this.currentVersion) return false
    const current = semver.valid(this.currentVersion)
    const latest = semver.valid(this.latestRelease)
    if (semver.lt(latest, current)) return false
    if (this.updateChannel !== 'nightly' && semver.prerelease(this.latestRelease)) return false
    if (semver.gt(latest, current)) return true
    return semver.eq(latest, current) && semver.prerelease(this.currentVersion) && !semver.prerelease(this.latestRelease)
  }

  /**
   * Fetches and parses the update YAML file from the given source.
   *
   * @param {object} source Resolved update source config
   * @param {string} [version] Optional version tag for non-latest releases
   * @returns {Promise<string|null>} Parsed version string or null on failure
   * @throws {Error}
   */
  async #fetchYamlVersion(source, version) {
    let url
    switch (source.provider) {
      case 'github':
        url = version
          ? `https://github.com/${source.owner}/${source.repo}/releases/download/v${version}/latest-android.yml`
          : `https://github.com/${source.owner}/${source.repo}/releases/latest/download/latest-android.yml`
        break
      case 'generic':
        url = `https://${source.url}/${this.updateChannel === 'nightly' ? 'beta' : 'latest'}/latest-android.yml`
        break
      default:
        return null
    }
    const response = await fetch(url)
    if (!response.ok) {
      if (response.status === 404 || response.status === 451) {
        const error = new Error(`Update source returned ${response.status}`)
        error.status = response.status
        throw error
      }
      return null
    }
    return YAML.parse(await response.text()).version
  }

  /**
   * Tries each fallback update source in order, skipping the failed source.
   *
   * @param {object} failedSource Source that failed (skipped in this pass)
   * @returns {Promise<{source: object, release: string}|null>}
   */
  async #tryFallbacks(failedSource) {
    for (const source of this.FALLBACK_SOURCES) {
      if (source === failedSource) continue
      try {
        let release
        if (this.updateChannel === 'nightly') release = await this.getNightlyUpdate(source)
        else release = await this.getStableRelease(source)
        if (release) return { source, release }
      } catch (error) {
        if (error.status === 404 || error.status === 451) continue
        throw error
      }
    }
    this.skipFallback = true
    return null
  }

  /**
   * Changes the update channel and triggers a new update check.
   *
   * @param {string} [channel='stable'] Update channel ('stable' or 'nightly')
   */
  setUpdateChannel(channel = 'stable') {
    this.updateChannel = channel
    this.hasUpdate = false
    this.updateAvailable = false
    this.skipFallback = false
    this.latestRelease = null
    this.resolvedSource = undefined
    clearInterval(this.availableInterval)
    this.checkForUpdates()
  }

  /** Starts periodic polling to notify renderer of available update. */
  startUpdatePolling() {
    this.updateAvailable = true
    clearInterval(this.availableInterval)
    this.availableInterval = setInterval(() => {
      if (!this.hasUpdate) ipcWire.emit('common:onUpdateAvailable', this.latestRelease)
    }, 1_000)
    this.availableInterval.unref?.()
  }

  /**
   * Downloads and installs the update APK for the device architecture.
   *
   * @param {boolean} forceRequestInstall Whether to force installation
   * @returns {Promise<boolean>} True if installation started, false otherwise
   */
  async install(forceRequestInstall = false) {
    if (!this.hasUpdate && forceRequestInstall) {
      try {
        clearInterval(this.availableInterval)
        this.updateAvailable = false
        this.hasUpdate = true
        const source = this.resolvedSource ?? this.primarySource

        let assetUrl
        switch (source.provider) {
          case 'github': {
            const releaseInfo = await (await fetch(`https://api.github.com/repos/${source.owner}/${source.repo}/releases/tags/v${this.latestRelease}`)).json()
            const regex = new RegExp(`${semver.valid(releaseInfo.tag_name)}.*${this.versionCode}`, 'i')
            const asset = releaseInfo?.assets?.find(asset => regex.test(asset.browser_download_url))
            if (!asset) {
              console.debug('Update file not found for version and architecture', this.latestRelease, releaseInfo.tag_name, this.versionCode)
              this.updateAborted()
              return false
            }
            assetUrl = asset.browser_download_url
            break
          }
          case 'generic':
            assetUrl = `https://${source.url}/${this.updateChannel === 'nightly' ? 'beta' : 'latest'}/android-Shiru-v${this.latestRelease}-${this.versionCode}.apk`
            break
          default:
            console.debug('Asset lookup not supported for provider', source.provider)
            this.updateAborted()
            return false
        }

        await ApkUpdater.download(assetUrl, {
          onDownloadProgress: (progress) => {
            console.debug(progress)
            ipcWire.emit('common:onUpdateProgress', progress.progress ?? 0)
          }
        }, () => {
          const listener = Capacitor.addListener('appStateChange', (state) => {
            if (state.isActive) {
              listener.remove()
              setTimeout(() => this.updateAborted(true), 1_500).unref?.()
            }
          })
          ApkUpdater.install(console.error, console.error)
        }, (error) => {
          console.debug('Failed to download update', error)
          this.updateAborted()
        })
        return true
      } catch (error) {
        ipcWire.emit('common:onUpdateAborted')
        clearInterval(this.availableInterval)
        this.updateAvailable = false
        this.hasUpdate = false
        console.debug(error)
      }
    }
    return false
  }

  /**
   * Handles update abortion and restarts availability polling.
   *
   * @param {boolean} aborted Whether update was user-aborted vs error
   */
  updateAborted(aborted = false) {
    this.hasUpdate = false
    this.startUpdatePolling()
    ipcWire.emit('common:onUpdateAborted', aborted)
  }
}