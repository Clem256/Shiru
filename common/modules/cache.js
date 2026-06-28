import { generalDefaults, historyDefaults, queryDefaults, notifyDefaults, isValidNumber, getRandomInt } from './util.js'
import { writable } from 'simple-store-svelte'
import equal from 'fast-deep-equal/es6'
import rfdc from 'rfdc'
import Debug from 'debug'
const debug = Debug('ui:cache')
const debugE = Debug('ui:eviction')
const deepClone = rfdc({ proto: false, circles: false, ownProps: true })

/** @type {Promise<IDBDatabase> | null} */
let currentDB = null
/** @type {number} */
const version = 1

/** @type {number} */
const EVICTION_MAX_PER_RUN = 500
/** @type {number} */
const EVICTION_STARTUP_DELAY = 2 * 60 * 1_000
/** @type {number} */
const EVICTION_INTERVAL = 5 * 60 * 1_000

/**
 * Map of user IDs to their corresponding batch writer instances.
 *
 * @type {Map<string, object>}
 */
const batchWriters = new Map()

/**
 * A collection of cache configurations used in the application.
 * Each entry represents a cache with its unique key and optional database configuration.
 *
 * @constant
 * @type {Object<string, {key: string, database?: boolean}>}
 */
export const caches = Object.freeze({
  GENERAL: { key: 'general', database: true },
  QUERIES: { key: 'queries', database: true },
  MAPPINGS: { key: 'mappings', database: true, expiryOffset: 120 * 24 * 60 * 60 * 1_000, maxEntries: 5_000 }, // evict after 120 days.
  USER_LISTS: { key: 'user_lists', database: true },
  MEDIA_CACHE: { key: 'medias', database: true, expiryOffset: 120 * 24 * 60 * 60 * 1_000, maxEntries: 10_000 }, // evict after 120 days.
  HISTORY: { key: 'history', database: true },
  NOTIFICATIONS: { key: 'notifications', database: true },
  COMPOUND: { key: 'compound', expiryOffset: 7 * 24 * 60 * 60 * 1_000, maxEntries: 500 }, // evict after 7 days.
  EXTENSIONS: { key: 'extensions' },
  EPISODES: { key: 'episodes', expiryOffset: 60 * 24 * 60 * 60 * 1_000, maxEntries: 1_000 }, // evict after 60 days.
  FOLLOWING: { key: 'following', expiryOffset: 30 * 24 * 60 * 60 * 1_000, maxEntries: 2_000 }, // evict after 30 days.
  RECOMMENDATIONS: { key: 'recommendations', expiryOffset: 30 * 24 * 60 * 60 * 1_000, maxEntries: 500 }, // evict after 30 days.
  SEARCH_IDS: { key: 'searchIDS', expiryOffset: 30 * 24 * 60 * 60 * 1_000, maxEntries: 1_000 }, // evict after 30 days.
  SEARCH: { key: 'search', expiryOffset: 30 * 24 * 60 * 60 * 1_000, maxEntries: 1_000 }, // evict after 30 days.
  RSS: { key: 'rss', expiryOffset: 7 * 24 * 60 * 60 * 1_000, maxEntries: 1_000 }, // evict after 7 days.
})

/**
 * Opens the IndexedDB database.
 * @param {string} dbName - The name of the database to open.
 * @returns {Promise<IDBDatabase>} - A promise that resolves to the database instance.
 */
function open(dbName) {
  if (currentDB) return currentDB
  currentDB = new Promise((resolve, reject) => {
    const request = indexedDB.open(String(dbName), version)
    request.onerror = (event) => { currentDB = null; reject(event.target.error) }
    request.onsuccess = (event) => resolve(event.target.result)
    request.onupgradeneeded = event => {
      const _database = event.target.result
      for (const { key, database } of Object.values(caches)) {
        if (database && !_database.objectStoreNames.contains(key)) {
          _database.createObjectStore(key, { keyPath: 'key' })
        }
      }
    }
  })
  return currentDB
}

/**
 * Loads all values from a specified cache (object store).
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @returns {Promise<Array>} - A promise that resolves to an array of all stored values.
 */
async function loadAll(userID, cache) {
  try {
    const database = await open(userID)
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(cache.key, 'readonly')
      const objectStore = transaction.objectStore(cache.key)
      const request = objectStore.getAll()
      request.onerror = (event) => reject(event.target.error)
      request.onsuccess = (event) => {
        resolve(event.target.result.reduce((acc, item) => {
          acc[item.key] = item.value
          return acc
        }, {}))
      }
    })
  } catch (error) {
    debug(`Failed to load cache ${cache.key} for user ${userID}:`, error)
    throw error
  }
}

/**
 * Retrieves a specific value from a cache using a key.
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @param {string} key - The key to retrieve the associated value for.
 * @returns {Promise<*>} - A promise that resolves to the value associated with the key, or null if not found.
 */
async function get(userID, cache, key) {
  const database = await open(userID)
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(cache.key, 'readonly')
    const objectStore = transaction.objectStore(cache.key)
    const request = objectStore.get(key)
    request.onerror = (error) => reject(error.target.error)
    request.onsuccess = (error) => resolve(error.target.result ? error.target.result.value : null)
  })
}

/**
 * Stores or updates a value in a specified cache.
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @param {string} key - The key to associate with the value.
 * @param {*} value - The value to store.
 * @returns {Promise<void>} - A promise that resolves when the operation is complete.
 */
