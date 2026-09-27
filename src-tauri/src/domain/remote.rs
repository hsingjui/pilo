use serde::{Deserialize, Serialize};

/// 随机默认端口的取值区间(五位数端口:10000..=65535)。
const RANDOM_PORT_SPAN: u16 = 65_535 - 10_000 + 1;

/// 首次启用远程连接时随机分配一个五位数端口;后续修改由 `set_remote_host_config` 持久化。
pub fn random_remote_port() -> u16 {
    let mut bytes = [0_u8; 2];
    if getrandom::fill(&mut bytes).is_err() {
        // ponytail: getrandom 失败时退回固定端口,足够罕见,无需向上传播错误
        return 47_653;
    }
    10_000 + u16::from_ne_bytes(bytes) % RANDOM_PORT_SPAN
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteHostConfig {
    pub enabled: bool,
    pub port: u16,
    /// 内网穿透等外部访问地址(如 https://example.com);为空时回退到局域网 IP。
    pub public_base_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    /// 配对请求的来源 IP;旧记录为空字符串。
    pub pair_ip: String,
    pub created_at_ms: u64,
    pub last_seen_at_ms: u64,
    pub expires_at_ms: u64,
    pub revoked_at_ms: Option<u64>,
}
