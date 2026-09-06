<script>
  import { formatMap, genreIcons, play, getEpisodeMetadataForMedia, getKitsuMappings, getMediaMaxEp } from '@/modules/anime/anime.js'
  import { copyToClipboard } from '@/modules/lib/clipboard.js'
  import { settings } from '@/modules/settings.js'
  import { mediaCache, fromCache } from '@/modules/cache.js'
  import { anilistClient } from '@/modules/providers/anilist/anilist.js'
  import { click } from '@/modules/lib/click.js'
  import Details from '@/modals/details/components/Details.svelte'
  import EpisodeList from '@/modals/details/components/EpisodeList.svelte'
  import ToggleList from '@/modals/details/components/ToggleList.svelte'
  import Scoring from '@/components/Scoring.svelte'
  import TrailerModal from '@/modals/TrailerModal.svelte'
  import SmartImage from '@/components/visual/SmartImage.svelte'
  import AudioLabel from '@/components/AudioLabel.svelte'
  import Following from '@/modals/details/components/Following.svelte'
  import { COMMON } from '@/modules/bridge.js'
  import SmallCard from '@/components/cards/SmallCard.svelte'
  import SmallCardSk from '@/components/skeletons/SmallCardSk.svelte'
  import SoftModal from '@/components/modals/SoftModal.svelte'
  import Helper from '@/modules/providers/helper.js'
  import { resizeObserver } from '@/modules/util.js'
  import { modal } from '@/modules/navigation.js'
  import DOMPurify from 'dompurify'
  import { marked } from 'marked'
  import { Clapperboard, Users, Heart, Play, Timer, TrendingUp, Tv, Hash, ArrowDown01, ArrowUp10, X, BookOpen, Bookmark } from 'lucide-svelte'

  $: view = $modal[modal.ANIME_DETAILS]?.data
  function close () {
    modal.close(modal.ANIME_DETAILS)
  }

  let container = null
  let staticMedia
  $: media = view ? fromCache($mediaCache, view?.id === media?.id ? media : (mediaCache.value[view?.id] ?? view)) : null
  $: {
    if (media && (!staticMedia || staticMedia?.id !== media?.id)) staticMedia = media
    else if (!media && staticMedia) staticMedia = null
  }

  $: isManga = staticMedia?.type === 'MANGA' || ['MANGA', 'NOVEL', 'ONE_SHOT'].includes(staticMedia?.format)
  $: isNovel = staticMedia?.format === 'NOVEL'

  $: episodeOrder = !staticMedia
  $: watched = media?.mediaListEntry?.status === 'COMPLETED'
  $: hasSpoiler = $settings.spoilerStatus.includes(media?.mediaListEntry?.status ?? 'NOTONLIST')
  $: userProgress =  ['CURRENT', 'REPEATING', 'PAUSED', 'DROPPED'].includes(media?.mediaListEntry?.status) && media?.mediaListEntry?.progress
  $: missingIds = staticMedia && []
  $: recommendations = staticMedia && anilistClient.recommendations({ id: staticMedia.id })

  $: searchIDS = staticMedia && (async () => {
    const targetType = isManga ? 'MANGA' : 'ANIME'
    const searchIDS = [
      ...(staticMedia.relations?.edges?.filter(({ node }) => node.type === targetType).map(({ node }) => node.id) || []),
      ...((await recommendations)?.data?.Media?.recommendations?.edges?.map(({ node }) => node.mediaRecommendation?.id) || [])
    ]
    if (searchIDS.length === 0) {
      missingIds = searchIDS.filter(id => !mediaCache.value[id])
      return Promise.resolve([])
    }
    const result = await anilistClient.searchAllIDS({ page: 1, perPage: 50, id: searchIDS })
    missingIds = searchIDS.filter(id => !mediaCache.value[id])
    return Promise.resolve({
      ...result,
      data: {
        ...result.data,
        Page: {
          ...result.data.Page,
          media: (result?.data?.Page?.media || []).filter(media => mediaCache.value[media.id])
        }
      }
    })
  })()

  $: staticMedia && ((container && container.scrollTo({ top: 0, behavior: 'smooth' })))

  function getActionText (media, mangaMode) {
    const entry = media?.mediaListEntry
    if (mangaMode) {
      if (entry?.progress || entry?.progressVolumes) {
        return entry.status === 'COMPLETED' ? 'Reread Now' : 'Continue Reading'
      }
      return 'Read Now'
    }
    if (entry?.progress) {
      return entry.status === 'COMPLETED' ? 'Rewatch Now' : 'Continue Now'
    }
    return 'Watch Now'
  }
  $: actionButtonText = getActionText(media, isManga)

  function handleMainAction () {
    if (isManga) {
      COMMON.openURI(`https://anilist.co/manga/${staticMedia.id}`)
    } else {
      play(media)
    }
  }

  function toggleFavourite () {
    media.isFavourite = anilistClient.favourite({ id: media.id, isFavourite: !media.isFavourite })
  }

  function sanitize(body) {
    if (!body) return ''
    const cleanBody = body.trim()
            .replace(/\.\.+(?=\s*$)/gm, '.')
            .replace(/\n/g, '<br>')
            .replace(/(<br\s*\/?>){2,}/gi, '<br><br>')
            .replace(/^(<br\s*\/?>\s*)+|(<br\s*\/?>\s*)+$/gi, '')
    marked.setOptions({ pedantic: false, breaks: true, gfm: true })
    return DOMPurify.sanitize(marked.parse(cleanBody).trim(), {
      ALLOWED_TAGS: ['p', 'br', 'span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'hr', 'details', 'summary', 'input'],
      ALLOWED_ATTR: ['href', 'target', 'rel', 'title', 'src', 'alt', 'width', 'height', 'class', 'id', 'align', 'type', 'checked', 'disabled']
    })
  }

  function resetScroll(node) {
    node.scrollLeft = 0
    return {
      update() {
        node.scrollLeft = 0
      }
    }
  }

  let episodeList = []
  let episodeLoad
  $: if (episodeLoad) {
    const thisLoad = episodeLoad
    episodeLoad.then(episodes => {
      if (thisLoad !== episodeLoad) return
      episodeList = episodes ?? []
    })
  }

  let rightColumn
  const syncColumnHeights = resizeObserver((node) => {
    if (rightColumn) {
      const leftHeight = node.offsetHeight
      if (rightColumn.style.height !== `${leftHeight}px`) {
        rightColumn.style.height = `${leftHeight}px`
      }
    }
  })
</script>

<SoftModal class='m-0 w-full h-full rounded bg-very-dark pt-0 mx-sm-20 mx-md-30 scrollbar-none' bind:showModal={staticMedia} {close} id={modal.ANIME_DETAILS}>
  <button class='btn btn-square rounded-circle w-40 h-40 close pointer z-30 bg-dark-very-light top-20 right-0 position-fixed mr-navigation-safe-area d-flex align-items-center justify-content-center text-white' type='button' use:click={() => close()}>
    <X size='1.7rem' strokeWidth='3' />
  </button>
  <div bind:this={container} class='overflow-y-auto position-relative'>
    <SmartImage class='w-full cover-img anime-details position-absolute' images={[
      staticMedia.bannerImage,
      ...(!isManga && staticMedia.trailer?.id ? [
        `https://i.ytimg.com/vi/${staticMedia.trailer.id}/maxresdefault.jpg`,
        `https://i.ytimg.com/vi/${staticMedia.trailer.id}/hqdefault.jpg`] : []),
      ...(!isManga ? [
        () => getKitsuMappings(staticMedia).then(metadata => [
          metadata?.included?.[0]?.attributes?.coverImage?.original,
          metadata?.included?.[0]?.attributes?.coverImage?.large,
          metadata?.included?.[0]?.attributes?.coverImage?.small,
          metadata?.included?.[0]?.attributes?.coverImage?.tiny]),
        () => getEpisodeMetadataForMedia(staticMedia).then(metadata => metadata?.[1]?.image)] : [])]}/>
    <div class='row px-20'>
      <div class='col-lg-7 col-12 pb-10'>
        <div use:syncColumnHeights>
          <div class='d-flex flex-sm-row flex-column align-items-sm-end pb-20 mb-15'>
            <div class='cover d-flex flex-row align-items-sm-end align-items-center justify-content-center mw-full mb-sm-0 mb-20 w-full' style='max-height: 50vh;'>
              <div class='position-relative h-full'>
                <SmartImage class='rounded cover-img overflow-hidden h-full w-full' color={staticMedia?.coverImage?.color || 'var(--tertiary-color)'} images={[staticMedia.coverImage?.extraLarge, staticMedia.coverImage?.medium, './no_image_cover.jpg']}/>
                {#if !isManga}
                  <AudioLabel {media} viewAnime={true} />
                {/if}
              </div>
            </div>
            <div class='pl-sm-20 ml-sm-20'>
              <h1 class='font-weight-very-bold text-white select-all mb-0 font-scale-40'>{anilistClient.title(staticMedia)}</h1>
              <div class='d-flex flex-row font-size-18 flex-wrap mt-5'>
                {#if staticMedia.averageScore && (!hasSpoiler || !['strict', 'hermit'].includes($settings.spoilers))}
                  <div class='d-flex flex-row mt-10' title='{staticMedia.averageScore / 10} by {anilistClient.reviews(staticMedia)} reviews'>
                    <TrendingUp class='mx-10' size='2.2rem' />
                    <span class='mr-20'>
                      Rating: {staticMedia.averageScore + '%'}
                    </span>
                  </div>
                {/if}
                {#if staticMedia.format}
                  <div class='d-flex flex-row mt-10'>
                    <Tv class='mx-10' size='2.2rem' />
                    <span class='mr-20 text-capitalize'>
                      Format: {formatMap[staticMedia.format]}
                    </span>
                  </div>
                {/if}

                {#if isManga}
                  {#if staticMedia.chapters}
                    <div class='d-flex flex-row mt-10'>
                      <BookOpen class='mx-10' size='2.2rem' />
                      <span class='mr-20'>Chapters: {staticMedia.chapters}</span>
                    </div>
                  {/if}
                  {#if staticMedia.volumes}
                    <div class='d-flex flex-row mt-10'>
                      <Bookmark class='mx-10' size='2.2rem' />
                      <span class='mr-20'>Volumes: {staticMedia.volumes}</span>
                    </div>
                  {/if}
                {:else}
                  {#if staticMedia.episodes !== 1}
                    {@const maxEp = getMediaMaxEp(staticMedia)}
                    <div class='d-flex flex-row mt-10'>
                      <Clapperboard class='mx-10' size='2.2rem' />
                      <span class='mr-20'>
                        Episodes: {maxEp && maxEp !== 0 ? maxEp : '?'}
                      </span>
                    </div>
                  {:else if staticMedia.duration}
                    <div class='d-flex flex-row mt-10'>
                      <Timer class='mx-10' size='2.2rem' />
                      <span class='mr-20'>
                        Length: {staticMedia.duration + ' min'}
                      </span>
                    </div>
                  {/if}
                {/if}

                {#if staticMedia.averageScore && staticMedia.stats?.scoreDistribution && (!hasSpoiler || !['moderate', 'strict', 'hermit'].includes($settings.spoilers))}
                  <div class='d-flex flex-row mt-10'>
                    <Users class='mx-10' size='2.2rem' />
                    <span class='mr-20' title='{staticMedia.averageScore / 10} by {anilistClient.reviews(staticMedia)} reviews'>
                      Reviews: {anilistClient.reviews(staticMedia)}
                    </span>
                  </div>
                {/if}
              </div>

              <div class='d-flex flex-row flex-wrap play'>
                <button class='btn btn-lg btn-secondary w-250 text-dark font-weight-bold shadow-none border-0 d-flex align-items-center justify-content-center mr-20 mt-20' use:click={handleMainAction} disabled={staticMedia.status === 'NOT_YET_RELEASED'}>
                  {#if isManga}
                    <BookOpen class='mr-10' size='1.6rem' />
                  {:else}
                    <Play class='mr-10' fill='currentColor' size='1.6rem' />
                  {/if}
                  {actionButtonText}
                </button>
                <div class='mt-20 d-flex'>
                  {#if Helper.isAuthorized()}
                    <Scoring class='mr-10 '{media} viewAnime={!isManga} />
                  {/if}
                  {#if Helper.isAniAuth()}
                    <button class='btn bg-dark-light btn-lg btn-square d-flex align-items-center justify-content-center shadow-none border-0 mr-10' data-toggle='tooltip' data-placement='top' data-target-breakpoint='md' data-title={media.isFavourite ? 'Unfavourite' : 'Favourite'} use:click={toggleFavourite} disabled={!Helper.isAniAuth()}>
                      <div class='favourite d-flex align-items-center justify-content-center' title={media.isFavourite ? 'Unfavourite' : 'Favourite'}>
                        <Heart color={media.isFavourite ? 'var(--tertiary-color)' : 'currentColor'} fill={media.isFavourite ? 'var(--tertiary-color)' : 'transparent'} size='1.7rem' />
                      </div>
                    </button>
                  {/if}
                  {#if !isManga}
                    <TrailerModal {staticMedia} />
                  {/if}
                  <button class='btn bg-dark-light btn-lg btn-square d-none align-items-center justify-content-center shadow-none border-0 mr-10' class:d-flex={staticMedia.id} data-toggle='tooltip' data-placement='top' data-target-breakpoint='md' data-title='Share to Clipboard' use:click={() => copyToClipboard(`https://anilist.co/${isManga ? 'manga' : 'anime'}/${staticMedia.id}`, 'share URL')} on:contextmenu|preventDefault={() => COMMON.openURI(`https://anilist.co/${isManga ? 'manga' : 'anime'}/${staticMedia.id}`)}>
                    <img class='rounded w-20' src='./anilist_icon.png' alt='Anilist'>
                  </button>
                  <button class='btn bg-dark-light btn-lg btn-square d-none align-items-center justify-content-center shadow-none border-0' class:d-flex={staticMedia.idMal} data-toggle='tooltip' data-placement='top' data-target-breakpoint='md' data-title='Share to Clipboard' use:click={() => copyToClipboard(`https://myanimelist.net/${isManga ? 'manga' : 'anime'}/${staticMedia.idMal}`, 'share URL')} on:contextmenu|preventDefault={() => COMMON.openURI(`https://myanimelist.net/${isManga ? 'manga' : 'anime'}/${staticMedia.idMal}`)}>
                    <img class='rounded w-20' src='./myanimelist_icon.png' alt='MyAnimeList'>
                  </button>
                </div>
              </div>
              <Following media={staticMedia} />
            </div>
          </div>
          <Details media={staticMedia} alt={recommendations} />
          <div use:resetScroll={staticMedia?.id} class='m-0 px-20 pb-0 pt-10 d-flex flex-row text-nowrap overflow-x-scroll text-capitalize align-items-start'>
            {#each staticMedia.tags as tag}
              {#if !(hasSpoiler && ((tag.isGeneralSpoiler && ['strict', 'hermit'].includes($settings.spoilers)) || (tag.isMediaSpoiler && ['moderate', 'strict', 'hermit'].includes($settings.spoilers))))}
                <div class='bg-dark-light px-20 py-10 mr-10 rounded text-nowrap d-flex align-items-center'>
                  <Hash class='mr-5' size='1.8rem' /><span class='font-weight-bolder select-all'>{tag.name}</span><span class='font-weight-light'>: {tag.rank}%</span>
                </div>
              {/if}
            {/each}
          </div>
          <div use:resetScroll={staticMedia?.id} class='m-0 px-20 pb-0 pt-10 d-flex flex-row text-nowrap overflow-x-scroll text-capitalize align-items-start'>
            {#each staticMedia.genres as genre}
              <div class='bg-dark-light px-20 py-10 mr-10 rounded text-nowrap d-flex align-items-center select-all'><svelte:component this={genreIcons[genre]} class='mr-5' size='1.8rem' /> {genre}</div>
            {/each}
          </div>
          {#if staticMedia.description}
            <div class='w-full d-flex flex-row align-items-center pt-20 mt-10'>
              <hr class='w-full' />
              <div class='font-size-18 font-weight-semi-bold px-20 text-white'>Synopsis</div>
              <hr class='w-full' />
            </div>
            <div class='font-size-16 pt-20 select-all' class:text-spoiler={hasSpoiler && ['strict', 'hermit'].includes($settings.spoilers)}>
              {@html sanitize(staticMedia.description)}
            </div>
          {/if}

          <!-- Vue Mobile : épisodes uniquement si c'est un anime -->
          {#if !isManga}
            {#if episodeList?.length}
              <div class='w-full d-flex d-lg-none flex-row align-items-center pt-20 mt-10 pointer' aria-hidden='true' use:click={() => { episodeOrder = !episodeOrder }}>
                <hr class='w-full' />
                <div class='position-absolute font-size-18 font-weight-semi-bold px-20 text-white' style='left: 50%; transform: translateX(-50%);'>Episodes</div>
                <hr class='w-full' />
                <div class='ml-auto pl-20 font-size-12 more text-muted text-nowrap pr-20' use:click={() => { episodeOrder = !episodeOrder }}>Reverse</div>
              </div>
            {/if}
            <div class='col-lg-5 col-12 d-lg-none flex-column mt-20'>
              <EpisodeList bind:episodeList={episodeList} mobileList={true} media={staticMedia} {episodeOrder} {userProgress} {watched} {hasSpoiler} episodeCount={getMediaMaxEp(media)} {play} class='h-600' />
            </div>
          {/if}

          <div class='d-lg-block'>
            <ToggleList list={ staticMedia.relations?.edges?.filter(({ node, relationType }) => relationType !== 'CHARACTER' && node.type === (isManga ? 'MANGA' : 'ANIME') && node.format !== 'MUSIC' && !(settings.value.adult === 'none' && node.isAdult) && !(settings.value.adult !== 'hentai' && node.genres?.includes('Hentai')) && !missingIds.includes(node.id)).sort((a, b) => (a.node.seasonYear || Infinity) - (b.node.seasonYear || Infinity)) } promise={searchIDS} let:item let:promise title='Relations'>
              {#await promise}
                <div class='small-card'>
                  <SmallCardSk />
                </div>
              {:then res}
                {#if res}
                  <div class='small-card'>
                    <SmallCard data={item.node} type={item.relationType.replace(/_/g, ' ').toLowerCase()} />
                  </div>
                {/if}
              {/await}
            </ToggleList>
            {#await recommendations then res}
              {@const media = res?.data?.Media}
              {#if media}
                <ToggleList list={ media.recommendations?.edges?.filter(({ node }) => node.mediaRecommendation && !(settings.value.adult === 'none' && node.mediaRecommendation.isAdult) && !(settings.value.adult !== 'hentai' && node.mediaRecommendation.genres?.includes('Hentai')) && !missingIds.includes(node.mediaRecommendation.id)).sort((a, b) => b.node.rating - a.node.rating) } promise={searchIDS} let:item let:promise title='Recommendations'>
                  {#await promise}
                    <div class='small-card'>
                      <SmallCardSk />
                    </div>
                  {:then res}
                    {#if res}
                      <div class='small-card'>
                        <SmallCard data={item.node.mediaRecommendation} type={item.node.rating} />
                      </div>
                    {/if}
                  {/await}
                </ToggleList>
              {/if}
            {/await}
          </div>
        </div>
      </div>

      <div class='col-lg-5 col-12 d-none d-lg-flex flex-column pl-lg-20' bind:this={rightColumn}>
        {#if isManga}
          {@const unitLabel = isNovel ? 'Volumes' : 'Chapters'}
          {@const unitTag = isNovel ? 'VOL' : 'CH'}
          {@const knownUnits = isNovel ? (staticMedia.volumes || 0) : (staticMedia.chapters || (staticMedia.volumes && !staticMedia.chapters ? staticMedia.volumes : 0))}
          {@const currentProgress = isNovel ? (media?.mediaListEntry?.progressVolumes || 0) : (media?.mediaListEntry?.progress || 0)}
          {@const displayCount = knownUnits > 0 ? knownUnits : currentProgress > 0 ? currentProgress : null}

          <div class='p-20 bg-dark-light rounded h-full d-flex flex-column' style='min-height: 0; max-height: 100%;'>
            <div class='d-flex align-items-center justify-content-between mb-15 flex-shrink-0'>
              <div class='d-flex align-items-center'>
                {#if isNovel}
                  <Bookmark class='mr-10 text-primary' size='2rem' />
                {:else}
                  <BookOpen class='mr-10 text-primary' size='2rem' />
                {/if}
                <h3 class='font-size-18 font-weight-bold text-white m-0'>{unitLabel}</h3>
              </div>
              <div class='d-flex align-items-center' style='gap: 0.8rem;'>
                <span class='text-muted font-size-14'>
                  Read: <b class='text-white'>{currentProgress}</b> / {knownUnits || '?'}
                </span>
                <button
                        type='button'
                        class='btn btn-sm btn-primary px-10 py-0 font-weight-bold'
                        title={`Quick +1 ${isNovel ? 'volume' : 'chapter'}`}
                        use:click={async () => {
                    const nextVal = currentProgress + 1
                    const isFinished = knownUnits > 0 && nextVal >= knownUnits
                    const nextStatus = isFinished ? 'COMPLETED' : 'CURRENT'

                    if (Helper.isAniAuth()) {
                      await anilistClient.entry({
                        mediaId: staticMedia.id,
                        ...(isNovel ? { progressVolumes: nextVal } : { progress: nextVal }),
                        status: nextStatus
                      })
                    } else if (Helper.isMalAuth()) {
                      await Helper.getClient().entry({
                        id: staticMedia.id,
                        ...(isNovel ? { num_volumes_read: nextVal } : { num_chapters_read: nextVal }),
                        status: isFinished ? 'completed' : 'reading'
                      })
                    }

                    mediaCache.update(cache => {
                      const current = cache[staticMedia.id] || staticMedia
                      return {
                        ...cache,
                        [staticMedia.id]: {
                          ...current,
                          mediaListEntry: {
                            ...(current.mediaListEntry || {}),
                            ...(isNovel ? { progressVolumes: nextVal } : { progress: nextVal }),
                            status: nextStatus
                          }
                        }
                      }
                    })
                  }}>
                  +1
                </button>
              </div>
            </div>

            <div class='chapters-scroll-area flex-grow-1 overflow-y-auto pr-5'>
              {#if displayCount}
                <div class='chapters-grid'>
                  {#each Array.from({ length: displayCount }, (_, i) => i + 1) as unitNum}
                    {@const isRead = unitNum <= currentProgress}
                    <button
                            type='button'
                            class='btn chapter-btn d-flex flex-column align-items-center justify-content-center border-0'
                            class:read={isRead}
                            class:current={unitNum === currentProgress + 1}
                            use:click={async () => {
                        const isFinished = knownUnits > 0 && unitNum === knownUnits
                        const nextStatus = isFinished ? 'COMPLETED' : 'CURRENT'

                        if (Helper.isAniAuth()) {
                          await anilistClient.entry({
                            mediaId: staticMedia.id,
                            ...(isNovel ? { progressVolumes: unitNum } : { progress: unitNum }),
                            status: nextStatus
                          })
                        } else if (Helper.isMalAuth()) {
                          await Helper.getClient().entry({
                            id: staticMedia.id,
                            ...(isNovel ? { num_volumes_read: unitNum } : { num_chapters_read: unitNum }),
                            status: isFinished ? 'completed' : 'reading'
                          })
                        }

                        mediaCache.update(cache => {
                          const current = cache[staticMedia.id] || staticMedia
                          return {
                            ...cache,
                            [staticMedia.id]: {
                              ...current,
                              mediaListEntry: {
                                ...(current.mediaListEntry || {}),
                                ...(isNovel ? { progressVolumes: unitNum } : { progress: unitNum }),
                                status: nextStatus
                              }
                            }
                          }
                        })
                      }}>
                      <span class='chap-label'>{unitTag}</span>
                      <span class='chap-number'>{unitNum}</span>
                    </button>
                  {/each}
                </div>
              {:else}
                <div class='d-flex flex-column align-items-center justify-content-center h-full py-40 text-center'>
                  <div class='mb-15' style='opacity: 0.35;'>
                    {#if isNovel}
                      <Bookmark size='3.5rem' />
                    {:else}
                      <BookOpen size='3.5rem' />
                    {/if}
                  </div>
                  <p class='text-muted font-size-14 m-0'>
                    {isNovel ? 'Volume' : 'Chapter'} count unknown on AniList
                  </p>
                  <p class='text-muted font-size-12 mt-5 m-0'>
                    Use +1 to start tracking your progress
                  </p>
                </div>
              {/if}
            </div>

            <div class='pt-15 mt-10 border-top flex-shrink-0'>
              <button
                      type='button'
                      class='btn btn-primary w-full py-10 font-weight-bold d-flex align-items-center justify-content-center'
                      style='gap: 0.5rem;'
                      use:click={() => COMMON.openURI(`https://anilist.co/manga/${staticMedia.id}`)}>
                <span>Open on AniList</span>
              </button>
            </div>
          </div>
        {:else}
          <button class='btn btn-square rounded-circle w-40 h-40 order pointer z-30 bg-dark-very-light position-absolute d-flex align-items-center justify-content-center text-white' class:d-none={!episodeList?.length} data-toggle='tooltip' data-placement='top' data-target-breakpoint='md' data-title='Reverse Episodes' use:click={()=> {episodeOrder = !episodeOrder}}>
            <svelte:component this={episodeOrder ? ArrowDown01 : ArrowUp10} size='2rem' />
          </button>
          <EpisodeList bind:episodeLoad={episodeLoad} media={staticMedia} {episodeOrder} {userProgress} {watched} {hasSpoiler} episodeCount={getMediaMaxEp(media)} {play} />
        {/if}
      </div>
    </div>
  </div>
</SoftModal>

<style>
  .close {
    top: 4rem !important;
    left: unset !important;
    right: 4rem !important;
  }
  .order {
    top: 7rem !important;
    left: -5rem !important;
  }
  .play {
    justify-content: center;
  }
  @media (min-width: 577px) {
    .cover {
      max-width: 35% !important;
    }
    .play {
      justify-content: left;
    }
  }
  .row {
    padding-top: 12rem !important
  }
  @media (min-width: 769px) {
    .row  {
      padding: 0 10rem;
    }
  }
  .cover {
    aspect-ratio: 7/10;
  }
  .chapters-scroll-area {
    max-height: calc(100vh - 320px);
  }

  .chapters-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(65px, 1fr));
    gap: 8px;
  }

  .chapter-btn {
    background: var(--dark-very-light-color, #1f1f23);
    color: #fff;
    border-radius: 6px;
    padding: 8px 4px;
    transition: all 0.15s ease;
    min-height: 52px;
  }

  .chapter-btn:hover {
    background: var(--primary-color, #3db4f2);
    color: #fff;
    transform: translateY(-2px);
  }

  .chapter-btn.read {
    background: rgba(255, 255, 255, 0.08);
    color: rgba(255, 255, 255, 0.45);
  }

  .chapter-btn.current {
    border: 1px solid var(--primary-color, #3db4f2) !important;
    background: rgba(61, 180, 242, 0.15);
    color: var(--primary-color, #3db4f2);
  }

  .chap-label {
    font-size: 0.9rem;
    opacity: 0.6;
    line-height: 1;
  }

  .chap-number {
    font-size: 1.4rem;
    font-weight: bold;
    line-height: 1.2;
  }
</style>