async function set(userID, cache, key, value) {
  const database = await open(userID)
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(cache.key, 'readwrite')
    const objectStore = transaction.objectStore(cache.key)
    const request = objectStore.put({ key, value })
    request.onerror = (event) => reject(event.target.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Deletes specific keys from a specified cache.
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @param {string[]} keys - An array of keys to delete.
 * @returns {Promise<void>} - A promise that resolves when all specified keys are deleted.
 */
async function remove(userID, cache, keys) {
  if (!keys || keys.length === 0) return
  const database = await open(userID)
  const transaction = database.transaction(cache.key, 'readwrite')
  const objectStore = transaction.objectStore(cache.key)
  keys.forEach(k => objectStore.delete(k))
  return waitForTransaction(transaction)
}

/**
 * Clears all data from a specified cache.
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @returns {Promise<void>} - A promise that resolves when the cache is cleared.
 */
async function reset(userID, cache) {
  const database = await open(userID)
  const transaction = database.transaction(cache.key, 'readwrite')
  transaction.objectStore(cache.key).clear()
  return waitForTransaction(transaction)
}

/**
 * Deletes the entire database and all caches for a user.
 * @param {string} userID - The unique ID of the user (database name).
 * @returns {Promise<void>} - A promise that resolves when the database is deleted.
 */
async function purge(userID) {
  if (currentDB) {
    try { (await currentDB).close() } catch {}
    currentDB = null
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(String(userID))
    request.onerror = (event) => reject(event.target.error)
    request.onsuccess = () => resolve()
  })
}

/**
 * Writes multiple entries into the specified IndexedDB cache in a single transaction.
 *
 * This function only updates IndexedDB. It does NOT update the in-memory cache.
 * Callers are responsible for keeping memory and disk in sync if needed.
 *
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The name of the cache (object store).
 * @param {Array<[string, any]>} entries - An array of [key, value] pairs to insert/update.
 * @returns {Promise<void>} A promise that resolves when the transaction completes.
 */
async function putMany(userID, cache, entries) {
  if (!entries.length) return
  const database = await open(userID)
  const transaction = database.transaction(cache.key, 'readwrite')
  const objectStore = transaction.objectStore(cache.key)
  for (const [key, value] of entries) objectStore.put({ key, value })
  return waitForTransaction(transaction)
}

/**
 * Attempts to recover individual entries from a corrupted cache store.
 * Iterates through all keys and tries to read each one individually, collecting successful reads and logging failures.
 *
 * @param {string} userID - The unique ID of the user (database name).
 * @param {keyof typeof caches} cache - The cache to recover from.
 * @returns {Promise<Object>} An object containing successfully recovered key-value pairs.
 */
async function recoverCache(userID, cache) {
  const recovered = {}
  let corruptedKeys = []
  try {
    const database = await open(userID)
    const transaction = database.transaction(cache.key, 'readonly')
    const objectStore = transaction.objectStore(cache.key)
    const keysRequest = objectStore.getAllKeys()
    const keys = await new Promise((resolve, reject) => {
      keysRequest.onsuccess = () => resolve(keysRequest.result)
      keysRequest.onerror = () => reject(keysRequest.error)
    })
    debug(`Found ${keys.length} keys in ${cache.key}, attempting individual recovery...`)
    for (const key of keys) {
      try {
        recovered[key] = await new Promise((resolve, reject) => {
          const getRequest = objectStore.get(key)
          getRequest.onsuccess = () => {
            if (getRequest.result && getRequest.result.value !== undefined) resolve(getRequest.result.value)
            else reject(new Error('Empty or malformed entry'))
          }
          getRequest.onerror = () => reject(getRequest.error)
        })
        debug(`Recovered ${cache.key}:${key}`)
      } catch (error) {
        corruptedKeys.push(key)
        debug(`Failed to recover ${cache.key}:${key}:`, error.message)
      }
    }
    if (corruptedKeys.length > 0) debug(`Recovered ${Object.keys(recovered).length}/${keys.length} entries from ${cache.key}. Corrupted keys:`, corruptedKeys)
    else debug(`Successfully recovered all ${Object.keys(recovered).length} entries from ${cache.key}`)
  } catch (error) {
    debug(`Could not access ${cache.key} for recovery:`, error)
  }
  return recovered
}

/**
 * Retrieves (or creates) a batch writer for the given user.
 *
 * @param {string} userID - The unique ID of the user (database name).
 * @returns {object} The batch writer instance associated with the user.
 */
function getBatchWriter(userID) {
  if (!batchWriters.has(userID)) batchWriters.set(userID, createBatchWriter(userID))
  return batchWriters.get(userID)
}

/**
 * Wraps an IndexedDB transaction in a Promise.
 * Resolves when the transaction completes successfully and rejects if the transaction aborts or errors.
 *
 * @param {IDBTransaction} transaction - The IndexedDB transaction to monitor.
 * @returns {Promise<void>} A promise that resolves on success, rejects on failure.
 */
function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = transaction.onerror = (error) => reject(error?.target?.error || new Error('IndexedDB transaction failed'))
  })
}

/**
 * Creates a batch writer for a given user that buffers cache writes and flushes them to IndexedDB after a delay.
 *
 * This groups multiple writes into a single IndexedDB transaction and retries failed writes by re-enqueuing them.
 *
 * @param {string} userID - The unique ID of the user (database name).
 * @param {number} [firstFlushDelay=10000] - Delay in ms before the first flush before flushing writes to IndexedDB.
 * @param {number} [subsequentFlushDelay=1500] - Delay in ms for subsequent flushes before flushing writes to IndexedDB.
 * @param {number} [resetDelay=5000] - Delay in ms after which retry counts are reset.
 * @returns {Object} Batch writer with methods {@link enqueue}, {@link flushNow}, and {@link pendingCount}.
 */
