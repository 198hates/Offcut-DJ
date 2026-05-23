// build.rs — napi-rs requires this to generate the .node entry-point glue.
extern crate napi_build;

fn main() {
    napi_build::setup();
}
