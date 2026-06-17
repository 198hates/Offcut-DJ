// Offcut mobile.
// Slice 1: pairing + connection. Slice 2: browse the synced library, render
// waveforms from /media/peaks, audition via the AAC proxy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View
} from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { CameraView, useCameraPermissions } from 'expo-camera'
import {
  clearConnection,
  loadConnection,
  parseManual,
  parsePairingUri,
  saveConnection,
  type Connection
} from './src/pairing'
import { SyncClient, type HealthInfo } from './src/syncClient'
import { useLibrary } from './src/useLibrary'
import { useOutbox } from './src/useOutbox'
import { usePlaylistActions } from './src/usePlaylists'
import { LibraryScreen } from './src/LibraryScreen'
import { TrackScreen } from './src/TrackScreen'
import { PlaylistScreen } from './src/PlaylistScreen'
import type { Playlist, Track } from './src/sync-types'

type Phase = 'loading' | 'unpaired' | 'connecting' | 'connected' | 'error'

export default function App(): JSX.Element {
  const [phase, setPhase] = useState<Phase>('loading')
  const [conn, setConn] = useState<Connection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const [manual, setManual] = useState('')
  const [permission, requestPermission] = useCameraPermissions()
  const handledScan = useRef(false)

  const connect = useCallback(async (c: Connection): Promise<void> => {
    setPhase('connecting')
    setError(null)
    try {
      const health: HealthInfo = await new SyncClient(c).health()
      if (!health.ok) throw new Error('desktop reported not-ok')
      await saveConnection(c)
      setConn(c)
      setPhase('connected')
    } catch (e) {
      setError(`Can't reach ${c.host}:${c.port} — ${(e as Error).message}`)
      setPhase('error')
    }
  }, [])

  useEffect(() => {
    void (async () => {
      const saved = await loadConnection()
      if (saved) await connect(saved)
      else setPhase('unpaired')
    })()
  }, [connect])

  const onScanned = useCallback(
    (data: string): void => {
      if (handledScan.current) return
      const c = parsePairingUri(data)
      if (!c) return
      handledScan.current = true
      setScanning(false)
      void connect(c)
    },
    [connect]
  )

  const startScan = useCallback(async (): Promise<void> => {
    if (!permission?.granted) {
      const res = await requestPermission()
      if (!res.granted) {
        setError('Camera permission is needed to scan the pairing QR.')
        return
      }
    }
    handledScan.current = false
    setError(null)
    setScanning(true)
  }, [permission, requestPermission])

  const submitManual = useCallback((): void => {
    const c = parsePairingUri(manual) ?? parseManual(manual)
    if (!c) {
      setError('Paste the offcut://pair/… URI, or "host:port token".')
      return
    }
    void connect(c)
  }, [manual, connect])

  const disconnect = useCallback(async (): Promise<void> => {
    await clearConnection()
    setConn(null)
    setManual('')
    setPhase('unpaired')
  }, [])

  // Connected → the library lives in its own component so its hooks (pull,
  // audio player) mount only once we actually have a connection.
  if (phase === 'connected' && conn) {
    return <ConnectedApp conn={conn} onDisconnect={disconnect} />
  }

  if (scanning) {
    return (
      <View style={styles.fill}>
        <StatusBar style="light" />
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => onScanned(data)}
        />
        <View style={styles.scanOverlay}>
          <Text style={styles.scanHint}>Point at the QR in Settings → Phone Sync</Text>
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={() => setScanning(false)}>
            <Text style={styles.btnGhostText}>Cancel</Text>
          </Pressable>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.fill, styles.center]}>
      <StatusBar style="light" />
      <Text style={styles.brand}>OFFCUT</Text>

      {(phase === 'loading' || phase === 'connecting') && (
        <>
          <ActivityIndicator color="#D86A4A" />
          {phase === 'connecting' && <Text style={styles.muted}>Connecting…</Text>}
        </>
      )}

      {(phase === 'unpaired' || phase === 'error') && (
        <>
          <Text style={styles.muted}>Pair with the Offcut desktop app</Text>
          <Pressable style={styles.btn} onPress={startScan}>
            <Text style={styles.btnText}>Scan pairing QR</Text>
          </Pressable>
          <Text style={styles.or}>or paste manually</Text>
          <TextInput
            style={styles.input}
            placeholder="offcut://pair/…  or  host:port token"
            placeholderTextColor="#7a7264"
            autoCapitalize="none"
            autoCorrect={false}
            value={manual}
            onChangeText={setManual}
            onSubmitEditing={submitManual}
          />
          <Pressable style={[styles.btn, styles.btnGhost]} onPress={submitManual}>
            <Text style={styles.btnGhostText}>Connect</Text>
          </Pressable>
          {error && <Text style={styles.error}>{error}</Text>}
        </>
      )}
    </View>
  )
}

function ConnectedApp({ conn, onDisconnect }: { conn: Connection; onDisconnect: () => void }): JSX.Element {
  const client = useMemo(() => new SyncClient(conn), [conn])
  const lib = useLibrary(client)
  // a rotated token → re-pair; after a reconnect-flush, re-pull to reconcile.
  const outbox = useOutbox(client, onDisconnect, lib.refresh)
  const actions = usePlaylistActions(outbox.push, lib)
  const [selected, setSelected] = useState<Track | null>(null)
  const [managing, setManaging] = useState<string | null>(null)

  if (managing) {
    return (
      <PlaylistScreen
        playlistId={managing}
        lib={lib}
        actions={actions}
        onBack={() => setManaging(null)}
        onSelectTrack={setSelected}
      />
    )
  }
  if (selected) {
    return (
      <TrackScreen
        track={selected}
        client={client}
        push={outbox.push}
        onBack={() => setSelected(null)}
        onPatched={lib.patchTrack}
        playlists={lib.playlists}
        onAddToPlaylist={actions.addTrack}
      />
    )
  }
  return (
    <LibraryScreen
      lib={lib}
      onSelectTrack={setSelected}
      onDisconnect={onDisconnect}
      onCreatePlaylist={(name) => {
        void actions.create(name)
      }}
      onManagePlaylist={(p: Playlist) => setManaging(p.id)}
      online={outbox.online}
      pending={outbox.pending}
      flushing={outbox.flushing}
      onSync={() => void outbox.flush()}
    />
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#17150f' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  brand: { color: '#ECE3CC', fontSize: 28, fontWeight: '800', letterSpacing: 6, marginBottom: 8 },
  muted: { color: '#a59a82', fontSize: 14 },
  or: { color: '#7a7264', fontSize: 12, marginTop: 8 },
  input: {
    width: '100%',
    borderWidth: 1,
    borderColor: '#3a352b',
    borderRadius: 8,
    color: '#ECE3CC',
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14
  },
  btn: { backgroundColor: '#D86A4A', borderRadius: 8, paddingHorizontal: 20, paddingVertical: 12 },
  btnText: { color: '#17150f', fontSize: 15, fontWeight: '700' },
  btnGhost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#3a352b' },
  btnGhostText: { color: '#ECE3CC', fontSize: 14, fontWeight: '600' },
  error: { color: '#e0726f', fontSize: 13, textAlign: 'center', marginTop: 8 },
  scanOverlay: { position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center', gap: 16 },
  scanHint: { color: '#fff', fontSize: 14, backgroundColor: '#0008', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6 }
})