function createBatchWriter(userID, firstFlushDelay = 10_000, subsequentFlushDelay = 1_500, resetDelay = 5_000) {
  const pending = new Map()
  const retryMap = new Map()
  let flushTimer = null
  let batchAt = null
  let initialFlush = true

  /**
   * Clears retry counts, allowing failed writes to retry again.
   */
  function resetRetries() {
    retryMap.clear()
  }
  setInterval(resetRetries, resetDelay).unref?.()

  /**
   * Flushes all queued writes to IndexedDB in a single transaction.
   * If an error occurs, re-enqueues the writes for retry.
   */
  async function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    batchAt = null
    initialFlush = false
    if (pending.size === 0) return
    const snapshot = Array.from(pending.entries())
    pending.clear()
    const database = await open(userID)
    for (const [cacheKey, kvMap] of snapshot) {
      try {
        const transaction = database.transaction(cacheKey, 'readwrite')
        const store = transaction.objectStore(cacheKey)
        for (const [key, value] of kvMap.entries()) store.put({ key, value })
        await waitForTransaction(transaction)
        debug(`Flushed ${kvMap.size} entries to ${cacheKey}`)
      } catch (error) {
        debug(`Failed to flush ${cacheKey}, will retry`, error)
        for (const [k, v] of kvMap) {
          const mapKey = `${cacheKey}:${k}`
          const attempts = retryMap.get(mapKey) || 0
          if (attempts < 3) {
            retryMap.set(mapKey, attempts + 1)
            getBatchWriter(userID).enqueue({ key: cacheKey }, k, v)
          } else debug(`Max retries reached for ${mapKey}, dropping value`)
        }
      }
    }
  }

  return {
    /**
     * Enqueues a cache entry for a specific cache and key.
     * Starts the flush timer if this is the first entry in the batch.
     *
     * @param {keyof typeof caches} cache - The name of the cache (object store).
     * @param {string|number} key - The key to store in the cache.
     * @param {*} value - The value to store.
     */
    enqueue(cache, key, value) {
      const cacheKey = cache.key
      if (!pending.has(cacheKey)) pending.set(cacheKey, new Map())
      pending.get(cacheKey).set(String(key), value)
      if (!batchAt) {
        batchAt = Date.now()
        flushTimer = setTimeout(() => {
          flush().finally(() => {
            flushTimer = null
            batchAt = null
          })
        }, initialFlush ? firstFlushDelay : subsequentFlushDelay)
        flushTimer?.unref?.()
      }
    },
    /**
     * Immediately flushes all queued cache entries to IndexedDB.
     */
    async flushNow() {
      await flush()
    },
    /**
     * Returns the total number of queued cache entries across all caches.
     * @returns {number} Total pending cache entries.
     */
    pendingCount() {
      return [...pending.values()].reduce((n, m) => n + m.size, 0)
    }
  }
}

/** @type {import('simple-store-svelte').Writable<Record<number, import('./providers/anilist/al.d.ts').Media>>} */
export let mediaCache

class Cache {
  /** @type {string} */
  cacheID = (JSON.parse(localStorage.getItem('ALviewer')) || JSON.parse(localStorage.getItem('MALviewer')))?.viewer?.data?.Viewer?.id || 'default'
  /** @type {import('svelte/store').Writable<GeneralDefaults>} */
  general
  /** @type {import('svelte/store').Writable<QueryDefaults>} */
  queries
  /** @type {import('simple-store-svelte').Writable<any>} */
  user_lists
  /** @type {import('simple-store-svelte').Writable<any>} */
  mappings
  /** @type {import('svelte/store').Writable<NotifyDefaults>} */
  notifications
  /** @type {import('svelte/store').Writable<any>} */
  history
  /** @type {Map<string, any>} */
  #pending = new Map()
  /** @type {import('svelte/store').Writable<string>} */
  status
  /** @type {import('svelte/store').Writable<any>} */
  page
  /** @type {AnilistClient} */
  anilistClient

  isReady
  subscribers = []

  /**
   * @type {Promise<void>}
   * A promise that resolves when the cache has been fully initialized.
   * Use this to ensure all required data is loaded and ready for use.
   */
  constructor() {
    this.isReady = this.#initialize()
  }

  /**
   * Runs a full eviction pass across all configured caches, respecting the per-run deletion budget.
   * Handles nested query stores, flat IDB caches, and the media cache separately.
   *
   * @param {Map<string, Object>} cacheMap
   */
  async #runEviction(cacheMap) {
    const now = Date.now()
    let totalPurged = 0
    const purgedByCacheKey = {}
    const evictableCaches = Object.values(caches).filter(cache => cache.expiryOffset)
    debugE(`Pass started, evaluating ${evictableCaches.length} caches: ${evictableCaches.map(cache => cache.key).join(', ')}`)

    // queries is nested: { [subKey]: { [entryKey]: { data, expiry, cachedAt } } }
    // each subKey maps to a cache definition with its own expiryOffset and maxEntries
    const queriesStore = cacheMap.get(caches.QUERIES.key)
    const cachesByKey = Object.fromEntries(Object.values(caches).map(cache => [cache.key, cache]))
    if (queriesStore) {
      for (const [subKey, subStore] of Object.entries(queriesStore)) {
        if (totalPurged >= EVICTION_MAX_PER_RUN) break
        const subDefinition = cachesByKey[subKey]
        if (!subDefinition?.expiryOffset) continue

        const { expiryOffset, maxEntries } = subDefinition
        const subEntries = Object.entries(subStore || {})
        const budget = EVICTION_MAX_PER_RUN - totalPurged

        const expired = Object.entries(queriesStore[subKey] || {}).filter(([, entry]) => entry && typeof entry === 'object' && entry.expiry != null && now > entry.expiry + expiryOffset).slice(0, budget).map(([key]) => key)
        if (expired.length) {
          for (const key of expired) delete queriesStore[subKey][key]
          try {
            await putMany(this.cacheID, caches.QUERIES, [[subKey, queriesStore[subKey]]])
          } catch (error) {
            debugE(`IDB update failed for queries:${subKey}:`, error)
          }
          this.queries.update(value => {
            if (value[subKey]) {
              for (const key of expired) delete value[subKey][key]
            }
            return value
          })
          cacheMap.set(caches.QUERIES.key, queriesStore)
          totalPurged += expired.length
          purgedByCacheKey[subKey] = (purgedByCacheKey[subKey] || 0) + expired.length
          debugE(`Purged ${expired.length} expired entries from queries:${subKey}`)
        } else {
          debugE(`No expired entries for queries:${subKey} (${subEntries.length} total)`)
        }

        const remainingBudget = EVICTION_MAX_PER_RUN - totalPurged
        if (remainingBudget <= 0) break

        const currentEntries = Object.entries(queriesStore[subKey] || {})
        if (currentEntries.length > maxEntries) {
          const overflow = currentEntries.length - maxEntries
          const toRemove = currentEntries.filter(([, entry]) => entry && typeof entry === 'object').sort(([, a], [, b]) => (a.cachedAt ?? 0) - (b.cachedAt ?? 0)).slice(0, Math.min(overflow, remainingBudget)).map(([key]) => key)

          for (const key of toRemove) delete queriesStore[subKey][key]
          try {
            await putMany(this.cacheID, caches.QUERIES, [[subKey, queriesStore[subKey]]])
          } catch (error) {
            debugE(`IDB update failed for queries:${subKey}:`, error)
          }
          this.queries.update(value => {
            if (value[subKey]) {
              for (const key of toRemove) delete value[subKey][key]
            }
            return value
          })
          totalPurged += toRemove.length
          purgedByCacheKey[subKey] = (purgedByCacheKey[subKey] || 0) + toRemove.length
          debugE(`The queries:${subKey} cache overflowed by ${toRemove.length} entries, purged oldest (was ${currentEntries.length}, limit ${maxEntries})`)
        }
      }
    }

