use crate::{ApiError, Shared};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
};
use futures_util::TryStreamExt;
use std::{sync::OnceLock, time::Duration};

const DEFAULT_ACP_UPSTREAM_BASE: &str = "http://127.0.0.1:8048";

static ACP_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    ACP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("failed to build ACP proxy reqwest client")
    })
}

fn upstream_base() -> String {
    std::env::var("ACP_UPSTREAM_BASE")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_owned())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_ACP_UPSTREAM_BASE.to_owned())
}

fn is_hop_by_hop_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn should_strip_request_header(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    matches!(lower.as_str(), "host" | "cookie" | "x-console-path") || is_hop_by_hop_header(&lower)
}

fn build_target_url(base: &str, req: &Request) -> String {
    let path_and_query = req
        .uri()
        .path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or_else(|| req.uri().path());
    let stripped = path_and_query
        .strip_prefix("/acp-api")
        .unwrap_or(path_and_query);
    if stripped.is_empty() {
        format!("{base}/")
    } else if stripped.starts_with('?') {
        format!("{base}/{stripped}")
    } else {
        format!("{base}{stripped}")
    }
}

fn forward_request_headers(headers: &HeaderMap) -> reqwest::header::HeaderMap {
    let mut out = reqwest::header::HeaderMap::new();
    for (name, value) in headers {
        if should_strip_request_header(name.as_str()) {
            continue;
        }
        if let (Ok(req_name), Ok(req_val)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(req_name, req_val);
        }
    }
    out
}

pub async fn handle(State(state): State<Shared>, req: Request) -> Result<Response, ApiError> {
    crate::api::auth(&state, req.headers())?;

    let target_url = build_target_url(&upstream_base(), &req);
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);
    let headers = forward_request_headers(req.headers());

    let mut builder = client().request(method, &target_url).headers(headers);
    if *req.method() != Method::GET && *req.method() != Method::HEAD {
        let stream = req
            .into_body()
            .into_data_stream()
            .map_err(std::io::Error::other);
        builder = builder.body(reqwest::Body::wrap_stream(stream));
    }

    let upstream_resp = builder.send().await.map_err(|err| {
        ApiError(
            StatusCode::BAD_GATEWAY,
            format!("8048 ACP gateway unreachable: {err}"),
        )
    })?;

    let status = StatusCode::from_u16(upstream_resp.status().as_u16())
        .unwrap_or(StatusCode::BAD_GATEWAY);
    let mut resp_headers = HeaderMap::new();
    for (name, value) in upstream_resp.headers() {
        if is_hop_by_hop_header(name.as_str()) {
            continue;
        }
        if let (Ok(axum_name), Ok(axum_val)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            resp_headers.append(axum_name, axum_val);
        }
    }

    let body = Body::from_stream(upstream_resp.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = resp_headers;
    Ok(response)
}
