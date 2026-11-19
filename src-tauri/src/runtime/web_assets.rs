pub struct WebAsset {
    pub bytes: Vec<u8>,
    pub mime_type: String,
}

pub trait WebAssets: Send + Sync {
    fn get(&self, path: &str) -> Option<WebAsset>;
}
