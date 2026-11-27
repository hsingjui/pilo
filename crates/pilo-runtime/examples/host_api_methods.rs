fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&pilo_runtime::host_api::method_table_json())
            .expect("serialize host api method table")
    );
}