    // flat caches
    for (const cacheDefinition of Object.values(cachesByKey)) {
      if (!cacheDefinition.database || !cacheDefinition.expiryOffset) continue
      if (cacheDefinition.key === caches.QUERIES.key || cacheDefinition.key === caches.MEDIA_CACHE.key) continue
      if (totalPurged >= EVICTION_MAX_PER_RUN) break

      const { key: cacheKey, expiryOffset, maxEntries } = cacheDefinition
      const storeEntries = cacheMap.get(cacheKey)
      if (!storeEntries) continue

      const entries = Object.entries(storeEntries)
      const budget = EVICTION_MAX_PER_RUN - totalPurged
      const store = this[cacheKey]

      const expired = Object.entries(storeEntries).filter(([, entry]) => entry && typeof entry === 'object' && entry.expiry != null && now > entry.expiry + expiryOffset).slice(0, budget).map(([key]) => key)
      if (expired.length) {
        for (const key of expired) delete storeEntries[key]
        try {
          await remove(this.cacheID, cacheDefinition, expired)
        } catch (error) {
          debugE(`IDB remove failed for ${cacheKey}:`, error)
        }
        if (store) store.update(value => {
          for (const key of expired) delete value[key]
          return value
        })
        cacheMap.set(cacheKey, storeEntries)
        totalPurged += expired.length
        purgedByCacheKey[cacheKey] = (purgedByCacheKey[cacheKey] || 0) + expired.length
        debugE(`Purged ${expired.length} expired entries from ${cacheKey}`)
      } else {
        debugE(`No expired entries for ${cacheKey} (${entries.length} total)`)
      }

      const remainingBudget = EVICTION_MAX_PER_RUN - totalPurged
      if (remainingBudget <= 0) break

      const currentEntries = Object.entries(storeEntries)
      if (currentEntries.length > maxEntries) {
        const overflow = currentEntries.length - maxEntries
        const toRemove = currentEntries.filter(([, entry]) => entry && typeof entry === 'object').sort(([, a], [, b]) => (a.cachedAt ?? 0) - (b.cachedAt ?? 0)).slice(0, Math.min(overflow, remainingBudget)).map(([key]) => key)

        for (const key of toRemove) delete storeEntries[key]
        try {
          await remove(this.cacheID, cacheDefinition, toRemove)
        } catch (error) {
          debugE(`IDB remove failed for ${cacheKey}:`, error)
        }
        if (store) store.update(value => {
          for (const key of toRemove) delete value[key]
          return value
        })
        cacheMap.set(cacheKey, storeEntries)
        totalPurged += toRemove.length
        purgedByCacheKey[cacheKey] = (purgedByCacheKey[cacheKey] || 0) + toRemove.length
        debugE(`The ${cacheKey} cache overflowed by ${toRemove.length} entries, purged oldest (was ${currentEntries.length}, limit ${maxEntries})`)
      }
    }

    // media cache
    if (totalPurged < EVICTION_MAX_PER_RUN && mediaCache) {
      const { expiryOffset, maxEntries } = caches.MEDIA_CACHE
      const mediaBudget = EVICTION_MAX_PER_RUN - totalPurged
      const mediaEntries = Object.entries(mediaCache.value || {})
      const toRemove = []

      const expired = mediaEntries.filter(([, entry]) => entry?.expiry != null && now > entry.expiry + expiryOffset).slice(0, mediaBudget).map(([id]) => id)
      if (expired.length) {
        toRemove.push(...expired)
        debugE(`Purged ${expired.length} expired entries from medias`)
      }

      if (toRemove.length < mediaBudget) {
        const removedSet = new Set(toRemove)
        const currentMediaEntries = mediaEntries.filter(([id]) => !removedSet.has(id))
        if (currentMediaEntries.length > maxEntries) {
          const overflow = currentMediaEntries.length - maxEntries
          const oldest = currentMediaEntries.sort(([, a], [, b]) => (a?.cachedAt ?? 0) - (b?.cachedAt ?? 0)).slice(0, Math.min(overflow, mediaBudget - toRemove.length)).map(([key]) => key)
          toRemove.push(...oldest)
          debugE(`The medias cache overflowed by ${oldest.length} entries, purged oldest (was ${currentMediaEntries.length}, limit ${maxEntries})`)
        }
      }

      if (toRemove.length) {
        mediaCache.update(current => {
          for (const key of toRemove) delete current[key]
          return current
        })
        try {
          await remove(this.cacheID, caches.MEDIA_CACHE, toRemove)
        } catch (error) {
          debugE('IDB remove failed for medias:', error)
        }
        totalPurged += toRemove.length
        purgedByCacheKey['medias'] = (purgedByCacheKey['medias'] || 0) + toRemove.length
      } else debugE(`No expired entries for medias (${mediaEntries.length} total)`)
    }

