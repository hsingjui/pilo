use std::collections::HashSet;

use pilo_domain::{RemoteAccessAddress, RemoteAccessConfig};

pub(crate) fn normalize_base_url(input: &str) -> Result<String, String> {
    let input = input.trim();
    if input.len() > 2048 {
        return Err("Remote access URL is too long".to_owned());
    }
    let url = url::Url::parse(input)
        .map_err(|_| "Remote access URL must be an http:// or https:// root address".to_owned())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(
            "Remote access URL must be an http:// or https:// root address without credentials, query or fragment"
                .to_owned(),
        );
    }
    Ok(url.origin().ascii_serialization())
}

pub(crate) fn normalize_config(
    mut config: RemoteAccessConfig,
) -> Result<RemoteAccessConfig, String> {
    if config.addresses.is_empty() || config.addresses.len() > 32 {
        return Err("Remote WebUI requires between 1 and 32 addresses".to_owned());
    }
    let mut ids = HashSet::new();
    let mut urls = HashSet::new();
    for address in &mut config.addresses {
        if address.id.is_empty()
            || address.id.len() > 80
            || !address
                .id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || !ids.insert(address.id.clone())
        {
            return Err("Remote access address IDs must be unique".to_owned());
        }
        address.name = address.name.trim().to_owned();
        if address.name.chars().count() > 80 {
            return Err("Remote access address names must not exceed 80 characters".to_owned());
        }
        address.base_url = normalize_base_url(&address.base_url)?;
        if !urls.insert(address.base_url.clone()) {
            return Err("Remote access addresses must have different origins".to_owned());
        }
    }
    if !ids.contains(&config.entry_address_id) {
        return Err("QR entry must be one of the configured addresses".to_owned());
    }
    Ok(config)
}

pub(crate) fn default_config(
    lan_base_url: &str,
    public_base_url: &str,
    entry_address_id: &str,
) -> RemoteAccessConfig {
    let mut addresses = vec![RemoteAccessAddress {
        id: "lan".to_owned(),
        name: String::new(),
        base_url: lan_base_url.to_owned(),
    }];
    let public_base_url = public_base_url.trim().trim_end_matches('/');
    if !public_base_url.is_empty() {
        let normalized =
            normalize_base_url(public_base_url).unwrap_or_else(|_| public_base_url.to_owned());
        if normalized != lan_base_url {
            addresses.push(RemoteAccessAddress {
                id: "public".to_owned(),
                name: String::new(),
                base_url: normalized,
            });
        }
    }
    let entry_address_id = if addresses
        .iter()
        .any(|address| address.id == entry_address_id)
    {
        entry_address_id
    } else {
        "lan"
    };
    RemoteAccessConfig {
        addresses,
        entry_address_id: entry_address_id.to_owned(),
    }
}

// Legacy invalid URLs remain editable, but never receive a pairing credential.
pub(crate) fn pairing_addresses(config: &RemoteAccessConfig) -> Vec<RemoteAccessAddress> {
    config
        .addresses
        .iter()
        .filter_map(|address| {
            normalize_base_url(&address.base_url)
                .ok()
                .map(|base_url| RemoteAccessAddress {
                    base_url,
                    ..address.clone()
                })
        })
        .collect()
}

pub(crate) fn targets_changed(before: &RemoteAccessConfig, after: &RemoteAccessConfig) -> bool {
    before.addresses.len() != after.addresses.len()
        || before
            .addresses
            .iter()
            .zip(&after.addresses)
            .any(|(before, after)| before.id != after.id || before.base_url != after.base_url)
}
