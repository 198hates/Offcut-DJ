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
import { useFonts, JetBrainsMono_400Regular, JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono'
import { NavigationContainer, type Theme } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
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
import { PlaylistsScreen } from './src/PlaylistsScreen'
import { SyncScreen } from './src/SyncScreen'
import { TrackScreen } from './src/TrackScreen'
import { PlaylistScreen } from './src/PlaylistScreen'
import { C, MONO, MONO_BOLD } from './src/theme'
import { patchAsTrackFields, type BatchFields } from './src/edits'
import type { Track, TrackPatch } from './src/sync-types'

type RootStackParamList = {
  Main: undefined
  Track: { track: Track }
  Playlist: { id: string }
}

const RootStack = createNativeStackNavigator<RootStackParamList>()
const Tabs = createBottomTabNavigator()

// React Navigation theme bound to the Offcut palette so screen backgrounds,
// headers and the card transitions all read as the same dark product.
const NavTheme: Theme = {
  dark: true,
  colors: {
    primary: C.accent,
    background: C.bg,
    card: C.panel,
    text: C.ink,
    border: C.border,
    notification: C.accent
  },
  fonts: {
    regular: { fontFamily: MONO, fontWeight: '400' },
    medium: { fontFamily: MONO, fontWeight: '400' },
    bold: { fontFamily: MONO_BOLD, fontWeight: '700' },
    heavy: { fontFamily: MONO_BOLD, fontWeight: '700' }
  }
}

type Phase = 'loading' | 'unpaired' | 'connecting' | 'connected' | 'error'

export default function App(): JSX.Element {
  const [fontsLoaded] = useFonts({ JetBrainsMono_400Regular, JetBrainsMono_700Bold })
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

  // Hold the first paint until the mono font is ready, so nothing flashes in a
  // fallback typeface.
  if (!fontsLoaded) {
    return (
      <View style={[styles.fill, styles.center]}>
        <StatusBar style="light" />
        <ActivityIndicator color="#D86A4A" />
      </View>
    )
  }

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

  // Apply one field across a multi-track selection in a single push.
  const applyBatch = (ids: string[], fields: BatchFields): void => {
    const nowIso = new Date().toISOString()
    const patches: TrackPatch[] = []
    for (const id of ids) {
      const t = lib.byId.get(id)
      if (!t) continue
      const patch: TrackPatch = { id, updatedAt: nowIso }
      if (fields.rating !== undefined) patch.rating = fields.rating
      if (fields.energy !== undefined) patch.energy = fields.energy
      if (fields.mood !== undefined) patch.mood = fields.mood
      if (fields.color !== undefined) patch.color = fields.color
      if (fields.addTag) patch.tags = Array.from(new Set([...(t.tags ?? []), fields.addTag]))
      patches.push(patch)
      lib.patchTrack(id, patchAsTrackFields(patch)) // optimistic
    }
    if (patches.length) void outbox.push({ tracks: patches })
  }

  // The bottom-tab section, inlined as a render-prop (not `component={...}`) so it
  // re-renders with fresh lib/outbox/actions without remounting the navigator.
  const renderTabs = (): JSX.Element => (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: C.panel, borderTopColor: C.border },
        tabBarActiveTintColor: C.accent,
        tabBarInactiveTintColor: C.muted,
        tabBarLabelStyle: { fontFamily: MONO, fontSize: 10, letterSpacing: 0.5 }
      }}
    >
      <Tabs.Screen
        name="Library"
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="musical-notes" color={color} size={size} /> }}
      >
        {({ navigation }) => (
          <LibraryScreen
            lib={lib}
            artworkUrl={(id) => client.artworkUrl(id)}
            onSelectTrack={(t) => navigation.navigate('Track', { track: t })}
            onBatchEdit={applyBatch}
          />
        )}
      </Tabs.Screen>
      <Tabs.Screen
        name="Playlists"
        options={{ tabBarIcon: ({ color, size }) => <Ionicons name="list" color={color} size={size} /> }}
      >
        {({ navigation }) => (
          <PlaylistsScreen lib={lib} actions={actions} onOpenPlaylist={(p) => navigation.navigate('Playlist', { id: p.id })} />
        )}
      </Tabs.Screen>
      <Tabs.Screen
        name="Sync"
        options={{
          tabBarIcon: ({ color, size }) => <Ionicons name="sync" color={color} size={size} />,
          tabBarBadge: outbox.pending > 0 ? outbox.pending : undefined
        }}
      >
        {() => <SyncScreen lib={lib} outbox={outbox} onDisconnect={onDisconnect} />}
      </Tabs.Screen>
    </Tabs.Navigator>
  )

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={NavTheme}>
        <RootStack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: C.panel },
            headerTintColor: C.ink,
            headerTitleStyle: { fontFamily: MONO_BOLD, fontSize: 15 },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: C.bg }
          }}
        >
          <RootStack.Screen name="Main" options={{ headerShown: false }}>
            {renderTabs}
          </RootStack.Screen>
          <RootStack.Screen
            name="Track"
            options={({ route }) => ({ title: route.params.track.title || 'Track', headerBackTitle: '' })}
          >
            {({ route }) => (
              <TrackScreen
                track={route.params.track}
                client={client}
                push={outbox.push}
                onPatched={lib.patchTrack}
                playlists={lib.playlists}
                onAddToPlaylist={actions.addTrack}
              />
            )}
          </RootStack.Screen>
          <RootStack.Screen name="Playlist" options={{ title: 'Playlist', headerBackTitle: '' }}>
            {({ navigation, route }) => (
              <PlaylistScreen
                playlistId={route.params.id}
                lib={lib}
                actions={actions}
                onBack={navigation.goBack}
                onSelectTrack={(t) => navigation.navigate('Track', { track: t })}
              />
            )}
          </RootStack.Screen>
        </RootStack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
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
