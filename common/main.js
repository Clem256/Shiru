import 'quartermoon/css/quartermoon-variables.css'
import '@fontsource-variable/nunito'
import { cacheReady, migrationStatus } from '@/modules/cache.js'
import '@/css.css'
import '@/themes.css'
import '@/typography.css'

let migration = null
const unsubscribe = migrationStatus.subscribe(value => {
  if (value !== null && !migration) {
    import('./Migration.svelte').then(({ default: Migration }) => {
      migration = new Migration({ target: document.body })
    })
  }
})

await cacheReady()
unsubscribe()
if (migration) {
  migration.$set({ done: true })
  setTimeout(() => migration.$destroy(), 1_050)
}

const { default: App } = await import('./App.svelte')
new App({ target: document.body })