    if (totalPurged > 0) debugE(`Pass complete, total: ${totalPurged}, ${Object.entries(purgedByCacheKey).map(([cacheKey, purgeCount]) => `${cacheKey}:${purgeCount}`).join(', ')}`)
    else debugE('Pass complete, nothing to purge')
  }

  /**
   * Starts the eviction scheduler, deferring the first run by {@link EVICTION_STARTUP_DELAY}
   * then repeating every {@link EVICTION_INTERVAL}. Skips runs while offline or while
   * the player is fullscreen, retrying after 30 seconds instead.
   *
   * @param {Map<string, Object>} cacheMap
   */
  async #startEvictionScheduler(cacheMap) {
    let running = false
    let timeout = null
    if (!this.status) {
      const { status } = await import('@/modules/networking.js')
      this.status = status
    }
    if (!this.page) {
      const { page } = await import('@/modules/navigation.js')
      this.page = page
    }

    /**
     * Attempts a single eviction pass. Skips if one is already running or a retry is pending.
     * If conditions aren't met (offline or fullscreen player), schedules a single retry in 30s.
     */
    const run = async () => {
      if (running || timeout) return
      if (this.status?.value?.match(/offline/i) || (this.page?.value === this.page?.PLAYER && document.fullscreenElement)) {
        debugE('Skipping run, offline or player is fullscreen, retrying in 30s')
        timeout = setTimeout(() => {
          timeout = null
          run()
        }, 30_000)
        timeout.unref?.()
        return
      }
      running = true
      await this.#runEviction(cacheMap)
      running = false
    }

    const startup = setTimeout(() => {
      run()
      const interval = setInterval(run, EVICTION_INTERVAL)
      interval.unref?.()
    }, EVICTION_STARTUP_DELAY)

    startup.unref?.()
  }

  /**
   * Initializes the cache by loading necessary data into memory.
   * @returns {Promise<void>}
   */
  async #initialize() {
    debug(`Loading caches with id: ${this.cacheID}...`)
    const cacheTypes = [
      { key: caches.MEDIA_CACHE, writable: (data) => mediaCache = writable(deepClone(data)) },
      { key: caches.GENERAL, writable: (data) => this.general = writable({ ...generalDefaults, ...deepClone(data) }) },
      { key: caches.QUERIES, writable: (data) => this.queries = writable({ ...queryDefaults, ...deepClone(data) }) },
      { key: caches.MAPPINGS, writable: (data) => this.mappings = writable(deepClone(data)) },
      { key: caches.USER_LISTS, writable: (data) => this.user_lists = writable(deepClone(data)) },
      { key: caches.NOTIFICATIONS, writable: (data) => this.notifications = writable({ ...notifyDefaults, ...deepClone(data) }) },
      { key: caches.HISTORY, writable: (data) => this.history = writable({ ...historyDefaults, ...deepClone(data) }) }
    ]

    /**
     * In-memory representation of all cache object stores.
     * Each entry maps a cache key to an object containing its stored key-value pairs.
     * This map is lazy-loaded on first access and kept in memory for fast lookups.
     *
     * @type {Map<string, Object>} - cacheKey -> { key: value }
     */
    const cacheMap = new Map()
    for (const { key } of cacheTypes) {
      try {
        let data
        try {
          data = await loadAll(this.cacheID, key)
        } catch (error) {
          debug(`Normal load failed for ${key.key}, attempting recovery:`, error.message)
          const recovered = await recoverCache(this.cacheID, key)
          if (Object.keys(recovered).length > 0) {
            try {
              debug(`Clearing corrupted ${key.key} and restoring ${Object.keys(recovered).length} recovered entries...`)
              await reset(this.cacheID, key)
              await putMany(this.cacheID, key, Object.entries(recovered))
              debug(`Successfully restored ${key.key} with recovered data`)
            } catch (restoreError) {
              debug(`Failed to restore ${key.key}, will use recovered data in-memory only:`, restoreError)
            }
          } else debug(`No data could be recovered from ${key.key}, returning empty cache`)
          data = recovered
        }

        if (key.key === caches.MEDIA_CACHE.key) {
          const now = Date.now()
          let needsUpdate = false
          for (const [id, media] of Object.entries(data)) {
            if (media && !media.cachedAt) {
              data[id] = { ...media, cachedAt: now, expiry: media.status === 'FINISHED' ? now + getRandomInt(7, 14) * 24 * 60 * 60 * 1_000 : now + getRandomInt(12, 24) * 60 * 60 * 1_000 }
              needsUpdate = true
            }
          }
          if (needsUpdate) {
            debug(`Migrating media cache entries to include cachedAt and expiry...`)
            try {
              await putMany(this.cacheID, caches.MEDIA_CACHE, Object.entries(data))
              debug(`Media cache migration complete`)
            } catch (error) {
              debug(`Failed to persist media cache migration, will use migrated data in-memory only:`, error)
            }
          }
        }

        cacheMap.set(key.key, data)
      } catch (error) {
        debug(`Critical error loading ${key.key}, using empty cache:`, error)
        cacheMap.set(key.key, {})
      }
    }
    cacheTypes.forEach(({ key, writable }) => writable(cacheMap.get(key.key)))

    this.subscribers = cacheTypes.map(({ key }) => {
      const batchWriter = getBatchWriter(this.cacheID)
      return (key.key === caches.MEDIA_CACHE.key ? mediaCache : this[key.key]).subscribe(value => {
        const storeEntries = cacheMap.get(key.key) || {}
        for (const [subKey, subValue] of Object.entries(value || {})) {
          const prevSubValue = storeEntries[subKey]
          if (prevSubValue !== subValue && !equal(prevSubValue, subValue)) {
            batchWriter.enqueue(key, subKey, subValue)
            storeEntries[subKey] = deepClone(subValue)
          }
        }
        for (const subKey of Object.keys(storeEntries)) {
          if (!(subKey in (value || {}))) {
            delete storeEntries[subKey]
            remove(this.cacheID, key, [subKey]).catch(error => debug(`Failed to remove ${subKey} from ${key}`, error))
          }
        }
        cacheMap.set(key.key, storeEntries)
        return () => {
          cacheMap.delete(key.key)
          debug('Unsubscribed from cache:', key.key)
        }
      })
    })

    this.#startEvictionScheduler(cacheMap)
    debug('Caches have successfully been loaded!')
  }

  /**
   * Releases all resources held by this cache and marks it as inactive.
   *
   * Unsubscribes listeners, clears pending operations and lookup maps,
   * nulls stored data to enable garbage collection, and logs its destruction.
   * After calling, this instance should not be used.
   */
  destroy() {
    this.subscribers.forEach((unsubscribe) => unsubscribe())
    this.#pending.clear()
    this.general = null
    this.queries = null
    this.mappings = null
    this.user_lists = null
    this.notifications = null
    this.history = null
    mediaCache = null
    debug(`Cache with ID ${this.cacheID} has been destroyed.`)
  }

  /**
   * Updates the cache for a specific key.
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {number|string} key The key for the specific cache entry (e.g., media ID).
   * @param {Object} data The cache object to store.
   * @warn Do not use this outside of {@link Cache}, use {@link cacheEntry} instead.
   */
  #update(cache, key, data) {
    if (cache === caches.USER_LISTS || cache === caches.MAPPINGS) {
      (cache === caches.USER_LISTS ? this.user_lists : this.mappings).update((query) => {
        query[key] = typeof data === 'function' ? data(query[key]) : data
        return query
      })
    } else {
      this.queries.update((query) => {
        if (!query[cache.key]) query[cache.key] = {}
        const current = query[cache.key][key]
        query[cache.key][key] = typeof data === 'function' ? data(current) : data
        return query
      })
    }
  }

  /**
   * Transfers all cached data from the current cache to a new cache ID and then purges the old cache.
   * Only keeps necessary info like settings, notifications, watch history, and previous magnet links excluding caches like queries and user lists as they can't be used.
   * @param {string} newCacheID - The ID of the new cache to which data should be transferred.
   * @returns {Promise<void>} Resolves when the data has been successfully transferred and the old cache purged.
   */
  async abandon(newCacheID){
    await purge(this.cacheID)
    this.cacheID = newCacheID
    for (const value of [[caches.GENERAL, this.general.value], [caches.NOTIFICATIONS, this.notifications.value], [caches.HISTORY, this.history.value]]) {
      for (const [key, keyValue] of Object.entries(value[1])) {
        try {
          await putMany(newCacheID, value[0], [[key, keyValue]])
        } catch (error) {
          debug(`IDB update failed for ${newCacheID}:${key}:`, error)
        }
      }
    }
  }

  /**
   * Resets all settings completely clearing the general cache.
   * See {@link generalDefaults} for all values that will be reset.
   */
  async resetSettings() {
    await reset(this.cacheID, caches.GENERAL)
    location.reload()
  }

  /**
   * Resets all watch history and magnet links completely clearing the history cache.
   * See {@link historyDefaults} for all values that will be reset.
   */
  async resetHistory() {
    await reset(this.cacheID, caches.HISTORY)
    this.history.value = { ...historyDefaults }
  }

  /**
   * Resets all caches completely clearing the caches, excluding notifications.
   * To clear notifications see: {@link resetNotifications}.
   *
   * See {@link queryDefaults} for all values that will be reset.
   */
  async resetCaches() {
    await reset(this.cacheID, caches.QUERIES)
    await reset(this.cacheID, caches.MAPPINGS)
    await reset(this.cacheID, caches.USER_LISTS)
    await reset(this.cacheID, caches.MEDIA_CACHE)
    location.reload()
  }

  /**
   * Resets all notifications completely clearing the notifications cache.
   * See {@link notifyDefaults} for all values that will be reset.
   */
  resetNotifications() {
    this.notifications.value = { ...notifyDefaults }
  }

  /**
   * Immediately retrieves a cache entry directly from storage skipping the batch caching queue.
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key - The category to retrieve (e.g., 'lastAni').
   * @returns {Promise<any>} The cached data for the specified key, or `undefined` if it does not exist.
   */
  read(cache, key) {
    return get(this.cacheID, cache, key)
  }

  /**
   * Immediately writes a cache entry directly to storage skipping the batch caching queue, data will eventually be saved to the memory cache.
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key - The category to update (e.g., 'lastAni').
   * @param {Object} data The cache object to store.
   * @returns {Promise<void>} Resolves when the data has been successfully updated.
   */
  write(cache, key, data) {
    this.setEntry(cache, key, data)
    return set(this.cacheID, cache, key, data)
  }

  /**
   * Retrieves the cache entry for a specific key.
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key - The category to retrieve (e.g., 'lastAni').
   * @returns {any} The cached data for the specified key, or `undefined` if it does not exist.
   */
  getEntry(cache, key) {
    return (cache === caches.GENERAL ? this.general : cache === caches.NOTIFICATIONS ? this.notifications : this.history).value[key]
  }

  /**
   * Updates the cache for a specific key.
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key The category to update (e.g., 'lastAni').
   * @param {Object} data The cache object to store.
   */
  setEntry(cache, key, data) {
    (cache === caches.GENERAL ? this.general : cache === caches.NOTIFICATIONS ? this.notifications : this.history).update((query) => {
      const current = query[key]
      query[key] = typeof data === 'function' ? data(current) : data
      return query
    })
  }

  /**
   * Deletes a cache entry for a specific key.
   *
   * @param {keyof typeof caches} cache The name of the cache (object store).
   * @param {string} key The key to delete from the cache.
   * @returns {Promise<void>} Resolves when the entry has been successfully deleted.
   */
  async deleteEntry(cache, key) {
    const dataEntry = cache === caches.GENERAL ? this.general : cache === caches.NOTIFICATIONS ? this.notifications : cache === caches.HISTORY ? this.history : cache === caches.USER_LISTS ? this.user_lists : cache === caches.MAPPINGS ? this.mappings : cache === caches.MEDIA_CACHE ? mediaCache : null
    const store = dataEntry || this.queries
    store.update((query) => {
      const updated = { ...query }
      if (dataEntry) delete updated[key]
      else if (updated[cache.key]) {
        updated[cache.key] = { ...updated[cache.key] }
        delete updated[cache.key][key]
      }
      return updated
    })
    this.#pending.delete(`${cache.key}:${key}`)
    debug(`Deleted cache entry ${cache.key}:${key}`)
  }

  /**
   * Updates the media cache with the provided media entries.
   *
   * @param {Array<Object>} medias - An array of media objects to be cached. Each media object should have a unique identifier (`id`).
   * @param {Object} [fillLists] - An object containing user list data to attach to each media entry (e.g., `{ data: { MediaList: [...] } }`)
   * @returns {Promise<void>} Resolves when the media cache has been successfully updated.
   */
  async updateMedia(medias, fillLists) {
    if (!medias || !medias.length) return
    const filledMedias = fillLists ? fillEntries(medias, fillLists) : medias /* attaches any alternative authorization userList information to the anilist media for tracking. */
    const mediaMap = new Map(filledMedias.map(m => [m.id, m]))
    const now = Date.now()
    mediaCache.update(current => {
      for (const [id, media] of mediaMap.entries()) {
        if (media) current[id] = { ...media, cachedAt: Date.now(), expiry: media.status === 'FINISHED' ? now + getRandomInt(7, 14) * 24 * 60 * 60 * 1_000 : now + getRandomInt(12, 24) * 60 * 60 * 1_000 }
      }
      return current
    })
  }

  /**
   * Returns media for the given ID, fetching it if missing.
   *
   * @param {number | string | null} id
   * @param {boolean} isMal
   * @returns {Promise<Object | null>}
   */
  async requestMedia(id, isMal = false) {
    if (!id || !isValidNumber(Number(id))) return null
    const exactId = Number(id)
    const media = isMal ? Object.values(mediaCache.value).find(media => media.idMal === exactId) : mediaCache.value[id]
    if (media) return media
    if (!this.anilistClient) {
      const { anilistClient } = await import('@/modules/providers/anilist/anilist.js')
      this.anilistClient = anilistClient
    }
    if (isMal) return (await this.anilistClient.searchIDSingle({ idMal: exactId })).data.Media // TODO: need to add a requestMediaID in myanimelist.js...
    else return this.anilistClient.requestMediaID(exactId)
  }

  /**
   * Returns cached media for the given ID, no attempt is made to fetch the media if it's not found.
   *
   * @param {number | string | null} id
   * @returns {Object | null}
   */
  getMedia(id) {
    if (!id || !isValidNumber(Number(id))) return null
    return mediaCache.value[Number(id)] ?? {}
  }

  /**
   * Retrieves a cached entry by its key, optionally ignoring the expiration time.
   *
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key - The unique key identifying the cached entry.
   * @param {boolean} [ignoreExpiry=false] - If true, the entry will be returned even if it has expired, defaults to `false`; meaning expired entries will not be returned.
   * @returns {Promise<Object|null>} The cached entry if found and valid; otherwise, `null`.
   */
  cachedEntry(cache, key, ignoreExpiry) {
    if (this.#pending.has(`${cache.key}:${key}`) && !ignoreExpiry) {
      debug(`Found pending query ${cache.key} for ${key}`)
      return this.#pending.get(`${cache.key}:${key}`)
    } else if (cache !== caches.MAPPINGS) {
      const cachedEntry = cache === caches.USER_LISTS ? this.user_lists.value[key] : (this.queries.value[cache.key] || {})[key]
      if (cachedEntry && cachedEntry.data && ((Date.now() < cachedEntry.expiry) || ignoreExpiry)) {
        debug(`Found cached ${cache.key} for ${key}`)
        const data = deepClone(cachedEntry.data)
        if (cache !== caches.RECOMMENDATIONS || this.general.value.settings.queryComplexity === 'Complex') { /* Remap media id's to their respective media in the cache */
          if (data.data?.Page?.media) data.data.Page.media = data.data.Page.media.map(mediaId => mediaCache.value[mediaId])
          if (data.data?.Media) data.data.Media = mediaCache.value[data.data.Media]
          if (data.data?.MediaListCollection && !key?.includes('token')) data.data.MediaListCollection.lists = (data.data.MediaListCollection.lists || []).map(list => ({ ...list, entries: list.entries.map(entry => ({ ...entry, media: mediaCache.value[entry.media] })) }))
        }
        return Promise.resolve(data)
      }
      return null
    } else {
      const cachedEntry = this.mappings.value[key]
      if (cachedEntry && cachedEntry.data && ((Date.now() < cachedEntry.expiry) || ignoreExpiry)) {
        return Promise.resolve(deepClone(cachedEntry.data))
      }
      return null
    }
  }

  /**
   * Caches an entry with the specified key, variables, data, and expiry time.
   * Only one instance of the function will be run, subsequent identical calls will return the initial call.
   *
   * @param {keyof typeof caches} cache - The name of the cache (object store).
   * @param {string} key - The unique key to identify the cached entry.
   * @param {Object} [vars] - The variables associated with the cached data if applicable, this can include filters, query parameters, or context-specific data.
   * @param {Object} data - The data to be cached, this is the primary content to store for the key. Preferably this should be a promise as it will be handled before caching.
   * @param {number} expiry - The expiration timestamp for the cache entry in milliseconds since the epoch, once the current time exceeds this value the entry is considered expired.
   * @returns {Promise<Object>} A promise that resolves when the caching operation is complete.
   *
   */
  async cacheEntry(cache, key, vars, data, expiry) {
    if (this.#pending.has(`${cache.key}:${key}`)) {
      debug(`Found pending query ${cache.key} for ${key} during cache update...`)
      return this.#pending.get(`${cache.key}:${key}`)
    }
    const { fillLists, ...variables } = vars || {}
    const promiseData = (async () => {
      let res
      try {
        res = await data
      } catch (error) {
        debug(`Detected an error in the promised data, returning cached data if available.`, error)
        return this.cachedEntry(cache, key, true)
      }
      const cacheRes = deepClone(res)
      if (this.status?.value?.match(/offline/i) || (!variables?.mappings && (!res || ((res.errors?.length > 0) && !res.errors?.[0]?.title?.match(/record not found/i))))) return this.cachedEntry(cache, key, true) || res
      if (cache !== caches.RECOMMENDATIONS || this.general.value.settings.queryComplexity === 'Complex') {
        if (res?.data?.Page?.media) {
          cacheRes.data.Page.media = cacheRes.data.Page.media.map(media => media.id)
          await this.updateMedia(res.data.Page.media, await fillLists)
        } else if (res?.data?.Media) {
          cacheRes.data.Media = cacheRes.data.Media.id
          await this.updateMedia([res.data.Media], await fillLists)
        } else if (res?.data?.MediaListCollection && !variables.token) {
          const lists = res.data.MediaListCollection.lists || []
          cacheRes.data.MediaListCollection = { ...res.data.MediaListCollection, lists: lists.map(list => ({ ...list, entries: list.entries.map(entry => ({ ...entry, media: entry.media.id })) })) }
          await this.updateMedia(lists.flatMap(list => list.entries.map(entry => entry.media)))
        }
      }
      this.#update(cache, key, { data: cacheRes, expiry, cachedAt: Date.now() })
      return res
    })()
    this.#pending.set(`${cache.key}:${key}`, promiseData)
    promiseData.finally(() => this.#pending.delete(`${cache.key}:${key}`))
    return promiseData
  }
}

