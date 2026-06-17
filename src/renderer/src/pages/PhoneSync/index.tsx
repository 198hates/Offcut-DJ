import { PageHeader } from '../../components/PageHeader'
import { PhoneSyncPanel } from '../../components/PhoneSyncPanel'

export function PhoneSyncPage(): JSX.Element {
  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <PageHeader
        marker="▢"
        title="phone sync"
        subtitle="browse, audition, prep & edit your library from the Offcut mobile app over Wi-Fi"
      />

      <div className="px-5 py-5 max-w-3xl space-y-6">
        <PhoneSyncPanel />
      </div>
    </div>
  )
}
