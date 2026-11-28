//! One short-lived connection: hello, then requests answered in order.

use std::time::Duration;

use pilo_ipc::{
    ClientHello, Endpoint, FrameError, HELLO_TIMEOUT, HostHello, PROTOCOL_VERSION, read_frame,
    write_frame,
};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};

use crate::{contract::Method, error::CliError};

trait Stream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Stream for T {}

pub struct Client {
    stream: Box<dyn Stream>,
    timeout: Duration,
    next_id: u64,
    hello: HostHello,
}

impl Client {
    pub async fn connect(endpoint: &Endpoint, timeout: Duration) -> Result<Self, CliError> {
        Self::connect_within(endpoint, timeout, HELLO_TIMEOUT).await
    }

    /// Connects and finishes the hello within `hello_timeout` in total.
    pub async fn connect_within(
        endpoint: &Endpoint,
        timeout: Duration,
        hello_timeout: Duration,
    ) -> Result<Self, CliError> {
        tokio::time::timeout(hello_timeout, Self::open(endpoint, timeout))
            .await
            .map_err(|_| {
                CliError::offline(format!(
                    "Pilo did not answer the hello within {} ms",
                    hello_timeout.as_millis()
                ))
            })?
    }

    async fn open(endpoint: &Endpoint, timeout: Duration) -> Result<Self, CliError> {
        let offline = |error: std::io::Error| {
            CliError::offline(format!(
                "Pilo is not running or not reachable at {endpoint} ({error}); run `pilo open` or pass --launch"
            ))
        };
        let stream: Box<dyn Stream> = match endpoint {
            #[cfg(unix)]
            Endpoint::Unix(unix) => Box::new(
                tokio::net::UnixStream::connect(&unix.path)
                    .await
                    .map_err(offline)?,
            ),
            #[cfg(windows)]
            Endpoint::NamedPipe(name) => Box::new(
                tokio::net::windows::named_pipe::ClientOptions::new()
                    .open(name)
                    .map_err(offline)?,
            ),
            #[allow(unreachable_patterns)]
            _ => {
                return Err(CliError::offline(format!(
                    "unsupported endpoint {endpoint}"
                )));
            }
        };
        Self::handshake(stream, timeout).await
    }

    async fn handshake(mut stream: Box<dyn Stream>, timeout: Duration) -> Result<Self, CliError> {
        let hello = ClientHello {
            protocol: PROTOCOL_VERSION.to_owned(),
            client: "pilo-cli".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
        };
        let reply = tokio::time::timeout(HELLO_TIMEOUT, async {
            write_frame(&mut stream, &hello).await?;
            read_frame(&mut stream).await
        })
        .await
        .map_err(|_| CliError::offline("Pilo did not answer the hello within 5 seconds"))?
        .map_err(|error| CliError::offline(format!("hello failed: {error}")))?
        .ok_or_else(|| CliError::offline("Pilo closed the connection during hello"))?;
        if let Some(error) = reply.get("error") {
            return Err(CliError::from_host(error, false));
        }
        let hello: HostHello = serde_json::from_value(reply)
            .map_err(|error| CliError::incompatible(format!("unexpected hello reply: {error}")))?;
        if !pilo_ipc::protocol_compatible(PROTOCOL_VERSION, &hello.protocol) {
            return Err(CliError::incompatible(format!(
                "Pilo speaks protocol {}, this CLI speaks {PROTOCOL_VERSION}; update Pilo or the CLI",
                hello.protocol
            )));
        }
        Ok(Self {
            stream,
            timeout,
            next_id: 1,
            hello,
        })
    }

    pub fn hello(&self) -> &HostHello {
        &self.hello
    }

    /// Sends one request. A failure after a write was sent is reported as an
    /// unknown outcome and never retried.
    pub async fn call(
        &mut self,
        method: &Method,
        fields: &[(&str, Value)],
        write: bool,
    ) -> Result<Value, CliError> {
        let params = method.params(fields).map_err(CliError::internal)?;
        let id = self.next_id;
        self.next_id += 1;
        let request = json!({"id": id, "method": method.name, "params": params});
        let lost = |reason: String| {
            if write {
                CliError::outcome_unknown(format!(
                    "{reason}; the {} request may or may not have been applied; query the state instead of retrying",
                    method.name
                ))
            } else {
                CliError::offline(reason)
            }
        };
        // `--timeout` covers writing the request as well as waiting for the reply.
        let stream = &mut self.stream;
        let exchange = async move {
            write_frame(stream, &request)
                .await
                .map_err(|error| (false, error))?;
            read_frame(stream).await.map_err(|error| (true, error))
        };
        let response = match tokio::time::timeout(self.timeout, exchange).await {
            Err(_) => {
                return Err(lost(format!(
                    "no reply within {} seconds",
                    self.timeout.as_secs_f64()
                )));
            }
            Ok(Err((false, error @ FrameError::TooLarge(_)))) => {
                return Err(CliError::invalid(error.to_string()));
            }
            // An incomplete request frame cannot be decoded, so the Host did not act on it.
            Ok(Err((false, error))) => {
                return Err(CliError::offline(format!(
                    "connection to Pilo failed: {error}"
                )));
            }
            Ok(Err((true, error))) => {
                return Err(lost(format!("connection to Pilo failed: {error}")));
            }
            Ok(Ok(None)) => return Err(lost("Pilo closed the connection".to_owned())),
            Ok(Ok(Some(response))) => response,
        };
        if response.get("id") != Some(&json!(id)) {
            if let Some(error) = response.get("error") {
                return Err(CliError::from_host(error, write));
            }
            return Err(lost("Pilo answered a different request".to_owned()));
        }
        match (response.get("result"), response.get("error")) {
            (_, Some(error)) => Err(CliError::from_host(error, write)),
            (Some(result), None) => Ok(result.clone()),
            (None, None) => Err(lost("Pilo sent an empty reply".to_owned())),
        }
    }
}