export let cache = new Cache()

/**
 * Ensures that the cache system has finished initializing before use.
 * THIS MUST BE CALLED BEFORE ACCESSING {@link cache}.
 *
 * @returns {Promise<void>} A promise that resolves once the cache is fully initialized and ready to use.
 */
export function cacheReady() {
  return cache.isReady
}

/**
 * Mapping from MyAnimeList status values to AniList status values.
 * Keys are MAL statuses, values are AniList equivalents.
 */
const MAL_TO_ANILIST = {
  watching: 'CURRENT',
  rewatching: 'REPEATING', /* rewatching is determined by is_rewatching boolean (no individual list) */
  plan_to_watch: 'PLANNING',
  completed: 'COMPLETED',
  dropped: 'DROPPED',
  on_hold: 'PAUSED'
}

/**
 * Mapping from AniList status values to MyAnimeList status values.
 * Generated automatically from {@link MAL_TO_ANILIST}, with 'REPEATING' mapped to 'watching'.
 */
const ANILIST_TO_MAL = Object.fromEntries(Object.entries(MAL_TO_ANILIST).map(([mal, ani]) => [ani, mal === 'rewatching' ? 'watching' : mal]))

/**
 * Maps anime status between MyAnimeList and AniList (bidirectional).
 *
 * @param {string} status - The status to map.
 * @returns {string|undefined} The mapped status, or undefined if not recognized.
 */
