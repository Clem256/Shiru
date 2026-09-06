<script>
  import HomeSection from '@/routes/home/components/HomeSection.svelte'
  import Banner from '@/components/banner/Banner.svelte'
  import { anilistClient, currentSeason, currentYear } from '@/modules/providers/anilist/anilist.js'
  import { settings } from '@/modules/settings.js'
  import { manager as _manager } from '@/modules/sections.js'
  import { writable } from 'simple-store-svelte'
  import { Tv, BookOpen } from 'lucide-svelte'

  const manager = _manager

  let currentTab = 'ANIME'

  const bannerData = writable(getTitles(false, currentTab))

  function isMangaSection(section) {
    if (section.type === 'MANGA') return true
    const title = section.title || ''
    return title.includes('Manga') || title === 'Reading List'
  }

  function switchTab(tab) {
    if (currentTab === tab) return
    currentTab = tab
    getTitles(true, tab)
  }

  // Refresh banner every 5 minutes
  setInterval(() => getTitles(true, currentTab), 5 * 60 * 1_000)

  async function getTitles(refresh, tab = currentTab) {
    let res
    if (tab === 'MANGA') {
      res = anilistClient.searchManga({
        sort: 'TRENDING_DESC',
        perPage: 50,
        onList: false,
        status_not: 'NOT_YET_RELEASED'
      })
    } else {
      res = anilistClient.search({
        method: 'Search',
        ...(settings.value.adult === 'hentai' && settings.value.hentaiBanner ? { genre: ['Hentai'] } : {}),
        sort: 'TRENDING_DESC',
        perPage: 50,
        onList: false,
        ...(settings.value.adult !== 'hentai' || !settings.value.hentaiBanner ? { season: currentSeason } : {}),
        year: currentYear,
        status_not: 'NOT_YET_RELEASED'
      })
    }

    if (refresh) {
      const renderData = await res
      bannerData.set(Promise.resolve(renderData))
    } else {
      return res
    }
  }

  const isPreviousRSS = (i) => {
    let index = i - 1
    while (index >= 0) {
      if (!manager.sections[index]?.hide) return manager.sections[index]?.isRSS ?? false
      else if ((index - 1 >= 0) && manager.sections[index - 1]?.isRSS) return true
      index--
    }
    return false
  }
</script>

<div class='h-full w-full overflow-y-scroll root overflow-x-hidden'>
  <Banner data={$bannerData} />

  <div class='d-flex justify-content-center align-items-center mt-20 mb-10 tab-wrapper'>
    <div class='btn-group bg-dark-light rounded-pill p-5'>
      <button
              class='btn btn-rounded px-20 py-5 border-0 d-flex align-items-center font-weight-semi-bold tab-btn'
              style='gap: 0.8rem;'
              class:bg-primary={currentTab === 'ANIME'}
              class:text-white={currentTab === 'ANIME'}
              class:text-muted={currentTab !== 'ANIME'}
              type='button'
              on:click={() => switchTab('ANIME')}>
        <Tv size='1.6rem' />
        <span>Anime</span>
      </button>

      <button
              class='btn btn-rounded px-20 py-5 border-0 d-flex align-items-center font-weight-semi-bold tab-btn'
              style='gap: 0.8rem;'
              class:bg-primary={currentTab === 'MANGA'}
              class:text-white={currentTab === 'MANGA'}
              class:text-muted={currentTab !== 'MANGA'}
              type='button'
              on:click={() => switchTab('MANGA')}>
        <BookOpen size='1.6rem' />
        <span>Manga & Novels</span>
      </button>
    </div>
  </div>

  <div class='d-flex flex-column h-full w-full mt-15'>
    {#each manager.sections as section, i (section.title || i)}
      {@const manga = isMangaSection(section)}
      {#if !section.hide && ((currentTab === 'MANGA' && manga) || (currentTab === 'ANIME' && !manga))}
        <HomeSection bind:opts={section} index={i} lastEpisode={isPreviousRSS(i)}/>
      {/if}
    {/each}
  </div>
</div>

<style>
  .tab-wrapper {
    position: relative;
    z-index: 5;
  }

  .tab-btn {
    transition: background-color 0.2s ease, color 0.2s ease;
    cursor: pointer;
  }
</style>