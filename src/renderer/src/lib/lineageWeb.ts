/**
 * Lineage web — the "dig engine" stage controller.
 *
 * An imperative Cytoscape graph with an HTML "module card" overlay synced each
 * frame (patch-cable edges), windowed direction pools (show 5, shuffle),
 * DIG-to-promote chaining, and a now-playing sine wave that traces the selected
 * node's path home to ORIGIN. Ported from the lineage-web-v5 reference and wired
 * to live discover() data; skinned via .cd-* CSS so it inherits Offcut's tokens.
 */

import cytoscape from 'cytoscape'
import type { Core, NodeSingular, EdgeSingular, EdgeCollection } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import type { Candidate, Direction, DiscoverResult, RouteType } from '@shared/types'

// Force-directed layout (fcose) — replaces the hand-rolled radial preset +
// O(n²) relaxation. Registered once.
let fcoseRegistered = false
if (!fcoseRegistered) {
  cytoscape.use(fcose)
  fcoseRegistered = true
}

export interface HydrateFn {
  (artist: string, title: string): { bpm: number | null; key: string | null } | null
}

/** Normalised selection surfaced to React for the detail panel. */
export interface SelNode {
  kind: 'seed' | 'dir' | 'track'
  id: string
  type?: RouteType
  title: string
  artist?: string
  bpm?: number | null
  key?: string | null
  score?: number | null
  year?: number | null
  why?: string
  candidateKey?: string | null
  discogsId?: number | null
  isOrigin?: boolean
  isHarmonic?: boolean
  /** Where the find came from — Discogs / Last.fm / MusicBrainz / 1001Tracklists. */
  source?: string
  /** Titles from ORIGIN → this node (breadcrumb home). */
  lineage: string[]
  /** For direction nodes: the current pool window. */
  dirWindow?: { from: number; to: number; total: number } | null
}

/** Which data source backs each route family. */
const ROUTE_SOURCE: Record<RouteType, string> = {
  remix: 'Discogs',
  version: 'Discogs',
  players: 'Discogs',
  label: 'Discogs',
  comp: 'Discogs',
  listener: 'Last.fm',
  deezer: 'Deezer',
  sample: 'MusicBrainz',
  set: '1001Tracklists',
  soundcloud: 'SoundCloud',
  ai: 'AI'
}

export interface LineageWebOptions {
  result: DiscoverResult
  seedMeta?: { bpm: number | null; key: string | null } | null
  hydrate: HydrateFn
  /** Enrich + discover a promoted sub-seed, preserving the origin's root key. */
  dig: (artist: string, title: string, rootSeedKey: string) => Promise<DiscoverResult | null>
  onSelect: (n: SelNode | null) => void
  /** Resolve a 30s preview URL for the ♪ quick-play button. */
  getPreviewUrl?: (artist: string, title: string) => Promise<string | null>
  /** Surface a transient status (e.g. "digging…") to the UI. */
  onStatus?: (msg: string | null) => void
}

export interface LineageWebController {
  fit: () => void
  reset: () => void
  selectByCandidateKey: (key: string) => void
  /** Patch a node's BPM/key (e.g. once a Deezer preview resolves) and refresh its card. */
  setMeta: (id: string, meta: { bpm?: number | null; key?: string | null }) => void
  /**
   * Graft a new branch (e.g. AI-suggested picks) onto an existing node, revealed.
   * `seedId` is the node to hang it off (falls back to the origin); each pick
   * becomes a track card in the branch's pool.
   */
  addBranch: (
    seedId: string | null,
    label: string,
    picks: { artist: string; title: string; why?: string }[]
  ) => void
  destroy: () => void
}

// ── helpers ────────────────────────────────────────────────────────────────

function pk(k?: string | null): { n: number; l: string } | null {
  const m = (k || '').match(/(\d+)([AB])/)
  return m ? { n: +m[1], l: m[2] } : null
}
/** Camelot adjacency: same key, or ±1 on the wheel in the same letter. */
function camelotOk(a?: string | null, b?: string | null): boolean {
  const x = pk(a)
  const y = pk(b)
  if (!x || !y) return false
  if (x.n === y.n) return true
  const d = Math.min(Math.abs(x.n - y.n), 12 - Math.abs(x.n - y.n))
  return d === 1 && x.l === y.l
}
function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  )
}

interface SeedModel {
  id: string
  artist: string
  title: string
  key: string | null
  bpm: number | null
  parentId: string | null
  rootId: string
  rootKey: string
  candidateKey: string | null
  discogsId: number | null
  year: number | null
  why: string
}
interface DirModel {
  id: string
  seedId: string
  type: RouteType
  title: string
  pool: Candidate[]
  offset: number
  expanded: boolean
  trackNodes: string[]
}

