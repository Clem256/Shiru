<script>
    import Card from '@/components/cards/Card.svelte'
    import Helper from '@/modules/providers/helper.js'
    import {
        Tv,
        BookOpen,
        CheckCircle2,
        Bookmark,
        PlayCircle,
        ArrowDownUp,
        SlidersHorizontal,
        RotateCcw,
        Search,
        X
    } from 'lucide-svelte'

    export let type = 'ANIME'

    let selectedStatus = 'CURRENT'
    let selectedFormat = 'ALL'
    let selectedSort = 'UPDATED_TIME_DESC'
    let sortAscending = false
    let searchQuery = ''
    let lists = []
    let loading = true

    $: statusTabs = [
        { key: 'CURRENT', label: type === 'MANGA' ? 'Reading' : 'Watching', icon: PlayCircle },
        { key: 'PLANNING', label: type === 'MANGA' ? 'Plan to Read' : 'Plan to Watch', icon: Bookmark },
        { key: 'COMPLETED', label: 'Completed', icon: CheckCircle2 }
    ]

    $: formatOptions = type === 'MANGA'
        ? [
            { key: 'ALL', label: 'All Formats' },
            { key: 'MANGA', label: 'Manga' },
            { key: 'NOVEL', label: 'Light Novel' },
            { key: 'ONE_SHOT', label: 'One-Shot' }
        ]
        : [
            { key: 'ALL', label: 'All Formats' },
            { key: 'TV', label: 'TV' },
            { key: 'MOVIE', label: 'Movie' },
            { key: 'TV_SHORT', label: 'TV Short' },
            { key: 'OVA', label: 'OVA' },
            { key: 'ONA', label: 'ONA' },
            { key: 'SPECIAL', label: 'Special' }
        ]

    $: sortOptions = [
        { key: 'UPDATED_TIME_DESC', label: 'Last Updated' },
        { key: 'TITLE', label: 'Title (A-Z)' },
        { key: 'SCORE_DESC', label: 'Your Score' },
        { key: 'PROGRESS_DESC', label: type === 'MANGA' ? 'Chapters Read' : 'Episodes Watched' },
        ...(selectedStatus !== 'PLANNING' ? [{ key: 'STARTED_ON_DESC', label: 'Start Date' }] : []),
        ...(selectedStatus === 'COMPLETED' ? [{ key: 'FINISHED_ON_DESC', label: 'Completed Date' }] : [])
    ]

    // Fetch and resolve lists according to media type (ANIME or MANGA)
    async function loadLists(mediaType) {
        loading = true
        lists = []
        try {
            const fetcher = mediaType === 'MANGA'
                ? Helper.userMangaLists({ sort: 'UPDATED_TIME_DESC' })
                : Helper.userLists({ sort: 'UPDATED_TIME_DESC' })

            const res = await fetcher
            if (res?.data) {
                if (Helper.isAniAuth()) {
                    lists = res.data.MediaListCollection?.lists || []
                } else {
                    const rawList = res.data.MediaList || []
                    lists = ['CURRENT', 'PLANNING', 'COMPLETED'].map(status => ({
                        status,
                        entries: rawList
                            .filter(({ node }) => Helper.statusMap(node?.my_list_status?.status) === status)
                            .map(({ node }) => ({ media: node }))
                    }))
                }
            }
        } catch (err) {
            console.error('Failed to load user lists:', err)
        } finally {
            loading = false
        }
    }

    $: loadLists(type)

    $: activeList = lists.find(l => l.status === selectedStatus)?.entries || []

    $: filteredEntries = (() => {
        let result = activeList.filter(entry => {
            const media = entry.media || entry.node
            const titles = [
                media?.title?.userPreferred,
                media?.title?.romaji,
                media?.title?.english,
                media?.title?.native,
                typeof media?.title === 'string' ? media.title : ''
            ].filter(Boolean).map(t => t.toLowerCase())

            if (searchQuery.trim()) {
                const query = searchQuery.toLowerCase().trim()
                const matches = titles.some(t => t.includes(query))
                if (!matches) return false
            }

            if (selectedFormat !== 'ALL') {
                const mediaFormat = media?.format?.toUpperCase()
                if (mediaFormat !== selectedFormat) return false
            }

            return true
        })

        // 3. Tri
        result.sort((a, b) => {
            const mediaA = a.media || a.node
            const mediaB = b.media || b.node
            const entryA = mediaA?.mediaListEntry || a.mediaListEntry || {}
            const entryB = mediaB?.mediaListEntry || b.mediaListEntry || {}

            let diff = 0
            switch (selectedSort) {
                case 'TITLE': {
                    const titleA = (mediaA?.title?.userPreferred || mediaA?.title?.romaji || mediaA?.title || '').toLowerCase()
                    const titleB = (mediaB?.title?.userPreferred || mediaB?.title?.romaji || mediaB?.title || '').toLowerCase()
                    diff = titleA.localeCompare(titleB)
                    break
                }
                case 'SCORE_DESC':
                    diff = (entryB?.score || 0) - (entryA?.score || 0)
                    break
                case 'PROGRESS_DESC':
                    diff = (entryB?.progress || 0) - (entryA?.progress || 0)
                    break
                case 'STARTED_ON_DESC': {
                    const valA = (entryA?.startedAt?.year || 0) * 10000 + (entryA?.startedAt?.month || 0) * 100 + (entryA?.startedAt?.day || 0)
                    const valB = (entryB?.startedAt?.year || 0) * 10000 + (entryB?.startedAt?.month || 0) * 100 + (entryB?.startedAt?.day || 0)
                    diff = valB - valA
                    break
                }
                case 'FINISHED_ON_DESC': {
                    const valA = (entryA?.completedAt?.year || 0) * 10000 + (entryA?.completedAt?.month || 0) * 100 + (entryA?.completedAt?.day || 0)
                    const valB = (entryB?.completedAt?.year || 0) * 10000 + (entryB?.completedAt?.month || 0) * 100 + (entryB?.completedAt?.day || 0)
                    diff = valB - valA
                    break
                }
                case 'UPDATED_TIME_DESC':
                default:
                    diff = (entryB?.updatedAt || 0) - (entryA?.updatedAt || 0)
                    break
            }

            return sortAscending ? -diff : diff
        })

        return result
    })()

    function resetFilters() {
        searchQuery = ''
        selectedFormat = 'ALL'
        selectedSort = 'UPDATED_TIME_DESC'
        sortAscending = false
    }
