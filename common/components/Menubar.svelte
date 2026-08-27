<script>
  import { ELECTRON, COMMON } from '@/modules/bridge.js'
  import { persisted } from 'svelte-persisted-store'
  import { SUPPORTS } from '@/modules/support.js'
  import { onMount } from 'svelte'

  export let primary = true

  const debug = persisted('debug', '', { serializer: { parse: e => e, stringify: e => e } })
  let fullScreen = false

  function tagScrollbarOffsets(root = document.body) {
    root.querySelectorAll('*').forEach(el => {
      if (!(el instanceof HTMLElement)) return
      if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== 'visible') {
        const offset = Math.max(0, 28 - el.getBoundingClientRect().top)
        el.style.setProperty('--scrollbar-title-offset', offset ? `${offset}px` : '0px')
      }
    })
  }

  onMount(() => {
    ELECTRON.isFullScreen().then(isFullScreen => {
      fullScreen = isFullScreen
      ELECTRON.onFullScreen((isFullScreen) => fullScreen = isFullScreen)
    })
    if (!SUPPORTS.isAndroid) {
      tagScrollbarOffsets()
      new MutationObserver(() => tagScrollbarOffsets()).observe(document.body, { childList: true, subtree: true })
      window.addEventListener('resize', () => tagScrollbarOffsets())
    }
  })
</script>

<div class='w-full z-101 navbar bg-transparent border-0 p-0 d-none draggable' class:d-flex={!SUPPORTS.isAndroid && !fullScreen} class:position-absolute={!primary} class:ml-sb={!SUPPORTS.isAndroid && primary && (COMMON.getPlatformInfo().platform !== 'darwin' || fullScreen)}>
  <div class='controls-container d-none position-absolute top-0 {COMMON.getPlatformInfo().platform !== `darwin` ? `right-0 ${COMMON.getPlatformInfo().platform === `win32` ? `right-width-win` : `right-width-linux`}` : `left-0 left-width`} h-full' class:mr-sb={!SUPPORTS.isAndroid && primary && COMMON.getPlatformInfo().platform !== 'darwin'} class:d-flex={!SUPPORTS.isAndroid && !fullScreen}/>
</div>
<div class='z-100 position-absolute pointer-events-none' style="inset: 0 var(--safe-area-navigation-right) auto auto; overflow: hidden; width: 18rem; height: 18rem;">
  <div class='ribbon text-center font-size-16 font-weight-bold' class:d-none={!$debug}>DEBUG</div>
</div>

<style>
  .ribbon {
    transform: translate(29.3%) rotate(45deg);
    background: var(--accent-color);
    box-shadow: 0 0 0 10rem var(--accent-color);
    clip-path: inset(0 -100%);
    opacity: 0.7;
    transform-origin: 0 0;
  }
  .draggable {
    -webkit-app-region: drag;
    color: var(--dm-text-muted-color);
    font-size: 11.2px;
    width: calc(env(titlebar-area-width, 100%) - 1px);
  }
  .navbar {
    left: unset !important;
    --navbar-height: 28px !important;
  }
  @media (pointer: none), (pointer: coarse) {
    .navbar {
      display: none !important;
      height: 0;
    }
  }
  .controls-container {
    -webkit-app-region: no-drag;
    backdrop-filter: blur(8px);
    background: rgba(24, 24, 24, 0.2);
  }
  .ml-sb {
    margin-left: var(--sidebar-width);
  }
  .mr-sb {
    margin-right: var(--sidebar-width);
  }
  .right-width-win {
    width: 137px;
  }
  .right-width-linux {
    width: 97px;
  }
  .left-width {
    width: 67px;
    border-bottom-right-radius: var(--rounded-2-border-radius);
  }
</style>