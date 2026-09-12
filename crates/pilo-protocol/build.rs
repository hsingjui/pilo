fn main() {
    println!("cargo:rerun-if-changed=proto/pilo.proto");
    let protoc = protoc_bin_vendored::protoc_bin_path().expect("failed to locate vendored protoc");
    let mut config = prost_build::Config::new();
    config.protoc_executable(protoc);
    config
        .compile_protos(&["proto/pilo.proto"], &["proto"])
        .expect("failed to compile pilo protocol protobuf schema");
}