</script>

<div class='container-fluid p-20 h-full overflow-y-auto'>
    <div class='d-flex flex-wrap align-items-center justify-content-between mb-20' style='gap: 1.2rem;'>
        <div class='d-flex align-items-center' style='gap: 1rem;'>
            {#if type === 'MANGA'}
                <BookOpen size='2.4rem' class='text-primary' />
                <h1 class='font-size-24 font-weight-bold m-0'>Manga & Novel Library</h1>
            {:else}
                <Tv size='2.4rem' class='text-primary' />
                <h1 class='font-size-24 font-weight-bold m-0'>Anime Library</h1>
            {/if}
        </div>

        <div class='position-relative' style='width: 100%; max-width: 360px;'>
            <Search size='1.8rem' class='position-absolute text-muted' style='top: 50%; left: 1.2rem; transform: translateY(-50%);' />
            <input
                    type='search'
                    class='form-control bg-dark-light text-white rounded pl-40 pr-35'
                    placeholder={type === 'MANGA' ? 'Search manga, light novels...' : 'Search anime titles...'}
                    bind:value={searchQuery}
            />
            {#if searchQuery}
                <button
                        type='button'
                        class='btn btn-square position-absolute border-0 bg-transparent text-muted'
                        style='top: 50%; right: 0.5rem; transform: translateY(-50%);'
                        on:click={() => searchQuery = ''}>
                    <X size='1.4rem' />
                </button>
            {/if}
        </div>
    </div>

    <div class='d-flex flex-wrap align-items-center justify-content-between mb-15' style='gap: 0.8rem;'>
        <div class='d-flex flex-wrap' style='gap: 0.8rem;'>
            {#each statusTabs as tab}
                {@const count = (lists.find(l => l.status === tab.key)?.entries || []).length}
                <button
                        class='btn btn-rounded px-15 py-5 d-flex align-items-center border-0'
                        style='gap: 0.6rem;'
                        class:bg-primary={selectedStatus === tab.key}
                        class:text-white={selectedStatus === tab.key}
                        class:bg-dark-light={selectedStatus !== tab.key}
                        type='button'
                        on:click={() => selectedStatus = tab.key}>
                    <svelte:component this={tab.icon} size='1.4rem' />
                    <span>{tab.label} ({count})</span>
                </button>
            {/each}
        </div>

        {#if !loading}
            <span class='text-muted font-size-13'>
                Showing <b>{filteredEntries.length}</b> of <b>{activeList.length}</b>
            </span>
        {/if}
    </div>

    <div class='d-flex flex-wrap align-items-center justify-content-between bg-dark-light rounded p-10 mb-20' style='gap: 1rem;'>
        <div class='d-flex flex-wrap align-items-center' style='gap: 0.5rem;'>
            <SlidersHorizontal size='1.4rem' class='text-muted mr-5' />
            {#each formatOptions as opt}
                <button
                        type='button'
                        class='btn btn-sm btn-rounded px-12 py-3 border-0 font-size-12'
                        class:bg-primary={selectedFormat === opt.key}
                        class:text-white={selectedFormat === opt.key}
                        class:bg-very-dark={selectedFormat !== opt.key}
                        on:click={() => selectedFormat = opt.key}>
                    {opt.label}
                </button>
            {/each}
        </div>

        <div class='d-flex align-items-center' style='gap: 0.6rem;'>
            <select class='form-control form-control-sm bg-very-dark text-white border-0 rounded px-10' bind:value={selectedSort} style='width: auto; min-width: 140px;'>
                {#each sortOptions as sortOpt}
                    <option value={sortOpt.key}>{sortOpt.label}</option>
                {/each}
            </select>

            <button
                    type='button'
                    class='btn btn-sm btn-square bg-very-dark rounded border-0 text-white'
                    title={sortAscending ? 'Ascending' : 'Descending'}
                    on:click={() => sortAscending = !sortAscending}>
                <ArrowDownUp size='1.4rem' class={sortAscending ? 'text-primary' : 'text-muted'} />
            </button>

            {#if searchQuery || selectedFormat !== 'ALL' || selectedSort !== 'UPDATED_TIME_DESC' || sortAscending}
                <button
                        type='button'
                        class='btn btn-sm btn-square bg-very-dark rounded border-0 text-danger'
                        title='Reset filters'
                        on:click={resetFilters}>
                    <RotateCcw size='1.3rem' />
                </button>
            {/if}
        </div>
    </div>

    {#if loading}
        <div class='text-center p-30 text-muted'>Loading your list...</div>
    {:else if filteredEntries.length === 0}
        <div class='text-center p-30 text-muted bg-dark-light rounded d-flex flex-column align-items-center' style='gap: 1rem;'>
            <div>No titles found with the current filters.</div>
            {#if searchQuery || selectedFormat !== 'ALL'}
                <button type='button' class='btn btn-sm btn-primary' on:click={resetFilters}>
                    Clear Filters
                </button>
            {/if}
        </div>
    {:else}
        <div class='cards-grid'>
            {#each filteredEntries as entry (entry.media?.id || entry.node?.id)}
                {@const mediaItem = entry.media || entry.node}
                <div class='card-wrapper'>
                    <div class='w-full h-full card-container'>
                        <Card
                                card={{
                                type: 'small',
                                data: Promise.resolve(mediaItem)
                            }}
                                variables={{ section: type === 'MANGA' ? 'Manga' : 'Anime' }}
                        />
                    </div>
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .pl-40 {
        padding-left: 4rem !important;
    }

    .pr-35 {
        padding-right: 3.5rem !important;
    }

    .cards-grid {
        display: grid;
        gap: 15px;
        grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
        margin-bottom: 20px;
    }

    .card-wrapper {
        min-width: 0;
    }

    .card-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        height: 100%;
    }

    .card-container :global(.card),
    .card-container :global(a),
    .card-container :global(.image-container) {
        width: 100% !important;
    }

    .card-container :global(img) {
        width: 100% !important;
        aspect-ratio: 2 / 3;
        object-fit: cover;
    }
</style>