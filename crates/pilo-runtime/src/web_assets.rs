pub struct WebAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub trait WebAssets: Send + Sync {
    fn get(&self, path: &str) -> Option<WebAsset>;

    /// Returns a precompressed sidecar with the MIME type of the original asset.
    fn get_precompressed(&self, _path: &str, _extension: &str) -> Option<WebAsset> {
        None
    }
}