export function createLineageWeb(
  host: HTMLElement,
  opts: LineageWebOptions
): LineageWebController {
  const { hydrate, onSelect } = opts
  const col = (k: string): string => getComputedStyle(host).getPropertyValue(k).trim() || '#888'

  // ── layered DOM: cy mount · wave canvas · card overlay ───────────────────
  host.innerHTML = ''
  const mk = (z: number, tag = 'div'): HTMLElement => {
    const el = document.createElement(tag)
    el.style.cssText = `position:absolute;inset:0;z-index:${z}`
    host.appendChild(el)
    return el
  }
  const cyEl = mk(1)
  const wave = mk(2, 'canvas') as HTMLCanvasElement
  wave.style.pointerEvents = 'none'
  const ov = mk(4)
  ov.style.pointerEvents = 'none'
  ov.style.overflow = 'hidden'
  const audio = new Audio()
  audio.preload = 'none'
  // The node whose 30s preview is currently playing (or loading). Tracked by id,
  // not button element, so the play/stop toggle survives a card re-render.
  let playingId: string | null = null

  const TCOL: Record<RouteType, string> = {
    remix: col('--orange'),
    version: col('--amber'),
    label: col('--lime'),
    sample: col('--blue'),
    set: col('--amber'),
    players: col('--silver'),
    listener: col('--teal'),
    deezer: col('--peach'),
    comp: col('--orchid'),
    soundcloud: col('--coral'),
    ai: col('--violet')
  }

  const cy: Core = cytoscape({
    container: cyEl,
    minZoom: 0.3,
    maxZoom: 2.4,
    elements: [],
    style: [
      // Invisible nodes; their width/height is the card footprint so fcose keeps
      // the HTML cards from overlapping (the cards are positioned over the nodes).
      { selector: 'node', style: { opacity: 0, events: 'no', shape: 'rectangle', width: 156, height: 96 } },
      { selector: 'node[kind="dir"]', style: { width: 172, height: 54 } },
      { selector: 'edge', style: { width: 1.4, 'line-color': '#3a2f22', 'curve-style': 'bezier', opacity: 0.8 } },
      ...(Object.keys(TCOL) as RouteType[]).map((t) => ({
        selector: `edge[type="${t}"]`,
        style: { 'line-color': TCOL[t], opacity: 0.5 }
      })),
      { selector: 'edge.tk', style: { 'line-color': '#473a2a', opacity: 0.38, width: 1.1 } },
      { selector: 'edge.lineage', style: { opacity: 0 } }
    ],
    layout: { name: 'preset' }
  })
  const W = cy.width()
  const H0 = cy.height()
  const CX = W * 0.46
  const CY = H0 * 0.52

  const seeds: Record<string, SeedModel> = {}
  const dirs: Record<string, DirModel> = {}
  let originId: string | null = null // the root seed, pinned at centre by the layout
  let uidn = 0
  const uid = (p: string): string => `${p}_${++uidn}`
  const dirSeed = (d: NodeSingular): string => dirs[d.id()].seedId

  function lineage(id: string): SeedModel[] {
    const c: SeedModel[] = []
    let s: SeedModel | null = seeds[id] || null
    while (s) {
      c.unshift(s)
      s = s.parentId ? seeds[s.parentId] : null
    }
    return c
  }

  // ── card overlay ─────────────────────────────────────────────────────────
  const cards = new Map<string, HTMLElement>()
  let draggingId: string | null = null

  function cardHtml(node: NodeSingular): string {
    const k = node.data('kind') as string
    if (k === 'seed') {
      const s = seeds[node.id()]
      const origin = !s.parentId
      return `<div class="cap">${origin ? '◎ ORIGIN' : 'SEED'}</div>
        <div class="nm">${esc(s.title)}</div><div class="ar">${esc(s.artist)}</div>
        <div class="btns"><button class="mini" data-act="view">VIEW</button>${
          origin ? '' : '<button class="mini" data-act="prune">PRUNE</button>'
        }</div>`
    }
    if (k === 'dir') {
      const d = dirs[node.id()]
      const cnt = node.data('entity') ? `<span class="dcnt">${d.pool.length}</span>` : ''
      return `<span class="dn">${esc(d.title)}</span>${cnt}<button class="mini" data-act="${
        d.expanded ? 'shuffle' : 'reveal'
      }">${d.expanded ? '⤮' : '▸'}</button>`
    }
    const harm = node.hasClass('harmonic')
    const key = node.data('key')
    const bpm = node.data('bpm')
    const owned = node.data('owned') ? '<span class="own">IN CRATE</span>' : ''
    return `<div class="nm">${esc(node.data('label'))}${owned}</div><div class="ar">${esc(node.data('artist'))}</div>
      <div class="meta"><span class="kc ${harm ? 'lit' : ''}">${esc(key || '—')}</span><span class="bpm">${
        bpm ? esc(bpm) + ' BPM' : '— BPM'
      }</span></div>
      <div class="btns"><button class="mini" data-act="view">VIEW</button><button class="mini play${
        playingId === node.id() ? ' on' : ''
      }" data-act="play" title="${playingId === node.id() ? 'Stop preview' : 'Play preview'}">${
        playingId === node.id() ? '■' : '♪'
      }</button><button class="mini go" data-act="dig">DIG↘</button></div>`
  }

  function wire(el: HTMLElement, node: NodeSingular): void {
    // Raise a card above its neighbours on hover so its buttons are always
    // clickable even in a dense, overlapping cluster.
    el.onpointerenter = (): void => {
      if (!el.classList.contains('dragging')) el.style.zIndex = '30'
    }
    el.onpointerleave = (): void => {
      if (!el.classList.contains('dragging')) el.style.zIndex = ''
    }
    el.onclick = (e): void => {
      if (el.dataset.dragged === '1') return // a drag, not a click
      if (!(e.target as HTMLElement).closest('button')) select(node)
    }
    el.querySelectorAll('button[data-act]').forEach((b) => {
      ;(b as HTMLButtonElement).onclick = (e): void => {
        e.stopPropagation()
        act(node, (b as HTMLElement).dataset.act || '', b as HTMLButtonElement)
      }
    })

    // Drag-to-reposition: move the underlying node — together with its whole
    // subtree (its branches and their tracks) — so a cluster moves as one.
    el.onpointerdown = (e): void => {
      if ((e.target as HTMLElement).closest('button')) return
      const start = { x: e.clientX, y: e.clientY }
      const group = [node, ...(node.successors('node').toArray() as NodeSingular[])]
      const origins = new Map(group.map((n) => [n.id(), { ...n.position() }]))
      let moved = false
      el.dataset.dragged = '0'
      el.setPointerCapture?.(e.pointerId)
      const move = (ev: PointerEvent): void => {
        const z = Math.max(0.18, cy.zoom())
        const dx = (ev.clientX - start.x) / z
        const dy = (ev.clientY - start.y) / z
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) {
          moved = true
          el.dataset.dragged = '1'
          el.classList.add('dragging')
          draggingId = node.id()
        }
        if (moved) {
          for (const n of group) {
            const o = origins.get(n.id())
            if (o) n.position({ x: o.x + dx, y: o.y + dy })
          }
        }
      }
      const up = (): void => {
        el.removeEventListener('pointermove', move)
        el.removeEventListener('pointerup', up)
        el.classList.remove('dragging')
        if (draggingId === node.id()) draggingId = null
        // (no re-layout on drop — the manual placement is intentional)
        // clear the drag flag after the click handler has had a chance to bail
        setTimeout(() => {
          el.dataset.dragged = '0'
        }, 0)
      }
      el.addEventListener('pointermove', move)
      el.addEventListener('pointerup', up)
    }
  }
  function makeCard(node: NodeSingular): void {
    const k = node.data('kind') as string
    const el = document.createElement('div')
    el.className =
      'card ' + k + (k === 'dir' ? ' t-' + node.data('type') + (node.data('entity') ? ' entity' : '') : '')
    el.dataset.id = node.id()
    el.style.pointerEvents = 'auto'
    el.innerHTML = cardHtml(node)
    wire(el, node)
    ov.appendChild(el)
    cards.set(node.id(), el)
    requestAnimationFrame(() => el.classList.add('in'))
  }
  function refreshCard(node: NodeSingular): void {
    const el = cards.get(node.id())
    if (!el) return
    el.className =
      'card ' +
      node.data('kind') +
      (node.data('kind') === 'dir' ? ' t-' + node.data('type') + (node.data('entity') ? ' entity' : '') : '') +
      ' in'
    el.innerHTML = cardHtml(node)
    wire(el, node)
  }
  cy.on('remove', 'node', (e) => {
    const id = e.target.id()
    if (playingId === id) stopPreview() // don't leave a removed card's clip playing with no button
    const el = cards.get(id)
    if (el) el.remove()
    cards.delete(id)
  })

  function act(node: NodeSingular, a: string, btn: HTMLButtonElement): void {
    if (a === 'view') select(node)
    else if (a === 'dig') void dig(node)
    else if (a === 'reveal') {
      showTracks(node)
      select(node)
    } else if (a === 'shuffle') {
      shuffleDir(node)
      select(node)
    } else if (a === 'prune') prune(node)
    else if (a === 'play') play(node, btn)
  }

  // Reflect the play/stop state on a card's ♪ button. Looked up live from the
  // card map so it works even after the card has been re-rendered.
  function paintPlay(id: string, on: boolean): void {
    const b = cards.get(id)?.querySelector('button.play[data-act="play"]') as HTMLButtonElement | null
    if (!b) return
    b.classList.toggle('on', on)
    b.textContent = on ? '■' : '♪'
    b.title = on ? 'Stop preview' : 'Play preview'
  }
  function stopPreview(): void {
    audio.pause()
    try { audio.currentTime = 0 } catch { /* not yet loaded */ }
    if (playingId) paintPlay(playingId, false)
    playingId = null
  }
  // Clear the button when the 30s clip finishes (or errors) on its own.
  audio.onended = stopPreview
  audio.onerror = stopPreview

  function play(node: NodeSingular, _btn: HTMLButtonElement): void {
    const id = node.id()
    if (playingId === id) { stopPreview(); return } // clicking the playing track stops it
    stopPreview() // switching tracks: stop whatever was playing first
    const artist = node.data('artist') as string
    const title = node.data('label') as string
    if (!opts.getPreviewUrl || !artist) return
    playingId = id
    paintPlay(id, true) // optimistic: show stop/loading immediately
    opts
      .getPreviewUrl(artist, title)
      .then((url) => {
        if (playingId !== id) return // user stopped / switched while we were fetching
        if (url) {
          audio.src = url
          void audio.play().catch(() => stopPreview())
        } else {
          stopPreview() // no preview found — revert the button
        }
      })
      .catch(() => { if (playingId === id) stopPreview() })
  }

  // ── layout: force-directed (fcose) ────────────────────────────────────────
  // Re-run the whole-graph force layout after each expansion. randomize:false
  // seeds it from the current positions so additions settle in place rather than
  // jumping; the origin is pinned at centre. This replaces the old radial preset
  // + per-frame O(n²) relaxation (which caused the jitter/stutter).
  let running: ReturnType<Core['layout']> | null = null
  function runLayout(): void {
    if (running) {
      try { running.stop() } catch { /* ignore */ }
    }
    const layoutOpts = {
      name: 'fcose',
      quality: 'default',
      randomize: false,
      animate: true,
      animationDuration: 520,
      animationEasing: 'ease-out',
      fit: true,
      padding: 80,
      nodeDimensionsIncludeLabels: false,
      nodeRepulsion: 10500,
      // route edges (seed→direction) sit wider than track edges (direction→track)
      idealEdgeLength: (e: EdgeSingular) => (e.hasClass('tk') ? 150 : 260),
      edgeElasticity: 0.4,
      gravity: 0.32,
      gravityRange: 3.6,
      numIter: 1800,
      // keep the origin anchored at the centre so the web grows around it
      fixedNodeConstraint: originId ? [{ nodeId: originId, position: { x: CX, y: CY } }] : []
    }
    running = cy.layout(layoutOpts as never)
    running.run()
  }
  function frame(): void {
    cy.animate({ fit: { eles: cy.elements() as never, padding: 70 }, duration: 380, easing: 'ease-out-cubic' })
  }

  // ── build ────────────────────────────────────────────────────────────────
  function addSeed(
    data: {
      artist: string
      title: string
      key?: string | null
      bpm?: number | null
      candidateKey?: string | null
      discogsId?: number | null
      year?: number | null
      why?: string
    },
    parentDir: NodeSingular | null,
    rootKey: string
  ): NodeSingular {
    const id = uid('seed')
    const pSeed = parentDir ? dirSeed(parentDir) : null
    if (!pSeed) originId = id // first seed with no parent = origin
    seeds[id] = {
      id,
      artist: data.artist,
      title: data.title,
      key: data.key ?? null,
      bpm: data.bpm ?? null,
      parentId: pSeed,
      rootId: pSeed ? seeds[pSeed].rootId : id,
      rootKey: pSeed ? seeds[pSeed].rootKey : rootKey,
      candidateKey: data.candidateKey ?? null,
      discogsId: data.discogsId ?? null,
      year: data.year ?? null,
      why: data.why ?? ''
    }
    const n = cy.add({ group: 'nodes', data: { id, kind: 'seed' }, classes: 'seed' })
    makeCard(n)
    return n
  }

  function addDirections(seedNode: NodeSingular, directions: Direction[]): NodeSingular[] {
    const nodes = directions.map((d) => {
      const id = uid('dir')
      dirs[id] = {
        id,
        seedId: seedNode.id(),
        type: d.type,
        title: d.title,
        pool: d.pool,
        offset: 0,
        expanded: false,
        trackNodes: []
      }
      const n = cy.add({ group: 'nodes', data: { id, type: d.type, kind: 'dir' }, classes: 'dir' })
      cy.add({ group: 'edges', data: { id: uid('e'), source: seedNode.id(), target: id, type: d.type } })
      makeCard(n)
      return n
    })
    // start new nodes at the parent so the force layout fans them out smoothly
    const sp = seedNode.position()
    nodes.forEach((n) => n.position({ x: sp.x, y: sp.y }))
    if (nodes.length) runLayout()
    return nodes
  }

  function window5(d: DirModel): Candidate[] {
    const p = d.pool
    if (p.length <= 5) return p.slice()
    const o = d.offset % p.length
    const s = p.slice(o, o + 5)
    return s.length < 5 ? s.concat(p.slice(0, 5 - s.length)) : s
  }
  function clearTracks(d: DirModel): void {
    d.trackNodes.forEach((id) => {
      const n = cy.$id(id)
      if (!n.length || n.hasClass('seed')) return
      // A child may itself be an entity sub-branch (an artist) with its own tracks —
      // tear those down too and forget its DirModel.
      const sub = dirs[id]
      if (sub) {
        clearTracks(sub)
        delete dirs[id]
      }
      cy.remove(n)
    })
    d.trackNodes = []
  }
  function showTracks(dirNode: NodeSingular): void {
    const d = dirs[dirNode.id()]
    const seed = seeds[d.seedId]
    clearTracks(d)
    const nodes = window5(d).map((t) => {
      // An entity candidate (e.g. an artist on a label) becomes its own collapsible
      // sub-branch — registered in `dirs` so reveal / shuffle / window all recurse.
      if (t.entity) {
        const eid = uid('dir')
        dirs[eid] = {
          id: eid,
          seedId: d.seedId,
          type: d.type,
          title: t.artist || t.title || '—',
          pool: t.children ?? [],
          offset: 0,
          expanded: false,
          trackNodes: []
        }
        const en = cy.add({ group: 'nodes', data: { id: eid, type: d.type, kind: 'dir', entity: true } })
        cy.add({ group: 'edges', data: { id: uid('e'), source: dirNode.id(), target: eid, type: d.type } })
        makeCard(en)
        d.trackNodes.push(eid)
        return en
      }
      const id = uid('trk')
      const hyd = hydrate(t.artist, t.title)
      const key = hyd?.key ?? null
      const bpm = hyd?.bpm ?? null
      const n = cy.add({
        group: 'nodes',
        data: {
          id,
          label: t.title,
          artist: t.artist,
          kind: 'track',
          bpm,
          key,
          score: t.score,
          why: t.why,
          candidateKey: t.key,
          discogsId: t.discogs_id,
          year: t.year,
          owned: !!t.owned,
          dirId: dirNode.id(),
          dirType: d.type
        },
        classes:
          'track' +
          (camelotOk(seed.key, key) ? ' harmonic' : '') +
          (t.owned ? ' owned' : '')
      })
      cy.add({ group: 'edges', data: { id: uid('e'), source: dirNode.id(), target: id }, classes: 'tk' })
      makeCard(n)
      d.trackNodes.push(id)
      return n
    })
    const dp = dirNode.position()
    nodes.forEach((n) => n.position({ x: dp.x, y: dp.y }))
    if (nodes.length) runLayout()
    d.expanded = true
  }
  function shuffleDir(dirNode: NodeSingular): void {
    const d = dirs[dirNode.id()]
    d.offset = (d.offset + 5) % Math.max(d.pool.length, 5)
    showTracks(dirNode)
  }

  // DIG: track → seed + branches (enrich + discover live)
  async function dig(trackNode: NodeSingular): Promise<void> {
    if (seeds[trackNode.id()]) {
      select(trackNode)
      return
    }
    const t = trackNode.data()
    const parentSeed = seeds[dirSeed(cy.$id(t.dirId as string))]
    const artist = t.artist as string
    const title = t.label as string
    // promote visually right away
    seeds[trackNode.id()] = {
      id: trackNode.id(),
      artist,
      title,
      key: (t.key as string) ?? null,
      bpm: (t.bpm as number) ?? null,
      parentId: parentSeed.id,
      rootId: parentSeed.rootId,
      rootKey: parentSeed.rootKey,
      candidateKey: (t.candidateKey as string) ?? null,
      discogsId: (t.discogsId as number) ?? null,
      year: (t.year as number) ?? null,
      why: (t.why as string) ?? ''
    }
    const dm = dirs[t.dirId as string]
    if (dm) dm.trackNodes = dm.trackNodes.filter((x) => x !== trackNode.id())
    // Flip the node itself to a seed (not just the CSS class) so cardHtml and
    // select() treat it as a seed and addDirections can branch off it.
    trackNode.data('kind', 'seed')
    trackNode.removeClass('track harmonic').addClass('seed')
    refreshCard(trackNode)
    select(trackNode)

    // per-node loading state so it's obvious which card is enriching
    const card = cards.get(trackNode.id())
    card?.classList.add('digging')
    opts.onStatus?.(`digging — enriching "${title}"…`)
    try {
      const res = await opts.dig(artist, title, parentSeed.rootKey)
      if (res?.directions?.length) {
        addDirections(trackNode, res.directions)
        opts.onStatus?.(null)
      } else {
        opts.onStatus?.(`no branches — "${artist}" / "${title}" isn't on Discogs (try a credited track)`)
      }
    } catch {
      opts.onStatus?.('dig failed — Discogs rate limit or no match')
    } finally {
      card?.classList.remove('digging')
      setTimeout(() => opts.onStatus?.(null), 2600)
    }
  }

  // Remove a seed's direction branches and any promoted sub-seeds beneath them.
  function collapseChildren(seedNode: NodeSingular): void {
    seedNode.outgoers('node').forEach((dir) => {
      dir.outgoers('node').forEach((trk) => {
        if (seeds[trk.id()]) collapseChildren(trk)
        cy.remove(trk)
        delete seeds[trk.id()]
      })
      delete dirs[dir.id()]
      cy.remove(dir)
    })
  }
  function collapse(seedNode: NodeSingular): void {
    collapseChildren(seedNode)
    select(seedNode)
  }

  // PRUNE: undo a dig — drop the sub-seed's branches and revert it to a track
  // card under its parent direction. (The origin seed can't be pruned.)
  function prune(seedNode: NodeSingular): void {
    const s = seeds[seedNode.id()]
    if (!s || !s.parentId) {
      collapse(seedNode)
      opts.onStatus?.('origin can’t be pruned — collapsed its branches')
      setTimeout(() => opts.onStatus?.(null), 2000)
      return
    }
    collapseChildren(seedNode)
    runLayout()
    delete seeds[seedNode.id()]
    seedNode.data('kind', 'track')
    seedNode.removeClass('seed harmonic').addClass('track')
    const dirId = seedNode.data('dirId') as string | undefined
    if (dirId && dirs[dirId]) {
      if (!dirs[dirId].trackNodes.includes(seedNode.id())) dirs[dirId].trackNodes.push(seedNode.id())
      const parentSeed = seeds[dirs[dirId].seedId]
      if (parentSeed && camelotOk(parentSeed.key, seedNode.data('key') as string)) {
        seedNode.addClass('harmonic')
      }
      refreshCard(seedNode)
      // re-select the parent seed so the lineage line retracts cleanly
      const parentNode = cy.$id(dirs[dirId].seedId)
      if (parentNode.length) select(parentNode)
      else select(seedNode)
    } else {
      refreshCard(seedNode)
      select(seedNode)
    }
  }

  // ── lineage line + sine wave ─────────────────────────────────────────────
  let lineageEdges: EdgeCollection = cy.collection()
  let lineagePath: string[] = []
  let phase = 0
  function pathToRoot(node: NodeSingular): EdgeCollection {
    let edges: EdgeCollection = cy.collection()
    let cur: NodeSingular = node
    let g = 0
    while (g++ < 300) {
      const ein = cur.incomers('edge')
      if (ein.empty()) break
      const e = ein.first() as EdgeSingular
      edges = edges.union(e)
      cur = e.source()
    }
    return edges
  }
  function pathNodes(node: NodeSingular): string[] {
    const arr = [node.id()]
    let cur: NodeSingular = node
    let g = 0
    while (g++ < 300) {
      const ein = cur.incomers('edge')
      if (ein.empty()) break
      cur = (ein.first() as EdgeSingular).source()
      arr.push(cur.id())
    }
    return arr
  }
  function highlightLineage(node: NodeSingular): void {
    lineageEdges.removeClass('lineage')
    lineageEdges = pathToRoot(node)
    lineageEdges.addClass('lineage')
    lineagePath = pathNodes(node)
  }

  const wctx = wave.getContext('2d') as CanvasRenderingContext2D
  function sizeWave(): void {
    const r = host.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    wave.width = r.width * dpr
    wave.height = r.height * dpr
    wave.style.width = r.width + 'px'
    wave.style.height = r.height + 'px'
    wctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  function drawWave(): void {
    wctx.clearRect(0, 0, wave.width, wave.height)
    if (lineagePath.length < 2) return
    const pts = lineagePath
      .map((id) => cy.$id(id))
      .filter((n) => n.length)
      .map((n) => n.renderedPosition())
    if (pts.length < 2) return
    const seg: { a: { x: number; y: number }; dx: number; dy: number; len: number; d0: number }[] = []
    let L = 0
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x
      const dy = pts[i + 1].y - pts[i].y
      const len = Math.hypot(dx, dy) || 1
      seg.push({ a: pts[i], dx, dy, len, d0: L })
      L += len
    }
    if (L < 2) return
    const A = 6 // gentler amplitude
    const lambda = 46 // longer wavelength — calmer wave
    const stepd = 2 // finer sampling — smooth, not jagged
    // Collect points first, then render as a smoothed (quadratic) path.
    const pathPts: { x: number; y: number }[] = []
    for (let d = 0; d <= L; d += stepd) {
      let s = seg[seg.length - 1]
      for (const g of seg) {
        if (d <= g.d0 + g.len) {
          s = g
          break
        }
      }
      const tt = (d - s.d0) / s.len
      const bx = s.a.x + s.dx * tt
      const by = s.a.y + s.dy * tt
      const ux = s.dx / s.len
      const uy = s.dy / s.len
      const env = Math.sin(Math.PI * (d / L)) ** 1.3 // ease in/out at the ends
      const off = A * env * Math.sin((d / lambda) * Math.PI * 2 - phase)
      pathPts.push({ x: bx - uy * off, y: by + ux * off })
    }
    if (pathPts.length < 2) return
    wctx.beginPath()
    wctx.moveTo(pathPts[0].x, pathPts[0].y)
    for (let i = 1; i < pathPts.length - 1; i++) {
      const mx = (pathPts[i].x + pathPts[i + 1].x) / 2
      const my = (pathPts[i].y + pathPts[i + 1].y) / 2
      wctx.quadraticCurveTo(pathPts[i].x, pathPts[i].y, mx, my)
    }
    const last = pathPts[pathPts.length - 1]
    wctx.lineTo(last.x, last.y)
    const o = col('--orange')
    wctx.strokeStyle = o
    wctx.lineWidth = 1.6
    wctx.lineCap = 'round'
    wctx.lineJoin = 'round'
    wctx.shadowColor = o
    wctx.shadowBlur = 5
    wctx.globalAlpha = 0.9
    wctx.stroke()
    wctx.shadowBlur = 0
    wctx.globalAlpha = 1
  }

  // ── sync loop ──────────────────────────────────────────────────────────────
  let raf = 0
  function tick(): void {
    const z = Math.max(0.18, cy.zoom())
    for (const [id, el] of cards) {
      const n = cy.$id(id)
      if (!n.length) continue
      const p = n.renderedPosition()
      el.style.transform = `translate(${p.x}px,${p.y}px) translate(-50%,-50%) scale(${z})`
    }
    phase += 0.022
    drawWave()
    raf = requestAnimationFrame(tick)
  }

  // ── selection → React panel ────────────────────────────────────────────────
  let selId: string | null = null
  function select(node: NodeSingular): void {
    if (selId && cards.get(selId)) cards.get(selId)!.classList.remove('sel')
    selId = node.id()
    if (cards.get(selId)) cards.get(selId)!.classList.add('sel')
    highlightLineage(node)

    const k = node.data('kind') as 'seed' | 'dir' | 'track'
    const chain = (id: string): string[] => lineage(id).map((s) => s.title)

    if (k === 'seed') {
      const s = seeds[node.id()]
      onSelect({
        kind: 'seed',
        id: node.id(),
        title: s.title,
        artist: s.artist,
        bpm: s.bpm,
        key: s.key,
        year: s.year,
        why: s.parentId
          ? 'Promoted sub-seed — the pulsing line traces its lineage home to ORIGIN.'
          : 'Origin seed — the root of this net.',
        candidateKey: null,
        discogsId: s.discogsId,
        isOrigin: !s.parentId,
        lineage: chain(node.id())
      })
    } else if (k === 'dir') {
      const d = dirs[node.id()]
      const o = d.pool.length ? d.offset % d.pool.length : 0
      onSelect({
        kind: 'dir',
        id: node.id(),
        type: d.type,
        source: ROUTE_SOURCE[d.type],
        title: d.title,
        why: `${d.pool.length} tracks in this direction · showing up to 5.`,
        lineage: chain(d.seedId),
        dirWindow: { from: o + 1, to: Math.min(o + 5, d.pool.length), total: d.pool.length }
      })
    } else {
      const harm = node.hasClass('harmonic')
      const dirType = node.data('dirType') as RouteType | undefined
      onSelect({
        kind: 'track',
        id: node.id(),
        type: dirType,
        source: dirType ? ROUTE_SOURCE[dirType] : undefined,
        title: node.data('label'),
        artist: node.data('artist'),
        bpm: node.data('bpm'),
        key: node.data('key'),
        score: node.data('score'),
        year: node.data('year'),
        why: node.data('why'),
        candidateKey: node.data('candidateKey'),
        discogsId: node.data('discogsId'),
        isHarmonic: harm,
        lineage: chain(dirSeed(cy.$id(node.data('dirId') as string)))
      })
    }
  }

  function selectByCandidateKey(key: string): void {
    for (const el of cards.values()) {
      const id = el.dataset.id
      if (!id) continue
      const n = cy.$id(id)
      if (n.length && n.data('candidateKey') === key) {
        select(n)
        cy.animate({ fit: { eles: n as never, padding: 220 }, duration: 320, easing: 'ease-out-cubic' })
        return
      }
    }
  }

  // ── boot ─────────────────────────────────────────────────────────────────
  const meta = opts.seedMeta ?? hydrate(opts.result.seed.artist, opts.result.seed.title)
  const rootNode = addSeed(
    {
      artist: opts.result.seed.artist,
      title: opts.result.seed.title,
      key: meta?.key ?? null,
      bpm: meta?.bpm ?? null,
      candidateKey: opts.result.seed.key,
      year: opts.result.seed.year
    },
    null,
    opts.result.seed.rootSeedKey
  )
  rootNode.position({ x: CX, y: CY })
  addDirections(rootNode, opts.result.directions)
  select(rootNode)
  sizeWave()
  tick()

  const ro = new ResizeObserver(() => sizeWave())
  ro.observe(host)

  return {
    fit: frame,
    reset: () => {
      // collapse everything back to the origin
      const root = cy.$id(rootNode.id())
      if (root.length) {
        collapse(root)
        addDirections(root, opts.result.directions)
        select(root)
      }
    },
    selectByCandidateKey,
    setMeta: (id, meta) => {
      const n = cy.$id(id)
      if (!n.length) return
      if (meta.bpm != null) n.data('bpm', meta.bpm)
      if (meta.key != null) {
        n.data('key', meta.key)
        const dirId = n.data('dirId') as string | undefined
        const dirNode = dirId ? cy.$id(dirId) : null
        const seedKey = dirNode && dirNode.length ? seeds[dirs[dirId!]?.seedId]?.key : null
        if (camelotOk(seedKey, meta.key)) n.addClass('harmonic')
      }
      refreshCard(n)
    },
    addBranch: (seedId, label, picks) => {
      let seedNode = seedId ? cy.$id(seedId) : null
      if (!seedNode || !seedNode.length) seedNode = originId ? cy.$id(originId) : null
      if (!seedNode || !seedNode.length) return
      const seen = new Set<string>()
      const pool: Candidate[] = []
      for (const p of picks) {
        const artist = (p.artist || '').trim()
        const title = (p.title || '').trim()
        if (!artist && !title) continue
        const key = `ai ${artist} ${title}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        if (seen.has(key)) continue
        seen.add(key)
        pool.push({
          key,
          artist,
          title,
          label: null,
          year: null,
          discogs_id: null,
          why: p.why || `AI pick related to ${seeds[seedNode!.id()]?.title ?? 'your seed'}`,
          score: 72
        })
      }
      if (!pool.length) return
      const [dirNode] = addDirections(seedNode, [
        { id: 'aibranch:' + uid('d'), type: 'ai', title: label, pool }
      ])
      if (dirNode) {
        showTracks(dirNode)
        select(dirNode)
      }
    },
    destroy: () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      try {
        audio.pause()
      } catch {
        /* ignore */
      }
      cy.destroy()
      cards.clear()
      host.innerHTML = ''
    }
  }
}
