fn main() {
    // The default instance is fixed at build time; see `app_id` in src/main.rs.
    println!("cargo:rerun-if-env-changed=PILO_CLI_APP_ID");
}
