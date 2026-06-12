// C-ABI wrapper around Signalsmith Stretch (vendored, MIT) so the Rust engine
// can drive it over FFI. Compiled into the addon by build.rs via the `cc` crate
// — no system library, no install. Planar (per-channel) float buffers.
//
// For keylock we only time-stretch (transpose = 0 semitones); the tempo ratio is
// expressed as the input/output sample count given to process().

#include "signalsmith-stretch.h"

using Stretch = signalsmith::stretch::SignalsmithStretch<float>;

extern "C" {

void *sms_create() {
    return new Stretch();
}

void sms_destroy(void *p) {
    delete static_cast<Stretch *>(p);
}

// Configure for `channels` at `sample_rate`, pitch-preserving (no transpose).
void sms_preset_default(void *p, int channels, float sample_rate) {
    auto *s = static_cast<Stretch *>(p);
    s->presetDefault(channels, sample_rate);
    s->setTransposeSemitones(0.0f);
}

void sms_reset(void *p) {
    static_cast<Stretch *>(p)->reset();
}

int sms_output_latency(void *p) {
    return static_cast<Stretch *>(p)->outputLatency();
}

// Time-stretch `in_samples` input frames into `out_samples` output frames
// (ratio in/out = tempo). `inputs`/`outputs` are arrays of per-channel pointers.
void sms_process(void *p,
                 const float *const *inputs, int in_samples,
                 float *const *outputs, int out_samples) {
    static_cast<Stretch *>(p)->process(inputs, in_samples, outputs, out_samples);
}

// Prime internal buffers from `in_samples` of input at the given playback rate
// (used on engage / after a seek to avoid a silent ramp-in).
void sms_seek(void *p, const float *const *inputs, int in_samples, double playback_rate) {
    static_cast<Stretch *>(p)->seek(inputs, in_samples, playback_rate);
}

} // extern "C"
