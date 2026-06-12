// build.rs — napi-rs entry-point glue + the Signalsmith Stretch C++ wrapper.
extern crate napi_build;

fn main() {
    napi_build::setup();

    // Compile the vendored Signalsmith Stretch (header-only C++, MIT) into the
    // addon via a small C-ABI wrapper. Self-contained: no system library to
    // install. The FFT falls back to a portable built-in implementation unless a
    // platform backend is enabled below.
    let mut build = cc::Build::new();
    build
        .cpp(true)
        .std("c++17")
        .include("vendor")
        .file("src/signalsmith_wrapper.cpp")
        .flag_if_supported("-O3")
        .flag_if_supported("-ffast-math");

    // On macOS use Apple's Accelerate framework for the FFT — free (always
    // present), and much faster than the portable fallback in the audio callback.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        build.define("SIGNALSMITH_USE_ACCELERATE", None);
        println!("cargo:rustc-link-lib=framework=Accelerate");
    }

    build.compile("signalsmith_wrapper");

    println!("cargo:rerun-if-changed=src/signalsmith_wrapper.cpp");
    println!("cargo:rerun-if-changed=vendor/signalsmith-stretch.h");
    println!("cargo:rerun-if-changed=vendor/signalsmith-linear/fft.h");
}
