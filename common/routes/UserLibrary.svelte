<script>
    import Card from '@/components/cards/Card.svelte'
    import Helper from '@/modules/providers/helper.js'
    import { Tv, BookOpen, CheckCircle2, Bookmark, PlayCircle } from 'lucide-svelte'

    export let type = 'ANIME'

    let selectedStatus = 'CURRENT'
    let searchQuery = ''
    let lists = []
    let loading = true

    $: statusTabs = [
        { key: 'CURRENT', label: type === 'MANGA' ? 'Reading' : 'Watching', icon: PlayCircle },
        { key: 'PLANNING', label: type === 'MANGA' ? 'Plan to Read' : 'Plan to Watch', icon: Bookmark },
        { key: 'COMPLETED', label: 'Completed', icon: CheckCircle2 }
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
                    // For AniList: MediaListCollection.lists
                    lists = res.data.MediaListCollection?.lists || []
                } else {
                    // For MyAnimeList: reshape into a status-keyed array
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

    // Reload automatically whenever type ('ANIME' or 'MANGA') changes
    $: loadLists(type)

    // Filter by status tab
    $: activeList = lists.find(l => l.status === selectedStatus)?.entries || []

    // Filter by search query
    $: filteredEntries = activeList.filter(entry => {
        if (!searchQuery) return true
        const media = entry.media || entry.node
        const title = media?.title?.userPreferred || media?.title?.romaji || media?.title?.english || media?.title || ''
        return title.toLowerCase().includes(searchQuery.toLowerCase())
    })
</script>

<div class='container-fluid p-20 h-full overflow-y-auto'>
    <div class='d-flex flex-wrap align-items-center justify-content-between mb-20' style='gap: 1rem;'>
        <div class='d-flex align-items-center' style='gap: 1rem;'>
            {#if type === 'MANGA'}
                <BookOpen size='2.4rem' class='text-primary' />
                <h1 class='font-size-24 font-weight-bold m-0'>Manga Library</h1>
            {:else}
                <Tv size='2.4rem' class='text-primary' />
                <h1 class='font-size-24 font-weight-bold m-0'>Anime Library</h1>
            {/if}
        </div>

        <div class='input-group' style='max-width: 300px;'>
            <input
                    type='search'
                    class='form-control bg-dark-light rounded'
                    placeholder='Search in list...'
                    bind:value={searchQuery} />
        </div>
    </div>

    <div class='d-flex mb-20' style='gap: 0.8rem;'>
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

    {#if loading}
        <div class='text-center p-20 text-muted'>Loading your list...</div>
    {:else if filteredEntries.length === 0}
        <div class='text-center p-30 text-muted bg-dark-light rounded'>
            No titles found in this category.
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