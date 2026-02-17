use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeaderEntry {
    pub name: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowRecord {
    pub id: String,
    pub started: f64,
    pub ended: f64,
    pub duration_ms: i64,
    pub method: String,
    pub url: String,
    pub host: String,
    pub path: String,
    pub scheme: String,
    pub status_code: i32,
    pub request_headers: Vec<HeaderEntry>,
    pub response_headers: Option<Vec<HeaderEntry>>,
    pub request_body_size: i64,
    pub response_body_size: i64,
    pub request_body: String,
    pub response_body: String,
    pub request_body_truncated: bool,
    pub response_body_truncated: bool,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyStatus {
    Starting,
    Running,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProxyEvent {
    #[serde(rename = "status")]
    Status {
        status: ProxyStatus,
        message: Option<String>,
        port: Option<u16>,
    },
    #[serde(rename = "error")]
    Error { message: String },
    #[serde(rename = "flow")]
    Flow { record: FlowRecord },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ProxyCommand {
    #[serde(rename = "start")]
    Start { port: u16 },
    #[serde(rename = "stop")]
    Stop,
    #[serde(rename = "pause")]
    Pause,
    #[serde(rename = "resume")]
    Resume,
}