export function mapStatus(status) {
  return MAL_TO_ANILIST[status] ?? ANILIST_TO_MAL[status]
}

/**
 * Fills the queried AniList media entries with additional user list data from alternate authorizations (e.g., MyAnimeList).
 *
 * This function attaches user-specific data to each AniList media entry, such as progress, status, start/completion dates,
 * and custom list information, by matching the media's ID with entries from the provided user lists.
 *
 * @param {Array<Object>} medias - An array of AniList media objects to be filled with user list data.
 * @param {Object} userLists - The user list data, containing entries from alternate authorizations like MyAnimeList.
 * @param {Object} userLists.data - The user list data structure containing a list of media entries.
 * @param {Array<Object>} userLists.data.MediaList - An array of media list entries from alternate authorizations.
 * @returns {Array<Object>} The updated array of AniList media objects with attached user list data.
 */
function fillEntries(medias, userLists) {
  debug(`Filling MyAnimeList entry data for ${medias?.length} media(s)`)
  const malEntries = userLists?.data?.MediaList || []
  const malMap = new Map(malEntries.map(({ node }) => [node.id, node.my_list_status]))
  return medias.map(media => {
    const status = malMap.get(media.idMal)
    if (!status) return media

    const startDate = status.start_date ? new Date(status.start_date) : undefined
    const finishDate = status.finish_date ? new Date(status.finish_date) : undefined
    const startedAt = startDate ? { year: startDate.getFullYear(), month: startDate.getMonth() + 1, day: startDate.getDate() } : undefined
    const completedAt = finishDate ? { year: finishDate.getFullYear(), month: finishDate.getMonth() + 1, day: finishDate.getDate() } : undefined
    media.mediaListEntry = {
      id: media.id,
      progress: status.num_episodes_watched,
      repeat: status.number_times_rewatched,
      status: mapStatus(status.is_rewatching ? 'rewatching' : status.status),
      customLists: [],
      score: status.score,
      startedAt,
      completedAt
    }
    return media
  })
}